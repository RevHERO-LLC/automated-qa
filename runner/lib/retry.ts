export type RetryOptions = {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
};

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const base = opts.baseMs ?? 500;
  const max = opts.maxMs ?? 8_000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (opts.shouldRetry && !opts.shouldRetry(err, i)) throw err;
      if (i === attempts - 1) break;
      const delay = Math.min(base * 2 ** i, max) + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// Thrown by retryWithBudget when the total wait budget is exhausted without
// the attempt succeeding. Carries the figures callers need to build a clear,
// role/context-specific error message without re-deriving them.
export class RetryBudgetExceededError extends Error {
  constructor(
    public readonly budgetMs: number,
    public readonly elapsedMs: number,
    public readonly attempts: number
  ) {
    super(`retry budget of ${budgetMs}ms exceeded after ${attempts} attempt(s) (${elapsedMs}ms elapsed)`);
    this.name = "RetryBudgetExceededError";
  }
}

export type RetryBudgetResult<T> =
  | { done: true; value: T }
  | { done: false; retryAfterMs?: number | null };

export type RetryWithBudgetOptions = {
  // Total wall-clock time allowed across all waits before giving up.
  budgetMs: number;
  // Base delay for the exponential backoff used ONLY when the attempt did not
  // supply its own retryAfterMs hint (e.g. no Retry-After header/body field).
  baseMs?: number;
  maxBackoffMs?: number;
  // `| undefined` (not just `?:`) throughout: exactOptionalPropertyTypes
  // means callers forwarding their OWN optional options (e.g.
  // runRoleLoginBudget passing through its caller's opts.sleep) need to be
  // able to pass an explicit `undefined`, not just omit the key.
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  // Called right before each wait — useful for logging without coupling this
  // generic helper to any particular logger.
  onWait?: ((waitMs: number, attempt: number, hinted: boolean) => void) | undefined;
};

// Retries `fn` until it reports `done`, honoring a server-supplied retry hint
// (fn's `retryAfterMs`) when present and falling back to jittered exponential
// backoff otherwise — bounded by a total time budget rather than an attempt
// count, since a rate-limited caller cares about "how long until I give up",
// not "how many tries". A server-given hint is honored exactly (no jitter
// added — the server told us precisely how long to wait); the fallback
// backoff gets jitter to avoid a thundering herd of callers retrying in lockstep.
export async function retryWithBudget<T>(
  fn: (attempt: number) => Promise<RetryBudgetResult<T>>,
  opts: RetryWithBudgetOptions
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const base = opts.baseMs ?? 1_000;
  const maxBackoff = opts.maxBackoffMs ?? 60_000;
  const start = now();
  let attempt = 0;
  for (;;) {
    const result = await fn(attempt);
    if (result.done) return result.value;

    const hinted = result.retryAfterMs ?? null;
    const backoff = hinted ?? Math.min(base * 2 ** attempt, maxBackoff);
    const jitter = hinted !== null ? 0 : Math.floor(Math.random() * Math.min(backoff, 1_000));
    const delay = backoff + jitter;

    const elapsed = now() - start;
    if (elapsed + delay > opts.budgetMs) {
      throw new RetryBudgetExceededError(opts.budgetMs, elapsed, attempt + 1);
    }

    opts.onWait?.(delay, attempt, hinted !== null);
    await sleep(delay);
    attempt++;
  }
}

export async function pollUntil<T>(
  fn: () => Promise<T | null>,
  opts: { timeoutMs?: number; intervalMs?: number; description?: string } = {}
): Promise<T> {
  const timeout = opts.timeoutMs ?? 90_000;
  const interval = opts.intervalMs ?? 1_500;
  const deadline = Date.now() + timeout;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last !== null && last !== undefined) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `pollUntil timed out after ${timeout}ms${opts.description ? `: ${opts.description}` : ""}`
  );
}
