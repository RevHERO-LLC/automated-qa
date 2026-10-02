// Proves lib/session-lock.ts's withSessionLock actually serializes the
// worker-side re-login path across real OS PROCESSES — not just async tasks
// inside one process — which is what fileParallelism (vitest.config.ts)
// requires: it runs test FILES as separate processes, so an in-process
// mutex would guard nothing between them.
//
// No network, no Playwright, no staging: the "login" is a 150ms sleep plus a
// local file write, and the thing under test is the filesystem lock itself.
import { describe, test, expect } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// Resolve tsx's CLI entry point rather than shelling out to the `tsx`/`.CMD`
// bin shim, so this works identically on Windows and Linux CI (Node 20,
// per .github/workflows/ci.yml) without depending on PATH or a shell.
const tsxCli = require.resolve("tsx/cli");
const workerScript = path.resolve(__dirname, "../support/lock-race-worker.ts");
const runnerRoot = path.resolve(__dirname, "../..");

function runWorker(sessionDir: string, mode: "locked" | "unlocked"): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, workerScript, sessionDir, mode], {
      cwd: runnerRoot,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`lock-race-worker exited ${code}${stderr ? `: ${stderr}` : ""}`));
    });
  });
}

async function raceWorkers(mode: "locked" | "unlocked", count: number): Promise<number> {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-lock-race-"));
  try {
    await Promise.all(Array.from({ length: count }, () => runWorker(sessionDir, mode)));
    const loginsLog = path.join(sessionDir, "logins.log");
    if (!fs.existsSync(loginsLog)) return 0;
    return fs.readFileSync(loginsLog, "utf8").split("\n").filter(Boolean).length;
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

describe("withSessionLock — cross-process login serialization (#qa-login-429)", () => {
  test("WITHOUT the lock, concurrent processes each log in independently (>1)", async () => {
    const logins = await raceWorkers("unlocked", 6);
    expect(logins).toBeGreaterThan(1);
  }, 20_000);

  test("WITH the lock, exactly one process logs in per role", async () => {
    const logins = await raceWorkers("locked", 6);
    expect(logins).toBe(1);
  }, 20_000);
});
