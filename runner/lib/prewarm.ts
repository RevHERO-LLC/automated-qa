// Serial per-role login pre-warm used by global-setup.ts.
//
// FAIL-OPEN by design: the pre-warm is an optimization, never a gate on the
// suite. A role that can't be warmed -- no credentials configured for it on
// this runner (the staging runner has no SUPER_ADMIN_* env, 2026-10-02), or a
// login still rate-limited after its budget -- is logged and skipped, and the
// tests that need it fall back to loginAs()'s per-test lazy login. Before this,
// one missing credential threw out of globalSetup and vitest aborted the WHOLE
// run, publishing an empty latest.json (total 0) to the prod deploy gate.
//
// Kept free of fixtures/auth imports (type-only below) so it unit-tests
// without a browser, network, or staging env.
import type { AuthRole } from "../fixtures/auth.js";

export type PrewarmResult = { warmed: AuthRole[]; skipped: AuthRole[] };

export async function prewarmAllRoles(
  roles: readonly AuthRole[],
  prewarm: (role: AuthRole) => Promise<void>,
  warn: (message: string) => void = (message) => console.warn(message)
): Promise<PrewarmResult> {
  const result: PrewarmResult = { warmed: [], skipped: [] };
  for (const role of roles) {
    try {
      await prewarm(role);
      result.warmed.push(role);
    } catch (err) {
      result.skipped.push(role);
      const reason = err instanceof Error ? err.message : String(err);
      warn(`[auth] prewarmLogin(${role}) skipped -- falling back to per-test login: ${reason}`);
    }
  }
  return result;
}
