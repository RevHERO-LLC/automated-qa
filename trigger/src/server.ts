// qa-trigger — small HTTP shim that exposes the QA suite as an on-demand
// endpoint instead of forcing devs to use `gh workflow run` or the Dokploy
// UI. Auth is a single shared bearer token (QA_TRIGGER_TOKEN). Every action
// boils down to: ask Dokploy to redeploy the qa-runner app, poll Dokploy's
// status field, then read the runner's own latest.json once the deploy
// settles. The runner takes care of issue-syncing and Slack-posting from
// inside the container, so this service is intentionally thin.
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const DOKPLOY_API_URL = process.env.DOKPLOY_API_URL ?? "http://147.93.1.174:3000/api";
const DOKPLOY_API_TOKEN = process.env.DOKPLOY_API_TOKEN ?? "";
const QA_RUNNER_APP_ID = process.env.QA_RUNNER_APP_ID ?? "";
const QA_TRIGGER_TOKEN = process.env.QA_TRIGGER_TOKEN ?? "";
// Internal URL is used for fetches by this service so we don't have to
// re-enter Traefik (which causes a 504 when the container is on the same
// VPS as Traefik but DNS resolves to VPS2 then back). Public URL is what
// gets handed back in responses so callers can click through.
const QA_REPORTS_INTERNAL_URL = process.env.QA_REPORTS_INTERNAL_URL ?? "http://automated-qa-static-staging-6pwsju";
const QA_REPORTS_PUBLIC_URL = process.env.QA_REPORTS_PUBLIC_URL ?? "https://qa-reports.test.revhero.io";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15_000);
const MAX_RUN_TIMEOUT_SEC = Number(process.env.MAX_RUN_TIMEOUT_SEC ?? 1800); // 30 min ceiling

if (!DOKPLOY_API_TOKEN) console.warn("[qa-trigger] DOKPLOY_API_TOKEN not set — trigger calls will fail");
if (!QA_RUNNER_APP_ID) console.warn("[qa-trigger] QA_RUNNER_APP_ID not set — trigger calls will fail");
if (!QA_TRIGGER_TOKEN) console.warn("[qa-trigger] QA_TRIGGER_TOKEN not set — auth disabled (DEV ONLY)");

type DispatchStatus = "queued" | "deploying" | "running" | "completed" | "failed" | "timeout";

type Dispatch = {
  id: string;
  started_at: string;
  finished_at?: string;
  status: DispatchStatus;
  triggered_by?: string;
  dokploy_status?: string;
  error?: string;
  report?: {
    run_id: string;
    finished_at: string;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    not_exec: number;
    report_url: string;
  };
};

// In-memory dispatch tracking. The trigger service is single-instance —
// we don't need a DB. Lost on restart, which is fine; the runner's own
// latest.json + qa-reports.test.revhero.io is the durable record.
const dispatches = new Map<string, Dispatch>();

function requireAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!QA_TRIGGER_TOKEN) return true; // dev mode — no auth
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || match[1] !== QA_TRIGGER_TOKEN) {
    reply.code(401).send({ error: "Unauthorized — missing or invalid bearer token" });
    return false;
  }
  return true;
}

async function dokployDeploy(): Promise<void> {
  const res = await fetch(`${DOKPLOY_API_URL}/application.deploy`, {
    method: "POST",
    headers: {
      "X-API-Key": DOKPLOY_API_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ applicationId: QA_RUNNER_APP_ID })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`Dokploy application.deploy returned ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function dokployStatus(): Promise<string> {
  const url = `${DOKPLOY_API_URL}/application.one?applicationId=${encodeURIComponent(QA_RUNNER_APP_ID)}`;
  const res = await fetch(url, { headers: { "X-API-Key": DOKPLOY_API_TOKEN } });
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`Dokploy application.one returned ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { applicationStatus?: string };
  return json.applicationStatus ?? "unknown";
}

async function fetchLatestReport(): Promise<Dispatch["report"] | undefined> {
  try {
    const res = await fetch(`${QA_REPORTS_INTERNAL_URL}/latest.json`);
    if (!res.ok) return undefined;
    const json = (await res.json()) as {
      summary?: {
        run_id?: string;
        finished_at?: string;
        total?: number;
        passed?: number;
        failed?: number;
        skipped?: number;
        not_exec?: number;
      };
    };
    const s = json.summary;
    if (!s?.run_id) return undefined;
    return {
      run_id: s.run_id,
      finished_at: s.finished_at ?? "",
      total: s.total ?? 0,
      passed: s.passed ?? 0,
      failed: s.failed ?? 0,
      skipped: s.skipped ?? 0,
      not_exec: s.not_exec ?? 0,
      report_url: `${QA_REPORTS_PUBLIC_URL}/${s.run_id}/report.md`
    };
  } catch (err) {
    console.error("[qa-trigger] latest report fetch failed:", err);
    return undefined;
  }
}

async function pollUntilDone(dispatchId: string, timeoutSec: number): Promise<void> {
  const dispatch = dispatches.get(dispatchId);
  if (!dispatch) return;
  const deadline = Date.now() + timeoutSec * 1000;
  // Capture the run_id we saw before we kicked off the deploy so we can
  // tell when a NEW run has been written to the volume. This is a more
  // reliable completion signal than dokployStatus, which flips to "done"
  // as soon as the deploy step (image pull + container start) finishes —
  // but the actual vitest run continues for a few minutes inside.
  const previous = await fetchLatestReport();
  const previousRunId = previous?.run_id;
  let sawRunning = false;

  while (Date.now() < deadline) {
    // Surface dokploy status as a hint for callers, but don't gate on it.
    try {
      const status = await dokployStatus();
      dispatch.dokploy_status = status;
      if (status === "running") {
        dispatch.status = "running";
        sawRunning = true;
      } else if (status === "error") {
        dispatch.status = "failed";
        dispatch.error = "Dokploy reported deployment error";
        dispatch.finished_at = new Date().toISOString();
        return;
      } else if ((status === "done" || status === "idle") && sawRunning && dispatch.status === "deploying") {
        dispatch.status = "running";
      }
    } catch (err) {
      console.error(`[qa-trigger] dispatch ${dispatchId} dokployStatus error:`, err);
    }

    // Real completion signal: a new run_id appears in latest.json.
    const report = await fetchLatestReport();
    if (report && report.run_id !== previousRunId) {
      dispatch.report = report;
      dispatch.status = "completed";
      dispatch.finished_at = new Date().toISOString();
      return;
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  dispatch.status = "timeout";
  dispatch.error = `No completion within ${timeoutSec}s`;
  dispatch.finished_at = new Date().toISOString();
}

async function dispatchRun(triggeredBy: string | undefined): Promise<Dispatch> {
  const dispatch: Dispatch = {
    id: randomUUID(),
    started_at: new Date().toISOString(),
    status: "queued"
  };
  if (triggeredBy) dispatch.triggered_by = triggeredBy;
  dispatches.set(dispatch.id, dispatch);

  // Don't fail the HTTP request if Dokploy is unreachable — record the
  // failure on the dispatch and let callers see it via /runs/:id.
  try {
    await dokployDeploy();
    dispatch.status = "deploying";
  } catch (err) {
    dispatch.status = "failed";
    dispatch.error = err instanceof Error ? err.message : String(err);
    dispatch.finished_at = new Date().toISOString();
  }
  return dispatch;
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

app.get("/healthz", async () => ({
  ok: true,
  service: "qa-trigger",
  uptime_sec: Math.round(process.uptime()),
  dispatches_in_memory: dispatches.size
}));

app.get("/v1/runs/latest", async () => {
  const report = await fetchLatestReport();
  if (!report) return { error: "latest report not available" };
  return { latest: report };
});

app.get("/v1/runs/:id", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const id = (req.params as { id: string }).id;
  const dispatch = dispatches.get(id);
  if (!dispatch) {
    reply.code(404).send({ error: `dispatch ${id} not found (lost on restart, in-memory only)` });
    return;
  }
  return dispatch;
});

app.post("/v1/run", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const body = (req.body ?? {}) as { triggered_by?: string };
  const dispatch = await dispatchRun(body.triggered_by);
  if (dispatch.status === "failed") {
    reply.code(502).send(dispatch);
    return;
  }
  // Fire-and-forget the poller — the dispatch object updates in place
  // and callers can poll GET /v1/runs/:id.
  void pollUntilDone(dispatch.id, MAX_RUN_TIMEOUT_SEC);
  reply.code(202).send({
    ...dispatch,
    poll_url: `/v1/runs/${dispatch.id}`,
    note: "Async dispatch — poll the URL above for status."
  });
});

app.post("/v1/run/sync", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const body = (req.body ?? {}) as { triggered_by?: string; timeout_sec?: number };
  const requested = Number(body.timeout_sec ?? MAX_RUN_TIMEOUT_SEC);
  const timeoutSec = Math.min(Math.max(60, requested), MAX_RUN_TIMEOUT_SEC);
  const dispatch = await dispatchRun(body.triggered_by);
  if (dispatch.status === "failed") {
    reply.code(502).send(dispatch);
    return;
  }
  await pollUntilDone(dispatch.id, timeoutSec);
  if (dispatch.status === "completed") {
    reply.send(dispatch);
    return;
  }
  reply.code(502).send(dispatch);
});

app.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`[qa-trigger] listening on ${HOST}:${PORT}`);
}).catch((err) => {
  console.error("[qa-trigger] failed to start:", err);
  process.exit(1);
});
