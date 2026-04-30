// FE-AUTH-021..023 — BFF login rate limiter (Redis-backed FixedWindowRateLimiter).
// Resolves audit issue #28 (QA-AUDIT-MISSING).
//
// Source: RevHero-user-fe-backend/internal/helpers/ratelimit.go (NEW) +
// auth.handler.go integration. LoginMaxAttemptsPerEmail = 10 by default,
// LoginMaxAttemptsPerIP = 30.
//
// GATED: each test fires 30+ rapid login attempts which trips
// LoginMaxAttemptsPerIP — that pollutes the per-IP budget for the entire
// test run, causing every subsequent test that needs loginAs() to wait or
// fail. Run isolated:  RATELIMIT_SOAK=1 pnpm test
// The cron-driven daily QA does NOT run these. The deploy-prod gate does
// NOT run these. They run only on the explicit soak invocation.
import { describe, test, expect, afterAll } from "vitest";
import { closeBrowser } from "../../fixtures/auth.js";
import { closePool } from "../../fixtures/db.js";
import { bffLogin } from "../../fixtures/api.js";

const SOAK = process.env.RATELIMIT_SOAK === "1";

describe.skipIf(!SOAK)("BFF Login Rate Limiter (FE-AUTH) [soak-only]", () => {
  afterAll(async () => {
    await closeBrowser();
    await closePool();
  });

  test("FE-AUTH-021 — rapid wrong-password attempts on a unique email return 429 within budget", async () => {
    // Use a unique email so we don't pollute the real test admin's window.
    const fake = `rl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@yopmail.com`;
    const statuses: number[] = [];
    let saw429 = false;
    for (let i = 0; i < 30; i++) {
      const r = await bffLogin(fake, "wrong-pw-zzzz");
      statuses.push(r.status);
      if (r.status === 429) {
        saw429 = true;
        break;
      }
    }
    expect(
      saw429,
      `expected a 429 within 30 attempts; saw distinct statuses: ${[...new Set(statuses)].join(",")}`
    ).toBe(true);
  }, 90_000);

  test("FE-AUTH-022 — 429 response carries a friendly message + retry hint, no internals leaked", async () => {
    const fake = `rl-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@yopmail.com`;
    let last;
    for (let i = 0; i < 30; i++) {
      last = await bffLogin(fake, "wrong-pw-yyyy");
      if (last.status === 429) break;
    }
    expect(last?.status).toBe(429);
    const body = JSON.stringify(last?.data ?? "").toLowerCase();
    expect(body, "expected friendly rate-limit copy").toMatch(/too many|rate limit|try again|wait/);
    expect(body, "must not leak Redis / panic / goroutine internals").not.toMatch(/panic|goroutine|redis:|stack trace/);
    // The BFF includes retry_after_seconds in body.data for clients to back off.
    const retryAfter = last?.data?.data?.retry_after_seconds;
    if (retryAfter !== undefined) {
      expect(typeof retryAfter, "retry_after_seconds should be a number").toBe("number");
      expect(retryAfter, "retry_after_seconds should be positive").toBeGreaterThan(0);
    }
  }, 90_000);

  test("FE-AUTH-023 — rate limit is scoped per-email (different fakes don't share budget)", async () => {
    const fakeA = `rl-scope-a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@yopmail.com`;
    const fakeB = `rl-scope-b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@yopmail.com`;
    // Burn fakeA's budget.
    let aHit429 = false;
    for (let i = 0; i < 30; i++) {
      const r = await bffLogin(fakeA, "wrong");
      if (r.status === 429) { aHit429 = true; break; }
    }
    expect(aHit429, "fakeA should hit 429 within 30 attempts").toBe(true);
    // fakeB starts with a fresh budget — first attempt should NOT be 429.
    const bFirst = await bffLogin(fakeB, "wrong");
    expect(bFirst.status, `fakeB first attempt should not inherit fakeA's 429; got ${bFirst.status}`).not.toBe(429);
  }, 120_000);
});
