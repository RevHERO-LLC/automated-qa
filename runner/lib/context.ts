import { loadEnv, type Env } from "@revhero/qa-shared";
import * as path from "node:path";
import * as fs from "node:fs";

let envCache: Env | null = null;

export function getEnv(): Env {
  if (!envCache) envCache = loadEnv();
  return envCache;
}

export function getRunId(): string {
  const env = getEnv();
  if (env.QA_RUN_ID) return env.QA_RUN_ID;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `local-${stamp}`;
}

export function getReportRoot(): string {
  const env = getEnv();
  const root = path.resolve(env.QA_REPORT_DIR ?? "./reports", getRunId());
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, "screenshots"), { recursive: true });
  fs.mkdirSync(path.join(root, "traces"), { recursive: true });
  return root;
}

export function getReportLatestDir(): string {
  const env = getEnv();
  return path.resolve(env.QA_REPORT_DIR ?? "./reports");
}

export type AreaUrls = {
  base: string;
  bff: string;
  smsService: string;
  emailIngress: string;
  dealMover: string;
  cloudDocs: string;
  aiAgent: string;
  campaignService: string;
  dealsActions: string;
  pipedrive: string;
  activityService: string;
  usersService: string;
};

export function getAreaUrls(): AreaUrls {
  const env = getEnv();
  return {
    base: env.STAGING_BASE_URL,
    bff: env.STAGING_BFF_URL,
    smsService: "https://sms-service.test.revhero.io",
    emailIngress: "https://email-ingress.test.revhero.io",
    dealMover: "https://deal-mover.test.revhero.io",
    cloudDocs: "https://cloud-documents-service.test.revhero.io",
    aiAgent: "https://ai-agent.test.revhero.io",
    campaignService: "https://campaign-service.test.revhero.io",
    dealsActions: "https://deals-actions-service.test.revhero.io",
    pipedrive: "https://pipedrive-service.test.revhero.io",
    activityService: "https://activity-service.test.revhero.io",
    usersService: "https://users-service.test.revhero.io"
  };
}

export type RoleCreds = { email: string; password: string };

export function getCredentials(role: "ADMIN" | "PAID_ADMIN" | "MEMBER" | "SUPER_ADMIN"): RoleCreds {
  const env = getEnv();
  switch (role) {
    case "ADMIN":
      if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) throw new Error("ADMIN_EMAIL / ADMIN_PASSWORD not set");
      return { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD };
    case "PAID_ADMIN":
      if (!env.PAID_ADMIN_EMAIL || !env.PAID_ADMIN_PASSWORD) {
        throw new Error("PAID_ADMIN_EMAIL / PAID_ADMIN_PASSWORD not set");
      }
      return { email: env.PAID_ADMIN_EMAIL, password: env.PAID_ADMIN_PASSWORD };
    case "MEMBER":
      if (!env.MEMBER_EMAIL || !env.MEMBER_PASSWORD) {
        throw new Error("MEMBER_EMAIL / MEMBER_PASSWORD not set");
      }
      return { email: env.MEMBER_EMAIL, password: env.MEMBER_PASSWORD };
    case "SUPER_ADMIN":
      if (!env.SUPER_ADMIN_EMAIL || !env.SUPER_ADMIN_PASSWORD) {
        throw new Error("SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD not set");
      }
      return { email: env.SUPER_ADMIN_EMAIL, password: env.SUPER_ADMIN_PASSWORD };
  }
}

export function shouldRunTag(tags: readonly string[]): boolean {
  const env = getEnv();
  const filter = env.QA_TAG_FILTER;
  if (!filter) return true;
  const required = filter
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (required.length === 0) return true;
  return required.every((tag) => tags.includes(tag));
}
