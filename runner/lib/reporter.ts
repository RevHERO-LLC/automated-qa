// Vitest reporter that emits a markdown + JSON test report.
// Writes to <reportRoot>/report.md, <reportRoot>/report.json,
// and the rolling pointer <reportRoot>/../latest.md.
//
// In Phase 3 the reporter additionally posts to Slack and opens GitHub Issues,
// gated on env.GITHUB_TOKEN / env.SLACK_WEBHOOK_QA being set. Phase 1 only
// exercises the file-output path.
//
// Runs in vitest's main process — .env is NOT loaded there by the test
// setup file. Load it ourselves so QA_REPORT_DIR + GITHUB/SLACK env vars
// resolve correctly even if the parent shell didn't export them.
import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import {
  buildQaSummaryMessage,
  ensureIssueOpen,
  closeIssueIfOpen,
  failureIssueTitle,
  postSlack,
  type RunSummary,
  type TestResult
} from "@revhero/qa-shared";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

function reportRoot(): string {
  const runId = process.env.QA_RUN_ID || `local-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const baseDir = process.env.QA_REPORT_DIR || "./reports";
  const root = path.resolve(baseDir, runId);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, "screenshots"), { recursive: true });
  fs.mkdirSync(path.join(root, "traces"), { recursive: true });
  return root;
}

function reportLatestDir(): string {
  return path.resolve(process.env.QA_REPORT_DIR || "./reports");
}

function getRunId(): string {
  return (
    process.env.QA_RUN_ID ||
    `local-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`
  );
}

type CaseRecord = {
  id: string;
  description: string;
  status: TestResult["status"];
  duration_ms: number;
  error?: string;
  file_path: string;
  test_path: string;
};

const TEST_ID_REGEX = /^(FE-[A-Z]+(?:-[A-Z]+)*-\d{3})\b/;

export default class QaReporter {
  private startedAt = "";
  private finishedAt = "";
  private results: CaseRecord[] = [];

  onInit(): void {
    this.startedAt = new Date().toISOString();
  }

  // Vitest 2.x calls onFinished(files, errors). The shape is loosely typed
  // in different sub-versions, so we treat everything as `any` and walk the
  // task tree defensively.
  onFinished(files?: any[], _errors?: any[]): void | Promise<void> {
    this.finishedAt = new Date().toISOString();
    try {
      if (Array.isArray(files)) {
        for (const f of files) {
          const fp = (f && (f.filepath || f.name)) || "unknown";
          this.collect(f, fp);
        }
      }
    } catch (err) {
      console.error("[reporter] collect error:", err);
    }
    return this.write();
  }

  private collect(task: any, filePath: string, parentName: string = ""): void {
    if (!task) return;
    if (task.type === "suite" && Array.isArray(task.tasks)) {
      const fullName = parentName ? `${parentName} > ${task.name ?? ""}` : (task.name ?? "");
      for (const child of task.tasks) this.collect(child, filePath, fullName);
      return;
    }
    if (task.type !== "test") return;
    const name = task.name ?? "";
    const idMatch = name.match(TEST_ID_REGEX);
    const id = idMatch ? idMatch[1]! : `UNKNOWN-${Math.random().toString(36).slice(2, 8)}`;
    const description = name.replace(TEST_ID_REGEX, "").replace(/^[\s—:-]+/, "").trim();
    const taskState = task.result?.state;
    let status: TestResult["status"] = "FAIL";
    if (taskState === "pass") status = "PASS";
    else if (taskState === "skip") status = "SKIP";
    else if (taskState === "todo") status = "NOT_EXEC";
    else if (taskState === "fail") status = "FAIL";
    else status = "NOT_EXEC";

    const duration_ms = task.result?.duration ?? 0;
    const errors = task.result?.errors;
    const error = Array.isArray(errors)
      ? errors.map((e: any) => e?.message ?? String(e)).join("\n")
      : undefined;

    const record: CaseRecord = {
      id,
      description,
      status,
      duration_ms,
      file_path: filePath,
      test_path: parentName ? `${parentName} > ${name}` : name
    };
    if (error) record.error = error;
    this.results.push(record);
  }

  private async write(): Promise<void> {
    try {
      const root = reportRoot();
      const summary = this.buildSummary();
      const md = this.renderMarkdown(summary);
      const json = JSON.stringify({ summary, results: this.results }, null, 2);

      fs.writeFileSync(path.join(root, "report.md"), md, "utf8");
      fs.writeFileSync(path.join(root, "report.json"), json, "utf8");

      const latestDir = reportLatestDir();
      fs.mkdirSync(latestDir, { recursive: true });
      fs.writeFileSync(path.join(latestDir, "latest.md"), md, "utf8");
      fs.writeFileSync(path.join(latestDir, "latest.json"), json, "utf8");

      const slackUrl = process.env.SLACK_WEBHOOK_QA;
      if (slackUrl) {
        try {
          // Compute severity breakdown of the FAILures by joining results
          // against registry.json. Lets the headline say "0 CRITICAL —
          // deploys NOT blocked" instead of the previous misleading
          // "N/total CRITICAL" hardcoded string.
          const severityCounts = this.severityCountsForFailures();
          await postSlack(slackUrl, buildQaSummaryMessage(summary, undefined, severityCounts));
        } catch (err) {
          console.error("[reporter] Slack post failed:", err);
        }
      }
      const ghToken = process.env.GITHUB_TOKEN;
      const ghRepo = process.env.GITHUB_REPO || "RevHERO-LLC/automated-qa";
      if (ghToken) {
        try {
          await this.postIssues(ghRepo);
        } catch (err) {
          console.error("[reporter] GitHub Issue sync failed:", err);
        }
      }
    } catch (err) {
      console.error("[reporter] write error:", err);
    }
  }

  private async postIssues(repo: string): Promise<void> {
    for (const r of this.results) {
      const title = failureIssueTitle(r.id, r.description);
      if (r.status === "FAIL") {
        await ensureIssueOpen({
          repo,
          title,
          body: this.buildIssueBody(r),
          labels: ["qa-fail", `area:${this.areaForId(r.id)}`]
        });
      } else if (r.status === "PASS") {
        await closeIssueIfOpen(repo, title, "Closed automatically — test now passing.");
      }
    }
  }

  private buildIssueBody(r: CaseRecord): string {
    return [
      `**Test ID:** ${r.id}`,
      `**Description:** ${r.description}`,
      `**Test path:** ${r.test_path}`,
      `**Source file:** \`${path.relative(process.cwd(), r.file_path)}\``,
      `**Duration:** ${r.duration_ms}ms`,
      "",
      "### Error",
      "```",
      r.error ?? "<no error captured>",
      "```",
      "",
      `_Auto-opened by automated-qa run ${getRunId()}._`
    ].join("\n");
  }

  private areaForId(id: string): string {
    return id.replace(/-\d{3}$/, "").toLowerCase();
  }

  // Joins the run's FAILures with registry.json severity. Falls back to
  // counting everything as "medium" if the registry can't be loaded —
  // we'd rather post a slightly-fuzzy summary than silently fail.
  private severityCountsForFailures(): { critical: number; high: number; medium: number; low: number } {
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    let registry: { entries: { id: string; severity?: string }[] } | null = null;
    try {
      const candidates = [
        path.resolve(process.cwd(), "registry.json"),
        path.resolve(process.cwd(), "../registry.json"),
        path.resolve(__dirname, "../../../registry.json"),
        path.resolve(__dirname, "../../registry.json")
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          registry = JSON.parse(fs.readFileSync(p, "utf8"));
          break;
        }
      }
    } catch (err) {
      console.error("[reporter] registry.json load failed (severity fallback):", err);
    }
    const sevById = new Map<string, string>();
    if (registry?.entries) {
      for (const e of registry.entries) sevById.set(e.id, e.severity ?? "medium");
    }
    for (const r of this.results) {
      if (r.status !== "FAIL") continue;
      const sev = (sevById.get(r.id) ?? "medium") as keyof typeof counts;
      if (sev in counts) counts[sev]++;
      else counts.medium++;
    }
    return counts;
  }

  private buildSummary(): RunSummary {
    const total = this.results.length;
    const passed = this.results.filter((r) => r.status === "PASS").length;
    const failed = this.results.filter((r) => r.status === "FAIL").length;
    const skipped = this.results.filter((r) => r.status === "SKIP").length;
    const not_exec = this.results.filter((r) => r.status === "NOT_EXEC").length;
    return {
      run_id: getRunId(),
      started_at: this.startedAt,
      finished_at: this.finishedAt,
      total,
      passed,
      failed,
      skipped,
      not_exec,
      flaky: 0,
      results: this.results.map((r) => {
        const tr: TestResult = {
          id: r.id,
          status: r.status,
          duration_ms: r.duration_ms
        };
        if (r.error) tr.error = r.error;
        return tr;
      })
    };
  }

  private renderMarkdown(summary: RunSummary): string {
    const lines: string[] = [];
    lines.push(`# RevHero QA Run — ${summary.run_id}`);
    lines.push("");
    lines.push(`**Started:** ${summary.started_at}`);
    lines.push(`**Finished:** ${summary.finished_at}`);
    lines.push("");
    lines.push("## Summary");
    lines.push("");
    lines.push("| | Count |");
    lines.push("|---|---|");
    lines.push(`| Total | ${summary.total} |`);
    lines.push(`| PASS | ${summary.passed} |`);
    lines.push(`| FAIL | ${summary.failed} |`);
    lines.push(`| SKIP | ${summary.skipped} |`);
    lines.push(`| NOT_EXEC | ${summary.not_exec} |`);
    lines.push("");
    lines.push("## Results");
    lines.push("");
    lines.push("| ID | Status | Duration | Description |");
    lines.push("|---|---|---|---|");
    const sorted = [...this.results].sort((a, b) => a.id.localeCompare(b.id));
    for (const r of sorted) {
      const status = r.status === "PASS" ? "PASS" : r.status === "FAIL" ? "FAIL" : r.status === "SKIP" ? "SKIP" : "NOT_EXEC";
      const desc = r.description.length > 90 ? r.description.slice(0, 87) + "..." : r.description;
      lines.push(`| \`${r.id}\` | ${status} | ${r.duration_ms}ms | ${escapeMd(desc)} |`);
    }
    const failures = sorted.filter((r) => r.status === "FAIL");
    if (failures.length > 0) {
      lines.push("");
      lines.push("## Failures");
      for (const f of failures) {
        lines.push("");
        lines.push(`### ${f.id} — ${escapeMd(f.description)}`);
        lines.push("");
        lines.push("```");
        lines.push(f.error ?? "<no error captured>");
        lines.push("```");
      }
    }
    lines.push("");
    return lines.join("\n");
  }
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
