// Vitest reporter that emits a markdown + JSON test report.
// Writes to <reportRoot>/report.md, <reportRoot>/report.json,
// and the rolling pointer <reportRoot>/../latest.md.
//
// In Phase 3 the reporter additionally posts to Slack and opens GitHub Issues,
// gated on env.GITHUB_TOKEN / env.SLACK_WEBHOOK_QA being set. Phase 1 only
// exercises the file-output path.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Reporter, File, Task } from "vitest";
import { getReportRoot, getRunId, getReportLatestDir, getEnv } from "./context.js";
import {
  buildQaSummaryMessage,
  ensureIssueOpen,
  closeIssueIfOpen,
  failureIssueTitle,
  postSlack,
  type RunSummary,
  type TestResult
} from "@revhero/qa-shared";

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

export default class QaReporter implements Reporter {
  private startedAt = "";
  private finishedAt = "";
  private results: CaseRecord[] = [];

  onInit(): void {
    this.startedAt = new Date().toISOString();
  }

  onFinished(files?: File[]): void {
    this.finishedAt = new Date().toISOString();
    if (files) {
      for (const f of files) {
        this.collect(f, f.filepath ?? f.name ?? "unknown");
      }
    }
    void this.write();
  }

  private collect(task: Task, filePath: string, parentName: string = ""): void {
    if (task.type === "suite" && task.tasks) {
      const fullName = parentName ? `${parentName} > ${task.name}` : task.name;
      for (const child of task.tasks) {
        this.collect(child, filePath, fullName);
      }
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
    const error = task.result?.errors?.map((e) => e.message ?? String(e)).join("\n");

    const record: CaseRecord = {
      id,
      description,
      status,
      duration_ms,
      file_path: filePath,
      test_path: parentName ? `${parentName} > ${name}` : name
    };
    if (error) {
      record.error = error;
    }
    this.results.push(record);
  }

  private async write(): Promise<void> {
    const root = getReportRoot();
    const summary = this.buildSummary();
    const md = this.renderMarkdown(summary);
    const json = JSON.stringify({ summary, results: this.results }, null, 2);

    fs.writeFileSync(path.join(root, "report.md"), md, "utf8");
    fs.writeFileSync(path.join(root, "report.json"), json, "utf8");

    const latestDir = getReportLatestDir();
    fs.mkdirSync(latestDir, { recursive: true });
    fs.writeFileSync(path.join(latestDir, "latest.md"), md, "utf8");
    fs.writeFileSync(path.join(latestDir, "latest.json"), json, "utf8");

    const env = getEnv();
    if (env.SLACK_WEBHOOK_QA) {
      try {
        await postSlack(env.SLACK_WEBHOOK_QA, buildQaSummaryMessage(summary));
      } catch (err) {
        console.error("Slack post failed:", err);
      }
    }
    if (env.GITHUB_TOKEN && env.GITHUB_REPO) {
      try {
        await this.postIssues(env.GITHUB_REPO);
      } catch (err) {
        console.error("GitHub Issue sync failed:", err);
      }
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
      const status = r.status === "PASS" ? "✅" : r.status === "FAIL" ? "❌" : r.status === "SKIP" ? "⏭️" : "⏸";
      const desc = r.description.length > 90 ? r.description.slice(0, 87) + "..." : r.description;
      lines.push(`| \`${r.id}\` | ${status} ${r.status} | ${r.duration_ms}ms | ${escapeMd(desc)} |`);
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
