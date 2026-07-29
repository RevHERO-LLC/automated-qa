import { z } from "zod";

const RawEnv = z.object({
  STAGING_BASE_URL: z.string().url(),
  STAGING_BFF_URL: z.string().url(),

  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(1).optional(),
  PAID_ADMIN_EMAIL: z.string().email().optional(),
  PAID_ADMIN_PASSWORD: z.string().min(1).optional(),
  MEMBER_EMAIL: z.string().email().optional(),
  MEMBER_PASSWORD: z.string().min(1).optional(),
  SUPER_ADMIN_EMAIL: z.string().email().optional(),
  SUPER_ADMIN_PASSWORD: z.string().min(1).optional(),

  SUPABASE_POOLER_URL: z.string().url().optional(),
  INTERNAL_SERVICES_WEBHOOK_SECRET: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),

  TOKY_API_KEY: z.string().optional(),
  TOKY_FROM_NUMBER: z.string().optional(),
  TOKY_TO_NUMBER: z.string().optional(),

  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPO: z.string().default("RevHERO-LLC/automated-qa"),
  SLACK_WEBHOOK_QA: z.string().url().optional(),
  SLACK_WEBHOOK_DEPLOYS: z.string().url().optional(),

  QA_REPORT_DIR: z.string().default("./reports"),
  QA_RUN_ID: z.string().optional(),
  QA_TAG_FILTER: z.string().optional()
});

export type Env = z.infer<typeof RawEnv>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = RawEnv.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("\n  ");
    throw new Error(`Invalid environment:\n  ${msg}`);
  }
  assertStaging(parsed.data.STAGING_BASE_URL);
  assertStaging(parsed.data.STAGING_BFF_URL);
  parsed.data.STAGING_BFF_URL = reconcileBffSite(
    parsed.data.STAGING_BFF_URL,
    parsed.data.STAGING_BASE_URL
  );
  cached = parsed.data;
  return cached;
}

// Legacy BFF hostnames and the same-site host that replaces them. The BFF is
// dual-hosted, so both names reach the same service.
const LEGACY_BFF_HOSTS: Record<string, string> = {
  "user-fe-backend.test.revhero.io": "api.staging.revhero.ai"
};

// The registrable domain ("site") of a URL — the last two labels of the host.
function siteOf(url: string): string {
  return new URL(url).hostname.toLowerCase().split(".").slice(-2).join(".");
}

// The BFF issues the HttpOnly session cookie that the FE reads, and a cookie is
// only shared between two hosts on the same registrable domain. If
// STAGING_BFF_URL and STAGING_BASE_URL sit on different sites, the cookie is
// host-only to the BFF and NO browser test can ever authenticate: loginAs()
// never establishes a session, never caches its storageState, and every test
// re-logs in until it exhausts the BFF login rate limiter. The visible symptom
// is a flood of unexplained 429s that looks nothing like the actual cause.
//
// This is not hypothetical. The deploy pipeline re-applies Dokploy's stored env
// on every redeploy, which silently reverted STAGING_BFF_URL to the legacy .io
// host and left the prod-deploy QA gate red for every repo. Encoding the
// invariant here means an env revert cannot quietly re-break it.
function reconcileBffSite(bffUrl: string, baseUrl: string): string {
  if (siteOf(bffUrl) === siteOf(baseUrl)) return bffUrl;

  const bffHost = new URL(bffUrl).hostname.toLowerCase();
  const replacement = LEGACY_BFF_HOSTS[bffHost];
  if (replacement && siteOf(`https://${replacement}`) === siteOf(baseUrl)) {
    const rewritten = new URL(bffUrl);
    rewritten.hostname = replacement;
    const out = rewritten.toString().replace(/\/$/, "");
    console.warn(
      `[env] STAGING_BFF_URL (${bffHost}) is on a different registrable domain than ` +
        `STAGING_BASE_URL (${new URL(baseUrl).hostname}). Cookie auth cannot work across ` +
        `sites, so rewriting to ${out}. Update the stored env to silence this.`
    );
    return out;
  }

  throw new Error(
    `STAGING_BFF_URL (${bffHost}) and STAGING_BASE_URL (${new URL(baseUrl).hostname}) are on ` +
      `different registrable domains (${siteOf(bffUrl)} vs ${siteOf(baseUrl)}). The BFF's ` +
      `session cookie would be host-only and no authenticated test could pass. Point both at ` +
      `the same site.`
  );
}

function assertStaging(url: string): void {
  const host = new URL(url).hostname.toLowerCase();
  const isStaging =
    host.startsWith("staging.") ||
    // Nested staging hosts, e.g. api.staging.revhero.ai — the BFF is dual-hosted
    // there so it shares the staging.revhero.ai registrable domain with the FE.
    // Without this the cookie the BFF issues is host-only to a different domain
    // and never reaches the FE, which silently breaks every authenticated test.
    // Matched as a dot-delimited label so a lookalike like notstaging.revhero.ai
    // is still refused, and prod (api.revhero.ai) matches nothing here.
    host.includes(".staging.") ||
    host.includes(".test.") ||
    host === "localhost" ||
    host === "127.0.0.1";
  if (!isStaging) {
    throw new Error(
      `Refusing to run against ${host} — QA targets must include 'staging.' or '.test.' in the hostname (or be localhost). ` +
        `Set STAGING_* env vars to a non-prod target.`
    );
  }
}

export function resetEnvCacheForTests(): void {
  cached = null;
}
