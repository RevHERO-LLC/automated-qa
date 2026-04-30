import { z } from "zod";

export const Severity = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof Severity>;

export const Role = z.enum(["ADMIN", "MEMBER", "SUPER_ADMIN", "ANY", "PAID_ADMIN", "MAGGIE", "QUINN"]);
export type Role = z.infer<typeof Role>;

export const TestType = z.enum([
  "page-load",
  "functional",
  "destructive",
  "security",
  "performance",
  "regression"
]);
export type TestType = z.infer<typeof TestType>;

export const Tag = z.enum([
  "p0",
  "p1",
  "p2",
  "p3",
  "p4",
  "p5",
  "p6",
  "p7",
  "paid",
  "destructive",
  "external-blocked",
  "needs-superadmin",
  "needs-twilio-real",
  "needs-toky",
  "needs-pipedrive",
  "needs-google-oauth",
  "needs-microsoft-oauth",
  "flaky",
  "slow",
  "smoke"
]);
export type Tag = z.infer<typeof Tag>;

export const RegistryEntry = z.object({
  id: z.string(),
  description: z.string(),
  area: z.string(),
  role: Role.default("ADMIN"),
  type: TestType.default("functional"),
  severity: Severity.default("medium"),
  destructive: z.boolean().default(false),
  deps: z.array(z.string()).default([]),
  tags: z.array(Tag).default([]),
  file: z.string().nullable().default(null),
  expected: z.string().optional(),
  notes: z.string().optional(),
  last_audited_at: z.string().nullable().default(null)
});
export type RegistryEntry = z.infer<typeof RegistryEntry>;

export const Registry = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  source: z.string(),
  total: z.number(),
  active: z.number(),
  descoped: z.number(),
  entries: z.array(RegistryEntry)
});
export type Registry = z.infer<typeof Registry>;

export type TestResult = {
  id: string;
  status: "PASS" | "FAIL" | "SKIP" | "NOT_EXEC";
  duration_ms: number;
  error?: string;
  screenshot?: string;
  trace?: string;
  notes?: string;
};

export type RunSummary = {
  run_id: string;
  started_at: string;
  finished_at: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  not_exec: number;
  flaky: number;
  results: TestResult[];
};
