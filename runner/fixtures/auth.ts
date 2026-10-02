// Browser-based auth fixture. loginAs() returns a logged-in BrowserContext that
// shares cookies + localStorage across tests in the same file.
//
// Implementation note (2026-04-30): the React login form has a hydration race
// where a button click before hydration falls back to the browser's default
// GET form submit (URL becomes `/login?email=...&password=...`). To avoid the
// race entirely, performLogin hits the BFF /v1/auth/login endpoint via
// BrowserContext.request — Set-Cookie headers from that response land in the
// context's cookie jar, and we mirror the JWT into localStorage for FE code
// paths that read from there.
//
// Tests that explicitly verify the login UI (FE-AUTH-019 spinner) interact
// with the form directly and don't go through this helper.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAreaUrls, getCredentials } from "../lib/context.js";
import { withSessionLock, lockPathFor } from "../lib/session-lock.js";
import { retryWithBudget, RetryBudgetExceededError } from "../lib/retry.js";

export type AuthRole = "ADMIN" | "PAID_ADMIN" | "MEMBER" | "SUPER_ADMIN";

let browser: Browser | null = null;

// In the deployed runner container, .sessions lives in the shared
// qa-reports-volume so it survives container restarts. That keeps the
// BFF login budget intact across days — without this, each scheduled
// run does a fresh login which over time exhausts
// LoginMaxAttemptsPerEmail. Locally (no QA_REPORT_DIR or QA_REPORT_DIR
// not on /mnt), .sessions falls back to the runner's own dir.
const SESSION_DIR = (() => {
  const reportDir = process.env.QA_REPORT_DIR;
  if (reportDir && reportDir.startsWith("/mnt/")) {
    return path.join(reportDir, ".sessions");
  }
  return path.resolve(__dirname, "../.sessions");
})();

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({
      headless: process.env.PWHEADLESS !== "false",
      args: ["--disable-dev-shm-usage", "--no-sandbox"]
    });
  }
  return browser;
}

function sessionPath(role: AuthRole): string {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  return path.join(SESSION_DIR, `${role.toLowerCase()}.json`);
}

// Vitest runs test files across worker processes in parallel. Each call to
// loginAs() may concurrently read/write the same per-role session file. The
// previous implementation passed a path directly to Playwright's
// newContext({ storageState: <path> }) and storageState({ path }), both of
// which open the file non-atomically — readers could land mid-write and see
// 0 bytes ("Unexpected end of JSON input"), and a half-applied state could
// produce a context that looks logged-in to the cache check but lands on a
// blank/redirect page later. Both failure modes were observed in the
// scheduled-20260504T080637 run (FE-CAMP-001 and FE-CAMP-002). Fix: do the
// I/O ourselves with defensive parsing and atomic temp+rename writes.
function readStorageStateOrNull(file: string): unknown | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeStorageStateAtomic(context: BrowserContext, file: string): Promise<void> {
  const state = await context.storageState();
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state), "utf8");
  fs.renameSync(tmp, file);
}

// Confirm the context is actually authenticated AND the FE has hydrated the
// logged-in layout before we hand the page back to a test. The FE reads the
// auth cookie client-side and briefly renders a blank / login state before
// hydrating the authed dashboard; `domcontentloaded` (and even `networkidle`)
// can fire inside that window, so an immediate element check sees count()===0
// even though the session is valid. We wait for a positive authed signal (the
// layout sidebar/nav, present on every authenticated page) and verify we were
// not bounced to /login. Returns false if the session didn't land so the
// caller can re-log-in or fail loudly instead of returning a logged-out page —
// the root cause of the recurring FE-CAMP-003 / FE-LAY-001 "expected false to
// be true" flakes.
async function ensureAuthedRender(page: Page, timeoutMs = 12_000): Promise<boolean> {
  if (page.url().includes("/login")) return false;
  const authedSignal = page
    .locator('[role="navigation"], aside, nav.sidebar, .sidebar')
    .first();
  try {
    await authedSignal.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return false;
  }
  return !page.url().includes("/login");
}

// Builds a context from a given (already-parsed) storageState and verifies
// it still renders authed. Returns null — closing the context it opened —
// if the state doesn't actually land logged in, so callers can fall back to
// a real login without ever handing a test a logged-out page. Shared by the
// happy-path cache hit below and by the post-lock double-check, so there is
// exactly one place that knows how to "try a cached state."
async function tryContextFromState(
  state: unknown
): Promise<{ context: BrowserContext; page: Page } | null> {
  const b = await getBrowser();
  const baseURL = getAreaUrls().base;
  const context = await b.newContext({
    baseURL,
    storageState: state as any,
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();
  await page.goto("/automation-campaign", { waitUntil: "domcontentloaded" });
  if (await ensureAuthedRender(page)) return { context, page };
  await context.close();
  return null;
}

export async function loginAs(role: AuthRole): Promise<{ context: BrowserContext; page: Page }> {
  const sp = sessionPath(role);
  const cached = readStorageStateOrNull(sp);
  if (cached !== null) {
    const hit = await tryContextFromState(cached);
    if (hit) return hit;
  }

  // Cache missing, unreadable, or no longer authenticated. vitest's
  // fileParallelism runs test FILES as separate OS processes, so without a
  // cross-process lock here, every worker process that hits a cold/expired
  // cache for the SAME role at the same moment (e.g. right after the runner
  // service moves nodes and SESSION_DIR — a node-local volume — comes up
  // empty) would log in concurrently. Each of those is a separate hit
  // against LoginMaxAttemptsPerEmail=10 (15m window), which is exactly the
  // 429 storm that took down the 2026-09-30 run. Serialize on a per-role
  // lockfile instead: only the first process to acquire it actually logs in.
  const lockPath = lockPathFor(SESSION_DIR, role);
  return withSessionLock(lockPath, async () => {
    // Double-check AFTER acquiring the lock: another process may have logged
    // in and written a fresh state for this role while we were waiting.
    const refreshed = readStorageStateOrNull(sp);
    if (refreshed !== null) {
      const hit = await tryContextFromState(refreshed);
      if (hit) return hit;
    }

    const b = await getBrowser();
    const baseURL = getAreaUrls().base;
    const context = await b.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await performLoginViaApi(context, role);
    await page.goto("/automation-campaign", { waitUntil: "domcontentloaded" });
    // Verify the session actually landed before returning. A cookie-propagation
    // race (or stale storage state) can otherwise leave the page on /login or a
    // blank pre-hydration state — handing that to a test produces the recurring
    // "expected false to be true" flakes. Retry the login once, then fail loudly
    // rather than return a logged-out page.
    if (!(await ensureAuthedRender(page))) {
      await performLoginViaApi(context, role);
      await page.goto("/automation-campaign", { waitUntil: "domcontentloaded" });
      if (!(await ensureAuthedRender(page))) {
        throw new Error(
          `[auth] loginAs(${role}) could not establish an authenticated session (still at ${page.url()})`
        );
      }
    }
    try {
      await writeStorageStateAtomic(context, sp);
    } catch (err) {
      // Best-effort persistence — a failed write means the next test re-logs in.
      console.warn(`[auth] storage state write failed for ${role}:`, err);
    }
    return { context, page };
  });
}

// Result of a single, non-retrying login POST. 429 is reported rather than
// thrown so callers can decide how to wait — the worker-side fallback
// (performLoginViaApi, one capped retry) and globalSetup's prewarmLogin
// (a real multi-minute budget) each wait very differently, but neither
// should duplicate the request/cookie-setting logic below to do it.
export type LoginAttemptResult = { ok: true } | { ok: false; retryAfterMs: number | null };

function parseRetryAfterMs(headerValue: string | undefined, bodySeconds: unknown): number | null {
  if (headerValue !== undefined) {
    const secs = Number(headerValue);
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  }
  if (typeof bodySeconds === "number" && bodySeconds > 0) return bodySeconds * 1000;
  return null;
}

async function attemptLoginOnce(context: BrowserContext, role: AuthRole): Promise<LoginAttemptResult> {
  const creds = getCredentials(role);
  const bff = getAreaUrls().bff;
  const res = await context.request.post(`${bff}/v1/auth/login`, {
    data: { email: creds.email, password: creds.password },
    headers: { "content-type": "application/json", accept: "application/json" }
  });

  if (res.status() === 429) {
    // "Retry-After" names the standard HTTP header for this; the BFF also
    // echoes the same figure as retry_after_seconds in the JSON body (see
    // RevHero-user-fe-backend auth.handler.go). Prefer the header — it's
    // what the name refers to — and fall back to the body field.
    const headerVal = res.headers()["retry-after"];
    let bodySeconds: unknown;
    if (headerVal === undefined) {
      try {
        const body = (await res.json()) as any;
        bodySeconds = body?.data?.retry_after_seconds ?? body?.retry_after_seconds;
      } catch {
        /* ignore json parse */
      }
    }
    return { ok: false, retryAfterMs: parseRetryAfterMs(headerVal, bodySeconds) };
  }

  if (!res.ok()) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`BFF /v1/auth/login returned ${res.status()}: ${body.slice(0, 300)}`);
  }
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    // Non-JSON response — server may rely entirely on cookies. That's fine.
  }
  const token = body?.access_token ?? body?.token ?? body?.data?.access_token ?? body?.data?.token;
  const refreshToken =
    body?.refresh_token ?? body?.data?.refresh_token ?? body?.refreshToken ?? body?.data?.refreshToken;

  if (token) {
    // The FE reads `token` and `refresh_token` cookies on its own domain
    // (staging.revhero.ai) via `getCookie("token")` in apiClient.ts.
    // Replicate the cookie writes that lib/auth.ts:setAuthCookie does after
    // a real form-driven login.
    const stagingHost = new URL(getAreaUrls().base).hostname;
    const oneDay = Math.floor(Date.now() / 1000) + 86_400;
    const cookies = [
      {
        name: "token",
        value: token,
        domain: stagingHost,
        path: "/",
        expires: oneDay,
        httpOnly: false,
        secure: true,
        sameSite: "Lax" as const
      }
    ];
    if (refreshToken) {
      cookies.push({
        name: "refresh_token",
        value: refreshToken,
        domain: stagingHost,
        path: "/",
        expires: oneDay,
        httpOnly: false,
        secure: true,
        sameSite: "Lax" as const
      });
    }
    await context.addCookies(cookies);

    // Also mirror to localStorage for any FE code paths that read from there.
    await context.addInitScript(
      ({ tokenValue }) => {
        try {
          localStorage.setItem("revhero_token", tokenValue);
          localStorage.setItem("access_token", tokenValue);
        } catch {
          // localStorage may be blocked in some contexts — ignore.
        }
      },
      { tokenValue: token }
    );
  }

  return { ok: true };
}

async function performLoginViaApi(context: BrowserContext, role: AuthRole): Promise<void> {
  // The BFF rate-limits login attempts per email (LoginMaxAttemptsPerEmail =
  // 10 per 15-MINUTE window; LoginMaxAttemptsPerIP = 30 — see
  // RevHero-user-fe-backend revhero.contract.go). Prior test runs may have
  // polluted the budget. If we hit 429, wait the server-suggested retry and
  // try once more — capped at 60s so a rogue test doesn't hang the suite
  // indefinitely. This single capped retry is only a last-resort fallback for
  // the rare worker-side cache-miss/expiry (loginAs wraps it in a
  // cross-process lock so at most one worker process ever gets here per
  // role); the real rate-limit window is absorbed up front by globalSetup's
  // prewarmLogin, which budgets up to 16 minutes per role before the suite
  // even starts.
  let result = await attemptLoginOnce(context, role);
  if (!result.ok) {
    const waitMs = Math.min(result.retryAfterMs ?? 30_000, 60_000);
    console.log(`[auth] BFF login returned 429 for ${role}; sleeping ${Math.round(waitMs / 1000)}s before retry`);
    await new Promise((r) => setTimeout(r, waitMs));
    result = await attemptLoginOnce(context, role);
    if (!result.ok) {
      throw new Error(
        `[auth] loginAs(${role}) hit the BFF login rate limit (429) twice in a row; giving up after one retry.`
      );
    }
  }
}

// --- globalSetup support -----------------------------------------------
//
// vitest's globalSetup (runner/global-setup.ts) logs every role in SERIALLY
// before any worker process starts, so workers never race each other into
// the BFF's login rate limit on a cold SESSION_DIR. The pieces below are
// split so the retry/budget/cache ORCHESTRATION (runRoleLoginBudget) can be
// unit-tested with a stubbed attempt() and no browser or network at all;
// prewarmLogin is the thin wrapper that supplies the real Playwright/fs deps.

const FRESHNESS_MARGIN_MS = 30 * 60_000; // require 30min of runway left
const DEFAULT_PREWARM_BUDGET_MS = 16 * 60_000; // "at most 16 minutes" per role

// A cached storageState is worth reusing only if its auth cookie still has
// enough life left to outlast a full suite run — otherwise globalSetup would
// "successfully" skip the login and hand workers a session that expires
// mid-run.
export function isStorageStateFresh(state: unknown, marginMs = FRESHNESS_MARGIN_MS): boolean {
  if (!state || typeof state !== "object") return false;
  const cookies = (state as { cookies?: unknown }).cookies;
  if (!Array.isArray(cookies)) return false;
  const token = cookies.find((c: any) => c && c.name === "token");
  if (!token || typeof token.expires !== "number" || token.expires <= 0) return false;
  return token.expires * 1000 > Date.now() + marginMs;
}

function envPrewarmBudgetMs(): number | null {
  const raw = process.env.QA_LOGIN_PREWARM_BUDGET_MS;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type RunRoleLoginBudgetOptions = {
  // Total time to spend waiting out 429s before giving up. Defaults to the
  // QA_LOGIN_PREWARM_BUDGET_MS env var if set, else 16 minutes. Tests shorten
  // this directly via the option (that's the intended seam — see
  // tests/unit/login-budget.test.ts) rather than via real wall-clock waits.
  // `| undefined` throughout (not just `?:`): exactOptionalPropertyTypes
  // requires it wherever a value forwarded here (e.g. prewarmLogin passing
  // its own opts.budgetMs straight through) might itself be `undefined`.
  budgetMs?: number | undefined;
  readCached?: (() => unknown | null) | undefined;
  isFresh?: ((state: unknown) => boolean) | undefined;
  onSuccess?: (() => Promise<void> | void) | undefined;
  onSkip?: (() => void) | undefined;
  onWait?: ((waitMs: number, attempt: number, honoredRetryAfter: boolean) => void) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
};

// Pure retry/budget/cache orchestration for warming one role's session ahead
// of the suite. Deliberately knows nothing about Playwright — `attempt` is
// injected, which is what lets tests exercise the real backoff/budget logic
// with a stub and no network (see prewarmLogin below for the production
// wiring).
export async function runRoleLoginBudget(
  role: AuthRole,
  attempt: () => Promise<LoginAttemptResult>,
  opts: RunRoleLoginBudgetOptions = {}
): Promise<void> {
  const readCached = opts.readCached ?? (() => null);
  const isFresh = opts.isFresh ?? isStorageStateFresh;
  const cached = readCached();
  if (cached !== null && isFresh(cached)) {
    opts.onSkip?.();
    return;
  }

  const budgetMs = opts.budgetMs ?? envPrewarmBudgetMs() ?? DEFAULT_PREWARM_BUDGET_MS;
  try {
    await retryWithBudget<void>(
      async () => {
        const result = await attempt();
        if (result.ok) return { done: true, value: undefined };
        return { done: false, retryAfterMs: result.retryAfterMs };
      },
      { budgetMs, sleep: opts.sleep, now: opts.now, onWait: opts.onWait }
    );
  } catch (err) {
    if (err instanceof RetryBudgetExceededError) {
      throw new Error(
        `[auth] prewarmLogin(${role}) could not log in within the ${Math.round(budgetMs / 60_000)}-minute ` +
          `budget — the BFF login rate limit (LoginMaxAttemptsPerEmail=10 per 15m window) is still active ` +
          `after ${err.attempts} attempt(s). Giving up on this role for globalSetup; loginAs(${role})'s own ` +
          `cross-process lock remains as a per-test fallback.`
      );
    }
    throw err;
  }

  await opts.onSuccess?.();
}

// Real Playwright wiring around runRoleLoginBudget: used by
// runner/global-setup.ts to pre-warm one role's cached session before any
// worker process starts.
export async function prewarmLogin(role: AuthRole, opts: { budgetMs?: number } = {}): Promise<void> {
  const sp = sessionPath(role);
  const b = await getBrowser();
  const context = await b.newContext({ baseURL: getAreaUrls().base });
  try {
    await runRoleLoginBudget(role, () => attemptLoginOnce(context, role), {
      budgetMs: opts.budgetMs,
      readCached: () => readStorageStateOrNull(sp),
      onSkip: () =>
        console.log(`[auth] prewarmLogin(${role}): cached session still has runway — skipping login`),
      onWait: (waitMs, attempt, honored) =>
        console.log(
          `[auth] prewarmLogin(${role}): BFF returned 429 (attempt ${attempt + 1}); ` +
            `waiting ${Math.round(waitMs / 1000)}s (${honored ? "honoring Retry-After" : "exponential backoff"})`
        ),
      onSuccess: () => writeStorageStateAtomic(context, sp)
    });
  } finally {
    await context.close();
  }
}

export async function freshContext(): Promise<{ context: BrowserContext; page: Page }> {
  const b = await getBrowser();
  const context = await b.newContext({
    baseURL: getAreaUrls().base,
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();
  return { context, page };
}

export async function logout(context: BrowserContext): Promise<void> {
  await context.clearCookies();
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

export function invalidateSession(role: AuthRole): void {
  const sp = sessionPath(role);
  if (fs.existsSync(sp)) fs.unlinkSync(sp);
}
