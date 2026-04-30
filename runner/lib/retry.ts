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
