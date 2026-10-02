// Vitest globalSetup: runs ONCE, in its own process, before any worker
// process starts (vitest.config.ts has fileParallelism: true, so without
// this, worker processes each discover a cold/expired per-role session at
// roughly the same moment and all log in at once).
//
// Logging in here — serially, one role at a time, each with its own 429
// budget — absorbs the BFF's login rate limit (LoginMaxAttemptsPerEmail=10
// per 15m window) up front, so workers start with a warm SESSION_DIR instead
// of racing each other into it. This is what actually fixes the 429 storm
// from 2026-09-30: the runner service moving nodes empties SESSION_DIR
// (a node-local volume), so every worker hit a simultaneous cold cache.
//
// loginAs()'s own cross-process lock (fixtures/auth.ts) stays in place as a
// safety net for whatever this step doesn't cover — a session expiring
// mid-run, or this step being skipped — but with the cache pre-warmed, that
// lock should rarely have to do more than let one worker reuse what's
// already on disk.
import type { AuthRole } from "./fixtures/auth.js";
import { prewarmLogin, closeBrowser } from "./fixtures/auth.js";
import { prewarmAllRoles } from "./lib/prewarm.js";

const ROLES: readonly AuthRole[] = ["ADMIN", "PAID_ADMIN", "MEMBER", "SUPER_ADMIN"];

export default async function setup(): Promise<() => Promise<void>> {
  // Fail-open (lib/prewarm.ts): a role that can't be warmed is skipped, never fatal to the run.
  await prewarmAllRoles(ROLES, (role) => prewarmLogin(role));
  return async () => {
    await closeBrowser();
  };
}
