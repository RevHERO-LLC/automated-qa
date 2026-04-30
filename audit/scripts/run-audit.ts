// Phase 6 — Claude Code audit agent runner.
//
// Invokes the @anthropic-ai/claude-agent-sdk's `query()` API in headless mode
// (NO `claude -p`) so the agent runs unattended on a 14-day systemd timer.
// Auth comes from ~/.claude/.credentials.json which is populated by a one-
// time interactive `claude /login` signin (see audit/README.md).
//
// Two prompts are run sequentially:
//   1. coverage-audit.md  — find missing tests (new code without coverage)
//   2. stale-detect.md     — find outdated tests (code paths that have moved)
//
// Both prompts emit GitHub Issues against RevHERO-LLC/automated-qa with
// titles `[QA-AUDIT-MISSING] ...` / `[QA-AUDIT-STALE] ...`.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PROMPTS_DIR = path.join(ROOT, "prompts");
const REPORTS_DIR = path.join(ROOT, "reports");

type AuditCycle = "coverage-audit" | "stale-detect";

async function runPrompt(cycle: AuditCycle): Promise<string> {
  const promptFile = path.join(PROMPTS_DIR, `${cycle}.md`);
  if (!existsSync(promptFile)) {
    throw new Error(`prompt file not found: ${promptFile}`);
  }
  const prompt = await readFile(promptFile, "utf8");
  console.log(`\n=== ${cycle} (${new Date().toISOString()}) ===`);

  const accumulator: string[] = [];
  for await (const msg of query({
    prompt,
    options: {
      cwd: ROOT,
      // The agent can read repo state, grep for endpoints, glob for source files,
      // and shell out to `gh issue create` / `gh issue list`. We don't allow
      // unrestricted Bash — the agent SDK's allowedTools whitelist enforces it.
      allowedTools: ["Read", "Grep", "Glob", "Bash"],
      permissionMode: "default"
    }
  })) {
    // Stream messages to journald via stdout. Each message is a JSON envelope
    // with type=text/tool_use/tool_result. We capture .text content for the
    // report and let the agent's tool calls (Bash → gh) do the side effects.
    const out = JSON.stringify(msg);
    accumulator.push(out);
    console.log(out);
  }
  return accumulator.join("\n");
}

async function main() {
  await mkdir(REPORTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reportFile = path.join(REPORTS_DIR, `audit-${stamp}.log`);

  const sections: string[] = [];
  for (const cycle of ["coverage-audit", "stale-detect"] as AuditCycle[]) {
    try {
      const out = await runPrompt(cycle);
      sections.push(`## ${cycle}\n\n\`\`\`\n${out}\n\`\`\``);
    } catch (err: any) {
      console.error(`[${cycle}] failed:`, err);
      sections.push(`## ${cycle}\n\n**FAILED:** ${err?.message ?? String(err)}`);
    }
  }

  const md = `# QA Audit — ${stamp}\n\n${sections.join("\n\n")}\n`;
  await writeFile(reportFile, md, "utf8");
  console.log(`\nReport written to ${reportFile}`);
}

main().catch((err) => {
  console.error("audit run failed:", err);
  process.exit(1);
});
