// Standalone script, run as a REAL CHILD OS PROCESS (via tsx — see
// tests/unit/session-lock.test.ts) rather than imported in-process. That's
// the point: vitest's fileParallelism runs test files as separate processes,
// so the only way to genuinely exercise "does this survive separate
// processes racing on the same role" is to actually spawn separate
// processes, not simulate concurrency with async callbacks inside one.
//
// Args: <sessionDir> <"locked"|"unlocked">
//   unlocked — the pre-fix shape: check-then-write with no coordination.
//   locked   — guarded by lib/session-lock.ts's withSessionLock, with the
//              same "double-check after acquiring" pattern as
//              fixtures/auth.ts's loginAs().
//
// Records one line per simulated login to <sessionDir>/logins.log so the
// test can assert on the total count across every worker process.
import * as fs from "node:fs";
import * as path from "node:path";
import { withSessionLock, lockPathFor } from "../../lib/session-lock.js";

const [, , sessionDirArg, modeArg] = process.argv;
if (!sessionDirArg || (modeArg !== "locked" && modeArg !== "unlocked")) {
  console.error("usage: lock-race-worker.ts <sessionDir> <locked|unlocked>");
  process.exit(2);
}
// Re-bind with explicit, non-optional types: the guard above proves these at
// runtime, but TS does not carry narrowing of a captured outer const into
// the nested function declarations below (ensureLoggedInLocked etc.), which
// could in principle be invoked long after this check — a plain annotation
// here is the standard way to hand them the narrowed type explicitly.
const sessionDir: string = sessionDirArg;
const mode: "locked" | "unlocked" = modeArg;

const ROLE = "admin";
const stateFile = path.join(sessionDir, `${ROLE}.json`);
const loginsLog = path.join(sessionDir, "logins.log");

async function fakeLoginAndPersist(): Promise<void> {
  // Simulate login latency — long enough that, in the "unlocked" control
  // case, every process spawned together is virtually certain to pass the
  // existsSync check before any of them finishes and writes the state file.
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.appendFileSync(loginsLog, "1\n");
  fs.writeFileSync(stateFile, JSON.stringify({ loggedInByPid: process.pid }));
}

async function ensureLoggedInUnlocked(): Promise<void> {
  if (fs.existsSync(stateFile)) return;
  await fakeLoginAndPersist();
}

async function ensureLoggedInLocked(): Promise<void> {
  const lockPath = lockPathFor(sessionDir, ROLE);
  await withSessionLock(lockPath, async () => {
    // Same double-check as auth.ts's loginAs(): another process may have
    // finished logging in while we were waiting for the lock.
    if (fs.existsSync(stateFile)) return;
    await fakeLoginAndPersist();
  });
}

(mode === "locked" ? ensureLoggedInLocked() : ensureLoggedInUnlocked())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
