// OPT-001..003 — optimization-service gate smoke (ZERO prior coverage before
// this file; automated-qa has never had a test under tests/optimization/).
//
// optimization-service is the AI A/B Optimization Center backend (Go, port
// 8700, dark-launched — deployed on both prod and staging under Dokploy
// codenames: app-navigate-neural-protocol-8a182i on staging). The BFF proxies
// to it under /v1/optimization/* (routes.go:1726-1730, wired at
// routes.go:559, pkg/revhero_optimization_client):
//   GET  /v1/optimization/signoffs             -> ListProposals
//   POST /v1/optimization/signoffs/:id/approve -> ApproveProposal
//   POST /v1/optimization/signoffs/:id/reject  -> RejectProposal
//
// Auth stack (routes.go:545-559): protectedGroup requires JWTAuth for every
// route below it, and /v1/optimization additionally runs
// SwarmOptimizationAllowlist() (internal/middleware/auth/feature_gate.go).
// That allowlist is a documented NO-OP off-prod — isNonProdEnv() treats
// "staging" as gate-off so "staging QA keeps full access" (feature_gate.go
// comment) — meaning on staging the ONLY gate in front of these routes is
// ordinary JWT auth. On prod, a non-allowlisted authed user gets 403 from the
// allowlist instead; that prod-only behavior is out of scope for a staging
// smoke test.
//
// Ground truth curled directly against staging 2026-08-27 (unauthenticated):
//   GET /v1/optimization/signoffs  -> 401 {"message":"Authorization header required"}
//   GET /v1/optimization/__nope__  -> 404 "404 page not found" (Gin's default
//     NoRoute handler — an unmatched path never enters the route group, so it
//     bypasses JWTAuth entirely. This is the control: it proves the 401 above
//     comes from a REGISTERED, auth-gated route, not "everything here 404s".)
import { describe, test, expect, afterAll } from "vitest";
import { loginAs, closeBrowser } from "../../fixtures/auth.js";
import { bffClient } from "../../fixtures/api.js";
import { getAreaUrls } from "../../lib/context.js";

describe("Optimization-service gate smoke (OPT)", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  test("OPT-001 — Unauth GET /v1/optimization/signoffs rejected", async () => {
    const r = await bffClient().get("/v1/optimization/signoffs");
    // Observed on staging 2026-08-27: 401. Kept as a tolerant pair (matches
    // the fe-sec-role.test.ts FE-SEC-001 convention) in case JWTAuth's exact
    // code ever shifts between 401/403 for a missing-vs-malformed header —
    // both mean "auth is enforced", which is what this test guards.
    expect([401, 403]).toContain(r.status);
  });

  test("OPT-002 — Authed GET /v1/optimization/signoffs does not 5xx (service up)", async () => {
    const { context } = await loginAs("ADMIN");
    try {
      const bffBase = getAreaUrls().bff;
      const r = await context.request.get(`${bffBase}/v1/optimization/signoffs`, {
        timeout: 20_000
      });
      // ListProposals' only failure branch is a flat 500 ("Failed to load
      // optimization proposals") when the client call to optimization-service
      // errors (optimization_resource/handler.go:44) — there is no
      // legitimate non-5xx "degraded" state here (unlike analytics-service's
      // health check), so a strict <500 is the right bar. A 5xx means
      // optimization-service is down/unreachable from the BFF on staging.
      expect(r.status(), `optimization-service proxy returned ${r.status()}`).toBeLessThan(500);
    } finally {
      await context.close();
    }
  });

  test("OPT-003 — Bogus sibling path 404s distinctly from the real route's 401 (route-exists sanity)", async () => {
    const r = await bffClient().get("/v1/optimization/__nope__");
    expect(r.status).toBe(404);
  });
});
