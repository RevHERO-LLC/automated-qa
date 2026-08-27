// ANALYTICS-001..003 — analytics-service gate smoke (ZERO prior coverage
// before this file; automated-qa has never had a test under
// tests/analytics/). NOTE: RevHero-analytics-service IS deployed on staging
// + prod (memory reference_analytics_service_deployed.md, dated 2026-07-31)
// despite CLAUDE.md's project-mapping table still calling it
// "in-development... no Dokploy app provisioned" — that line is stale.
//
// The BFF proxies to it via revhero_analytics_client
// (RevheroAnalyticsServiceBaseURL, config.go:107) and exposes the routes at
// a TOP-LEVEL /v1/dashboard/* group (routes.go:650, 1439-1452) — NOT under
// /v1/analytics/dashboard/* as docs/analytics-dashboard-api.md describes.
// That doc is describing analytics-service's OWN internal path shape (the
// one revhero_analytics_client calls, e.g. client.go:419's
// "%s/v1/analytics/dashboard/health"), not the BFF's externally-exposed
// path. Confirmed empirically below — treat the doc as describing the
// upstream contract, not the BFF's FE-facing surface.
//   GET /v1/dashboard/health -> AnalyticsHandlerImpl.HealthCheck
//     (internal/resources/analytics_resource/analytics.handler.go:376-390)
// Picked over /v1/dashboard, /milestones, /ab-summary because HealthCheck is
// the only one of the group that needs neither query params (ab-summary
// requires from/to) nor a resolved account/user id read from the JWT
// (milestones, ab-summary) — it is a pure liveness proxy.
//
// Ground truth curled directly against staging 2026-08-27 (unauthenticated):
//   GET /v1/dashboard/health           -> 401 {"message":"Authorization header required"}
//   GET /v1/dashboard/__nope__         -> 404 "404 page not found" (Gin
//     default NoRoute — bypasses JWTAuth entirely; proves the 401 above
//     comes from a REGISTERED, auth-gated route, not "everything here 404s")
//   GET /v1/analytics/dashboard/health -> 404 (confirms this path does NOT
//     exist on the BFF — see the doc-drift note above)
//
// WARNING: HealthCheck has a THIRD, non-crash status this suite must not
// misread as "down": if the upstream call succeeds but isHealthy==false, the
// handler answers 503 "Dashboard data is stale"
// (analytics.handler.go:383-386) — a legitimate business state (the daily
// precalc snapshot is behind), not a broken/unreachable service. Only a
// genuine client error there produces 500 ("Health check failed",
// analytics.handler.go:378-382); a clean success produces 200
// (analytics.handler.go:388-389). So OPT/JUDY's strict "<500" bar would
// misfire here (a stale-but-alive service would look like a failure); this
// suite asserts the exact {200, 503} set instead.
import { describe, test, expect, afterAll } from "vitest";
import { loginAs, closeBrowser } from "../../fixtures/auth.js";
import { bffClient } from "../../fixtures/api.js";
import { getAreaUrls } from "../../lib/context.js";

describe("Analytics-service gate smoke (ANALYTICS)", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  test("ANALYTICS-001 — Unauth GET /v1/dashboard/health rejected", async () => {
    const r = await bffClient().get("/v1/dashboard/health");
    expect([401, 403]).toContain(r.status);
  });

  test("ANALYTICS-002 — Authed GET /v1/dashboard/health does not fail closed (service up)", async () => {
    const { context } = await loginAs("ADMIN");
    try {
      const bffBase = getAreaUrls().bff;
      const r = await context.request.get(`${bffBase}/v1/dashboard/health`, {
        timeout: 20_000
      });
      const status = r.status();
      // Deliberately the exact {200, 503} set rather than "<500": 503 is a
      // documented, legitimate "data is stale" response from a service that
      // IS up (see file header) and must not be flagged as an outage. Only
      // 500 ("Health check failed" — the client call itself errored) means
      // analytics-service is down/unreachable from the BFF on staging.
      expect([200, 503], `analytics-service health proxy returned ${status}`).toContain(status);
    } finally {
      await context.close();
    }
  });

  test("ANALYTICS-003 — Bogus sibling path 404s distinctly from the real route's 401 (route-exists sanity)", async () => {
    const r = await bffClient().get("/v1/dashboard/__nope__");
    expect(r.status).toBe(404);
  });
});
