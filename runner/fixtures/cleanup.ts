// Per-test teardown registry. Tests register cleanup callbacks; the registry
// runs them in LIFO order on test exit (whether the test passed or failed).
//
// Usage inside a test:
//   const cleanup = createCleanup();
//   afterEach(async () => { await cleanup.run(); });
//   ...
//   cleanup.add(async () => deleteRow(rowId));

export type CleanupCallback = () => Promise<void> | void;

export type Cleanup = {
  add(cb: CleanupCallback): void;
  run(): Promise<void>;
  size(): number;
};

export function createCleanup(): Cleanup {
  const stack: CleanupCallback[] = [];
  return {
    add(cb) {
      stack.push(cb);
    },
    async run() {
      while (stack.length > 0) {
        const cb = stack.pop()!;
        try {
          await cb();
        } catch (err) {
          // Don't let cleanup errors mask the original test failure.
          console.error("[cleanup] failed:", err);
        }
      }
    },
    size() {
      return stack.length;
    }
  };
}

export async function withCleanup<T>(fn: (c: Cleanup) => Promise<T>): Promise<T> {
  const c = createCleanup();
  try {
    return await fn(c);
  } finally {
    await c.run();
  }
}
