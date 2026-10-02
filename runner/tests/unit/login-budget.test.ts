// Covers globalSetup's retry/backoff/budget orchestration (runRoleLoginBudget
// in fixtures/auth.ts) with a stubbed login attempt() and a fake clock — no
// network, no Playwright, no real waiting. The real HTTP/Playwright wiring
// (attemptLoginOnce, prewarmLogin) is exercised only by the actual e2e run
// against staging, which this file deliberately does not touch.
import { describe, test, expect, vi } from "vitest";
import {
  runRoleLoginBudget,
  isStorageStateFresh,
  type LoginAttemptResult
} from "../../fixtures/auth.js";

// Drives runRoleLoginBudget's `now`/`sleep` from one in-memory counter, so
// "exponential backoff" and "budget exceeded" are deterministic and instant
// instead of depending on real wall-clock time (which, with a no-op sleep,
// would never advance and would spin the retry loop indefinitely).
function fakeClock() {
  let clock = 0;
  const waits: number[] = [];
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      waits.push(ms);
      clock += ms;
    },
    waits
  };
}

describe("runRoleLoginBudget — globalSetup retry/backoff/budget (#qa-login-429)", () => {
  test("honors Retry-After across repeated 429s, then succeeds", async () => {
    const { now, sleep, waits } = fakeClock();
    let calls = 0;
    const attempt = vi.fn(async (): Promise<LoginAttemptResult> => {
      calls++;
      return calls <= 2 ? { ok: false, retryAfterMs: 1000 } : { ok: true };
    });
    const onSuccess = vi.fn();

    await runRoleLoginBudget("ADMIN", attempt, {
      budgetMs: 5_000,
      readCached: () => null,
      now,
      sleep,
      onSuccess
    });

    expect(calls).toBe(3);
    // Honored exactly — no jitter added to a server-given hint.
    expect(waits).toEqual([1000, 1000]);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  test("falls back to exponential backoff with jitter when no Retry-After is given", async () => {
    const { now, sleep, waits } = fakeClock();
    let calls = 0;
    const attempt = vi.fn(async (): Promise<LoginAttemptResult> => {
      calls++;
      return calls <= 2 ? { ok: false, retryAfterMs: null } : { ok: true };
    });

    await runRoleLoginBudget("MEMBER", attempt, {
      budgetMs: 60_000,
      readCached: () => null,
      now,
      sleep
    });

    expect(calls).toBe(3);
    expect(waits.length).toBe(2);
    // base=1000: attempt0 in [1000,1999], attempt1 (2000+jitter) in
    // [2000,2999] — ranges never overlap, so this is deterministic, not flaky.
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
    expect(waits[0]).toBeLessThan(2000);
    expect(waits[1]).toBeGreaterThanOrEqual(2000);
    expect(waits[1]).toBeGreaterThan(waits[0]!);
  });

  test("fails with a clear role + rate-limit error after the budget is exhausted", async () => {
    const { now, sleep } = fakeClock();
    const attempt = vi.fn(async (): Promise<LoginAttemptResult> => ({ ok: false, retryAfterMs: 1000 }));

    await expect(
      runRoleLoginBudget("SUPER_ADMIN", attempt, {
        budgetMs: 2_500, // shortened budget — the "option" the task calls for
        readCached: () => null,
        now,
        sleep
      })
    ).rejects.toThrow(/SUPER_ADMIN/);
  });

  test("respects QA_LOGIN_PREWARM_BUDGET_MS when no explicit budgetMs is given", async () => {
    const prev = process.env.QA_LOGIN_PREWARM_BUDGET_MS;
    process.env.QA_LOGIN_PREWARM_BUDGET_MS = "500";
    try {
      const { now, sleep } = fakeClock();
      const attempt = vi.fn(async (): Promise<LoginAttemptResult> => ({ ok: false, retryAfterMs: 1000 }));
      await expect(
        runRoleLoginBudget("ADMIN", attempt, { readCached: () => null, now, sleep })
      ).rejects.toThrow(/rate limit/i);
    } finally {
      if (prev === undefined) delete process.env.QA_LOGIN_PREWARM_BUDGET_MS;
      else process.env.QA_LOGIN_PREWARM_BUDGET_MS = prev;
    }
  });

  test("skips the login entirely when a fresh cached session already exists", async () => {
    const attempt = vi.fn(async (): Promise<LoginAttemptResult> => ({ ok: true }));
    const onSkip = vi.fn();

    await runRoleLoginBudget("PAID_ADMIN", attempt, {
      readCached: () => ({ cookies: [] }),
      isFresh: () => true,
      onSkip
    });

    expect(attempt).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  test("does NOT skip when the cached session exists but isFresh says no", async () => {
    const attempt = vi.fn(async (): Promise<LoginAttemptResult> => ({ ok: true }));

    await runRoleLoginBudget("PAID_ADMIN", attempt, {
      readCached: () => ({ cookies: [] }),
      isFresh: () => false
    });

    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe("isStorageStateFresh", () => {
  const future = Math.floor(Date.now() / 1000) + 3600; // 1h out
  const past = Math.floor(Date.now() / 1000) - 3600; // 1h ago

  test("true when the token cookie has well over the required margin left", () => {
    expect(isStorageStateFresh({ cookies: [{ name: "token", expires: future }] }, 60_000)).toBe(true);
  });

  test("false when the token cookie is already expired", () => {
    expect(isStorageStateFresh({ cookies: [{ name: "token", expires: past }] })).toBe(false);
  });

  test("false when the token cookie expires inside the required margin", () => {
    const soon = Math.floor(Date.now() / 1000) + 60; // 1 minute out
    expect(isStorageStateFresh({ cookies: [{ name: "token", expires: soon }] }, 30 * 60_000)).toBe(false);
  });

  test("false when there is no token cookie", () => {
    expect(isStorageStateFresh({ cookies: [{ name: "other", expires: future }] })).toBe(false);
  });

  test("false for malformed state", () => {
    expect(isStorageStateFresh(null)).toBe(false);
    expect(isStorageStateFresh({})).toBe(false);
    expect(isStorageStateFresh({ cookies: "nope" })).toBe(false);
  });
});
