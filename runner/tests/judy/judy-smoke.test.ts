// JUDY-001..003 — judy-service gate smoke (ZERO prior coverage before this
// file; automated-qa has never had a test under tests/judy/).
//
// judy-service is the in-app virtual-CRO AI chat assistant (Go, port 8520,
// staging only — memory service_judy.md notes it is OFF prod). The BFF
// proxies to it under /v1/judy/*, /v1/kb/* and /v1/onboarding/*
// (routes.go:1682-1724, wired at routes.go:561-565, pkg/revhero_judy_client).
// This suite hits the most representative read route:
//   GET /v1/judy/conversations -> JudyHandlerImpl.ListConversations
//     (internal/resources/judy_resource/judy.handler.go:77) — user_id is
//     injected server-side from the JWT, never accepted from the client.
//
// judy-service itself has NO app-layer auth of its own — revhero_judy_client
// is explicitly documented (pkg/revhero_judy_client/client.go:25-26) as a
// "PLAIN (non-caching) client ... every call passes nil headers, no
// X-Internal-Secret" for every tenant-facing method. The BFF's JWTAuth on
// protectedGroup (routes.go:546) is therefore the ONLY gate standing in
// front of judy-service for these routes.
//
// Ground truth curled directly against staging 2026-08-27 (unauthenticated):
//   GET /v1/judy/conversations -> 401 {"message":"Authorization header required"}
//   GET /v1/judy/__nope__      -> 404 "404 page not found" (Gin's default
//     NoRoute handler — bypasses JWTAuth entirely; proves the 401 above comes
//     from a REGISTERED, auth-gated route, not "everything here 404s".)
//   GET /v1/onboarding/status  -> 401 (same shape; an alternate judy-backed
//     route if a second smoke target is ever wanted — not used below to keep
//     this suite to one representative route per the gate-smoke brief).
import { describe, test, expect, afterAll } from "vitest";
import { loginAs, closeBrowser } from "../../fixtures/auth.js";
import { bffClient } from "../../fixtures/api.js";
import { getAreaUrls } from "../../lib/context.js";

describe("Judy-service gate smoke (JUDY)", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  test("JUDY-001 — Unauth GET /v1/judy/conversations rejected", async () => {
    const r = await bffClient().get("/v1/judy/conversations");
    expect([401, 403]).toContain(r.status);
  });

  test("JUDY-002 — Authed GET /v1/judy/conversations does not 5xx (service up)", async () => {
    const { context } = await loginAs("ADMIN");
    try {
      const bffBase = getAreaUrls().bff;
      const r = await context.request.get(`${bffBase}/v1/judy/conversations`, {
        timeout: 20_000
      });
      // ListConversations' only failure branch is a flat 500 ("Failed to
      // list Judy conversations") when the service call errors
      // (judy_resource/judy.handler.go:80-85) — no legitimate non-5xx
      // "degraded" branch, so a strict <500 is the right bar. A 5xx means
      // judy-service is down/unreachable from the BFF on staging.
      expect(r.status(), `judy-service proxy returned ${r.status()}`).toBeLessThan(500);
    } finally {
      await context.close();
    }
  });

  test("JUDY-003 — Bogus sibling path 404s distinctly from the real route's 401 (route-exists sanity)", async () => {
    const r = await bffClient().get("/v1/judy/__nope__");
    expect(r.status).toBe(404);
  });
});
