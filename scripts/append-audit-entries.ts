// One-shot script to append the 6 [QA-AUDIT-MISSING] registry entries
// from the 2026-04-30 audit run + add the file: pointers, then write
// last_audited_at on the touched entries.
//
// Run: pnpm exec tsx scripts/append-audit-entries.ts

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const REGISTRY_PATH = path.resolve(__dirname, "..", "registry.json");

type Registry = {
  version: 1;
  generated_at: string;
  source: string;
  total: number;
  active: number;
  descoped: number;
  entries: Array<Record<string, any>>;
};

const NEW_ENTRIES = [
  {
    id: "FE-AUTH-021",
    description: "BFF login endpoint rate limiting: Redis-backed fixed-window rate limiter enforces LoginMaxAttemptsPerEmail (10) and LoginMaxAttemptsPerIP (30) limits.",
    area: "Authentication",
    role: "ADMIN",
    type: "security",
    severity: "critical",
    destructive: false,
    deps: [],
    tags: ["p0"],
    file: "runner/tests/auth/fe-auth-ratelimit.test.ts",
    expected: "Repeated wrong-password attempts on same email return 429 within 30 attempts; retry_after_seconds in body.data.",
    notes: "Source: ratelimit.go in BFF, integrated into auth.handler.go.",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  },
  {
    id: "FE-AUTH-022",
    description: "BFF rate-limit 429 response carries friendly message + retry_after_seconds, no internals leaked.",
    area: "Authentication",
    role: "ADMIN",
    type: "security",
    severity: "high",
    destructive: false,
    deps: ["FE-AUTH-021"],
    tags: ["p0"],
    file: "runner/tests/auth/fe-auth-ratelimit.test.ts",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  },
  {
    id: "FE-AUTH-023",
    description: "BFF rate limit is scoped per-email: budget exhaustion on one email does not affect another.",
    area: "Authentication",
    role: "ADMIN",
    type: "security",
    severity: "high",
    destructive: false,
    deps: ["FE-AUTH-021"],
    tags: ["p0"],
    file: "runner/tests/auth/fe-auth-ratelimit.test.ts",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  },
  {
    id: "FE-EMAIL-IN-012",
    description: "Email bounce-webhook endpoint requires INTERNAL_SERVICES_WEBHOOK_SECRET — rejects unauth'd requests with 401/403.",
    area: "Email — inbound + AI sentiment",
    role: "ADMIN",
    type: "security",
    severity: "critical",
    destructive: false,
    deps: [],
    tags: ["p1"],
    file: "runner/tests/email/fe-email-in-bounce.test.ts",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  },
  {
    id: "FE-EMAIL-IN-013",
    description: "Email bounce debounce: duplicate bounces for same recipient within window absorbed without crash (smoke).",
    area: "Email — inbound + AI sentiment",
    role: "ADMIN",
    type: "functional",
    severity: "high",
    destructive: false,
    deps: ["FE-EMAIL-IN-012"],
    tags: ["p1", "slow"],
    file: "runner/tests/email/fe-email-in-bounce.test.ts",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  },
  {
    id: "FE-EMAIL-IN-014",
    description: "Bounced address propagates to email_blocklist after debounce window settles (smoke).",
    area: "Email — inbound + AI sentiment",
    role: "ADMIN",
    type: "functional",
    severity: "medium",
    destructive: false,
    deps: ["FE-EMAIL-IN-012"],
    tags: ["p1", "slow"],
    file: "runner/tests/email/fe-email-in-bounce.test.ts",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  },
  {
    id: "FE-CSV-011",
    description: "Lead Ingestion Executor: CSV import completion publishes SubmitLeadIngestionEventV1 to JetStream; deals-actions consumes + submits to external API + records analytics.",
    area: "CSV imports / lead ingestion",
    role: "ADMIN",
    type: "functional",
    severity: "high",
    destructive: false,
    deps: ["FE-CSV-001"],
    tags: ["p1", "slow"],
    file: "runner/tests/csv/fe-csv-leadingestion.test.ts",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  },
  {
    id: "FE-CSV-012",
    description: "Lead-ingestion event contract has SubmitLeadIngestionEventV1 in pkg/revhero_event_bus/contracts (smoke).",
    area: "CSV imports / lead ingestion",
    role: "ADMIN",
    type: "functional",
    severity: "medium",
    destructive: false,
    deps: ["FE-CSV-011"],
    tags: ["p1"],
    file: "runner/tests/csv/fe-csv-leadingestion.test.ts",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  },
  {
    id: "FE-CSV-013",
    description: "Lead-ingestion OAuth2 token acquisition + refresh via leadingestion/auth.go (smoke).",
    area: "CSV imports / lead ingestion",
    role: "ADMIN",
    type: "functional",
    severity: "medium",
    destructive: false,
    deps: ["FE-CSV-011"],
    tags: ["p1"],
    file: "runner/tests/csv/fe-csv-leadingestion.test.ts",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  },
  {
    id: "FE-CSV-014",
    description: "Lead-ingestion analytics row carries success / partial / failed status (smoke).",
    area: "CSV imports / lead ingestion",
    role: "ADMIN",
    type: "functional",
    severity: "medium",
    destructive: false,
    deps: ["FE-CSV-011"],
    tags: ["p1"],
    file: "runner/tests/csv/fe-csv-leadingestion.test.ts",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  },
  {
    id: "FE-CAMP-021",
    description: "/automation-campaign/[id]/deals/search renders DealsSearchFilter + DealsSearchTable with at least one filter affordance.",
    area: "Campaign Builder",
    role: "ADMIN",
    type: "functional",
    severity: "high",
    destructive: false,
    deps: [],
    tags: ["p1"],
    file: "runner/tests/campaign/fe-camp-deals-search.test.ts",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  },
  {
    id: "FE-CAMP-022",
    description: "Search filter on deals/search updates URL state when typed + submitted (smoke).",
    area: "Campaign Builder",
    role: "ADMIN",
    type: "functional",
    severity: "medium",
    destructive: false,
    deps: ["FE-CAMP-021"],
    tags: ["p1"],
    file: "runner/tests/campaign/fe-camp-deals-search.test.ts",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  },
  {
    id: "FE-CAMP-023",
    description: "Status filter on deals/search applies cleanly without crash (smoke).",
    area: "Campaign Builder",
    role: "ADMIN",
    type: "functional",
    severity: "medium",
    destructive: false,
    deps: ["FE-CAMP-021"],
    tags: ["p1"],
    file: "runner/tests/campaign/fe-camp-deals-search.test.ts",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  },
  {
    id: "FE-CAMP-024",
    description: "Pagination controls on deals/search navigate without crash (smoke).",
    area: "Campaign Builder",
    role: "ADMIN",
    type: "functional",
    severity: "medium",
    destructive: false,
    deps: ["FE-CAMP-021"],
    tags: ["p1"],
    file: "runner/tests/campaign/fe-camp-deals-search.test.ts",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  },
  {
    id: "FE-SET-G-016",
    description: "/settings/general AI Chat Response tab renders.",
    area: "Settings — General",
    role: "ADMIN",
    type: "functional",
    severity: "medium",
    destructive: false,
    deps: [],
    tags: ["p2"],
    file: "runner/tests/settings/fe-set-g-aichat.test.ts",
    expected: "Click 'AI Chat Response' on right-rail nav reveals the panel without crash.",
    notes: "Source: 9722939d added AIChatResponse.tsx + useAiChatResponse.ts + aiChatResponseStorage.ts.",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  },
  {
    id: "FE-SET-G-017",
    description: "Selecting a campaign on AI Chat Response tab reveals channel toggles (smoke).",
    area: "Settings — General",
    role: "ADMIN",
    type: "functional",
    severity: "medium",
    destructive: false,
    deps: ["FE-SET-G-016"],
    tags: ["p2"],
    file: "runner/tests/settings/fe-set-g-aichat.test.ts",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  },
  {
    id: "FE-SET-G-018",
    description: "AI Chat config persists in LocalStorage across page reload (LocalStorage-backed by aiChatResponseStorage.ts).",
    area: "Settings — General",
    role: "ADMIN",
    type: "functional",
    severity: "medium",
    destructive: false,
    deps: ["FE-SET-G-016"],
    tags: ["p2"],
    file: "runner/tests/settings/fe-set-g-aichat.test.ts",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  },
  {
    id: "FE-EMAIL-OUT-013",
    description: "POST /v1/emails/render renders email template body with merge tags resolved (rendered_body in response).",
    area: "Email — outbound",
    role: "ADMIN",
    type: "functional",
    severity: "medium",
    destructive: false,
    deps: [],
    tags: ["p2"],
    file: "runner/tests/email/fe-email-out-render.test.ts",
    notes: "Source: email-ingress added dto/render.dto.go + RenderTemplate handler.",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  },
  {
    id: "FE-EMAIL-OUT-014",
    description: "/v1/emails/render with invalid deal_id returns 4xx (not 500).",
    area: "Email — outbound",
    role: "ADMIN",
    type: "functional",
    severity: "high",
    destructive: false,
    deps: ["FE-EMAIL-OUT-013"],
    tags: ["p2"],
    file: "runner/tests/email/fe-email-out-render.test.ts",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  },
  {
    id: "FE-EMAIL-OUT-015",
    description: "/v1/emails/render with missing template_body returns 400 with friendly error.",
    area: "Email — outbound",
    role: "ADMIN",
    type: "functional",
    severity: "medium",
    destructive: false,
    deps: ["FE-EMAIL-OUT-013"],
    tags: ["p2"],
    file: "runner/tests/email/fe-email-out-render.test.ts",
    last_audited_at: "2026-04-30T18:19:29.723Z"
  }
];

// Stale-fix updates: existing entries that now have correct test paths.
const STALE_FIX_UPDATES: Record<string, Partial<Record<string, any>>> = {
  "FE-SMS-TW-011": {
    file: "runner/tests/sms/fe-sms-tw.test.ts",
    notes: "QA-AUDIT-STALE #31 fixed 2026-04-30: corrected URL from /webhook/twilio/incoming to /webhook/incoming.",
    last_audited_at: "2026-04-30T20:35:00.000Z"
  },
  "FE-AI-017": {
    file: "runner/tests/ai/fe-ai.test.ts",
    notes: "QA-AUDIT-STALE #32 fixed 2026-04-30: sentiment-webhook lives on sms-service, not ai-agent.",
    last_audited_at: "2026-04-30T20:35:00.000Z"
  },
  "FE-AI-020": {
    file: "runner/tests/ai/fe-ai.test.ts",
    notes: "QA-AUDIT-STALE #33 fixed 2026-04-30: tests both legacy /cleanup-old-prompts and the QA-FULL-030 /v1/ alias.",
    last_audited_at: "2026-04-30T20:35:00.000Z"
  }
};

async function main() {
  const raw = await readFile(REGISTRY_PATH, "utf8");
  const reg: Registry = JSON.parse(raw);

  // Apply stale-fix updates.
  for (const [id, patch] of Object.entries(STALE_FIX_UPDATES)) {
    const idx = reg.entries.findIndex((e) => e.id === id);
    if (idx >= 0) {
      reg.entries[idx] = { ...reg.entries[idx], ...patch };
    } else {
      console.warn(`stale-fix: entry ${id} not found in registry`);
    }
  }

  // Append new entries (skip if already present).
  for (const e of NEW_ENTRIES) {
    if (reg.entries.some((x) => x.id === e.id)) {
      console.log(`skip ${e.id} — already in registry`);
      continue;
    }
    reg.entries.push(e);
  }

  reg.entries.sort((a, b) => a.id.localeCompare(b.id));
  reg.active = reg.entries.length;
  reg.total = reg.active + reg.descoped;
  reg.generated_at = new Date().toISOString();

  await writeFile(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n", "utf8");
  console.log(`Wrote ${reg.entries.length} entries (${reg.descoped} descoped, ${reg.total} total)`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
