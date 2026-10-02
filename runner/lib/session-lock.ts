// Cross-process filesystem lock, used to serialize the per-role BFF login
// that happens when a cached Playwright storageState is missing or expired.
//
// Why a lockfile and not an in-process mutex: vitest.config.ts runs with
// fileParallelism: true, which executes test files in SEPARATE OS processes
// (not just separate async tasks in one process). A module-level `let
// locked = false` only guards callers inside the process that declared it —
// every other worker process has its own independent copy of that variable
// and would sail straight past it. The one thing every worker process
// actually shares is the filesystem (SESSION_DIR), so that's the lock.
import * as fs from "node:fs";
import * as path from "node:path";

export type SessionLockOptions = {
  // A lockfile older than this is assumed to belong to a process that died
  // (or hung) while holding it, and is broken rather than waited out forever.
  staleMs?: number;
  // How often to retry acquiring while another (non-stale) holder has it.
  pollMs?: number;
  // Overall safety cap on how long a caller will wait. Kept comfortably
  // above staleMs: in the normal case a wedged holder is recovered via the
  // stale-break above well before this fires, so this is a last-resort
  // guard against an unexpected infinite spin, not the primary mechanism.
  maxWaitMs?: number;
};

const DEFAULT_STALE_MS = 2 * 60_000;
const DEFAULT_POLL_MS = 200;
const DEFAULT_MAX_WAIT_MS = 5 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function lockPathFor(sessionDir: string, key: string): string {
  return path.join(sessionDir, `${key.toLowerCase()}.lock`);
}

// Blocks until `lockPath` can be created exclusively. Uses the "wx" flag
// (O_CREAT | O_EXCL | O_WRONLY) so the create-if-absent check is a single
// atomic syscall — two processes racing here can never both succeed, which
// is the property a plain "if existsSync() then create()" check would NOT
// have (that has a TOCTOU gap wide enough for both racers to pass the check
// before either creates the file).
export async function acquireLock(lockPath: string, opts: SessionLockOptions = {}): Promise<void> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const deadline = Date.now() + maxWaitMs;

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      // Best-effort breadcrumb for a human looking at a stuck lockfile; not
      // relied on for correctness (mtime, not this content, decides staleness).
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      let age: number;
      try {
        age = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        // The lock vanished between our failed open() and this stat() (the
        // holder released it right under us) — loop back and race for it fresh.
        continue;
      }

      if (age > staleMs) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Another waiter broke it first, or the holder released it
          // normally in the meantime — either way, loop back and retry.
        }
        continue;
      }

      if (Date.now() > deadline) {
        throw new Error(
          `acquireLock: timed out after ${maxWaitMs}ms waiting for ${lockPath} ` +
            `(held but not yet stale at ${staleMs}ms)`
        );
      }
      await sleep(pollMs);
    }
  }
}

export function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// Runs `fn` while holding the lock, releasing it in `finally` so a failed
// login (network error, thrown assertion, whatever) can never leave the lock
// held for the full staleMs window when releasing it immediately is free.
export async function withSessionLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: SessionLockOptions = {}
): Promise<T> {
  await acquireLock(lockPath, opts);
  try {
    return await fn();
  } finally {
    releaseLock(lockPath);
  }
}
