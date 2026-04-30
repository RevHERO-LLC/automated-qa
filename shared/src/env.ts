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
  cached = parsed.data;
  return cached;
}

function assertStaging(url: string): void {
  const host = new URL(url).hostname.toLowerCase();
  const isStaging =
    host.startsWith("staging.") ||
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
