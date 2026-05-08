// Layer 3 reconciliation: every day, compare the last 24h of staging+main
// commits across every repo in audit/repos.json against changelog.changes.
// Any commit not represented in the changelog (and not opted-out via a
// [no-changelog] commit message tag) → open one [CHANGELOG-MISSED] GitHub
// Issue against RevHERO-LLC/automated-qa AND post one Slack ping.
//
// Dedup: issues are matched by title slug `[CHANGELOG-MISSED] <repo>@<sha>`,
// so re-running the cron within the window does not re-open.
//
// Auth: reads `GH_TOKEN` (issues:write + repo:read), `CHANGELOG_DB_URL`
// (postgres role with SELECT on changelog.changes only), and optionally
// `SLACK_WEBHOOK_CLAUDE_CHANGES`.

import { execSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REPORTS_DIR = path.join(ROOT, "reports");
const REPOS_JSON = path.resolve(ROOT, "..", "audit", "repos.json");
const SQL_FILE = path.join(ROOT, "sql", "missed-shas.sql");
const ISSUE_REPO = "RevHERO-LLC/automated-qa";
const LOOKBACK_HOURS = 24;
const BRANCHES = ["staging", "main"] as const;
const SKIP_COMMIT_TAG = "[no-changelog]";

type RepoEntry = { name: string; url: string; path: string };
type RepoConfig = { repos: RepoEntry[] };

interface CommitMeta {
  repo: string;
  sha: string;
  branch: string;
  author: string;
  message: string;
  htmlUrl: string;
  committedAt: string;
}

async function loadRepoConfig(): Promise<RepoConfig> {
  const raw = await readFile(REPOS_JSON, "utf8");
  return JSON.parse(raw) as RepoConfig;
}

function fetchRecentCommits(repoFullName: string, branch: string, sinceIso: string): CommitMeta[] {
  // Use `gh api` so we don't need to manage a separate Octokit dep.
  // Per-page is capped at 100; 24h windows on these repos never exceed that.
  const cmd = `gh api -H "Accept: application/vnd.github+json" "repos/${repoFullName}/commits?sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(sinceIso)}&per_page=100"`;
  let raw: string;
  try {
    raw = execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
    if (stderr.includes("Branch not found") || stderr.includes("404")) {
      return [];
    }
    console.warn(`[reconcile] gh api failed for ${repoFullName}@${branch}: ${stderr.slice(0, 200)}`);
    return [];
  }

  const items = JSON.parse(raw) as Array<{
    sha: string;
    html_url: string;
    commit: {
      author: { name?: string; email?: string; date: string };
      message: string;
    };
    author?: { login?: string } | null;
  }>;

  return items.map((c) => ({
    repo: repoFullName,
    sha: c.sha,
    branch,
    author: c.author?.login ?? c.commit.author.email ?? c.commit.author.name ?? "unknown",
    message: c.commit.message,
    htmlUrl: c.html_url,
    committedAt: c.commit.author.date,
  }));
}

function fullRepoName(repoEntry: RepoEntry): string {
  // `repos.json` records bare names; the canonical org-prefixed path matches
  // both the changelog.commit_shas keys we expect and `gh api` repo arguments.
  return `RevHERO-LLC/${repoEntry.name}`;
}

async function findMissedShas(client: pg.PoolClient, shas: string[]): Promise<Set<string>> {
  if (shas.length === 0) return new Set();
  const sql = await readFile(SQL_FILE, "utf8");
  const result = await client.query<{ sha: string }>(sql, [shas]);
  return new Set(result.rows.map((r) => r.sha));
}

function issueTitleFor(commit: CommitMeta): string {
  return `[CHANGELOG-MISSED] ${commit.repo}@${commit.sha.slice(0, 7)}`;
}

function issueExists(title: string): boolean {
  // gh issue list with the search query returns matching issues. We escape
  // double quotes in the title and search the open+closed scope so reruns
  // skip even if the issue was closed.
  const safeTitle = title.replace(/"/g, '\\"');
  const cmd = `gh issue list --repo ${ISSUE_REPO} --state all --search "${safeTitle} in:title" --json title --limit 5`;
  try {
    const raw = execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    const items = JSON.parse(raw) as Array<{ title: string }>;
    return items.some((i) => i.title === title);
  } catch (err) {
    console.warn(`[reconcile] gh issue list failed for "${title}":`, err);
    return false;
  }
}

function openIssue(commit: CommitMeta): boolean {
  const title = issueTitleFor(commit);
  if (issueExists(title)) {
    console.log(`[reconcile] dedup hit, skipping: ${title}`);
    return false;
  }

  const body = [
    `**Repo:** \`${commit.repo}\``,
    `**Branch:** \`${commit.branch}\``,
    `**SHA:** \`${commit.sha}\` ([commit](${commit.htmlUrl}))`,
    `**Author:** ${commit.author}`,
    `**Committed at:** ${commit.committedAt}`,
    "",
    "**Commit message:**",
    "```",
    commit.message,
    "```",
    "",
    "**Action:** This commit shipped to a tracked branch (staging or main) without a corresponding entry in `changelog.changes`. Either:",
    "1. Manually POST a record to `https://config.revhero.ai/api/claude-changes` describing the change, OR",
    "2. If this push intentionally bypassed the changelog (e.g. pure-revert, no-op, or self-bootstrap), close this issue with a comment so the dedup catches future runs.",
    "",
    "Detected by `automated-qa/reconcile/scripts/check-changelog-coverage.ts` (Layer 3 of Claude Changelog enforcement).",
  ].join("\n");

  const titleArg = title.replace(/"/g, '\\"');
  const bodyArg = body.replace(/"/g, '\\"');
  const cmd = `gh issue create --repo ${ISSUE_REPO} --title "${titleArg}" --body "${bodyArg}" --label changelog-missed`;
  try {
    const raw = execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    console.log(`[reconcile] opened issue: ${title} → ${raw.trim()}`);
    return true;
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
    // The label may not exist on first run — fall back to no-label.
    if (stderr.includes("could not add label")) {
      try {
        const raw = execSync(
          `gh issue create --repo ${ISSUE_REPO} --title "${titleArg}" --body "${bodyArg}"`,
          { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }
        );
        console.log(`[reconcile] opened issue (no label): ${title} → ${raw.trim()}`);
        return true;
      } catch (err2) {
        console.warn(`[reconcile] gh issue create failed for ${title}:`, err2);
        return false;
      }
    }
    console.warn(`[reconcile] gh issue create failed for ${title}:`, err);
    return false;
  }
}

async function postSlackSummary(missed: CommitMeta[]): Promise<void> {
  const webhook = process.env.SLACK_WEBHOOK_CLAUDE_CHANGES;
  if (!webhook) return;
  if (missed.length === 0) return;

  const lines = missed
    .slice(0, 10)
    .map((c) => `• \`${c.repo}@${c.sha.slice(0, 7)}\` on \`${c.branch}\` by ${c.author}`)
    .join("\n");
  const overflow = missed.length > 10 ? `\n…and ${missed.length - 10} more` : "";

  const message = {
    text: `:warning: ${missed.length} push(es) shipped without a Claude Changelog entry`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:warning: *${missed.length} push(es) shipped without a Claude Changelog entry* (last ${LOOKBACK_HOURS}h)`,
        },
      },
      { type: "section", text: { type: "mrkdwn", text: `${lines}${overflow}` } },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Issues opened in <https://github.com/${ISSUE_REPO}/issues?q=is%3Aissue+%5BCHANGELOG-MISSED%5D|automated-qa>. Layer 3 reconciliation, daily.`,
          },
        ],
      },
    ],
  };

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "<unreadable>");
      console.warn(`[reconcile] Slack webhook failed ${res.status}: ${txt.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn("[reconcile] Slack webhook threw:", err);
  }
}

async function main() {
  await mkdir(REPORTS_DIR, { recursive: true });

  const config = await loadRepoConfig();
  const sinceIso = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();

  const allCommits: CommitMeta[] = [];
  for (const repo of config.repos) {
    const fullName = fullRepoName(repo);
    for (const branch of BRANCHES) {
      const commits = fetchRecentCommits(fullName, branch, sinceIso);
      for (const c of commits) {
        if (c.message.includes(SKIP_COMMIT_TAG)) {
          continue;
        }
        allCommits.push(c);
      }
    }
  }

  console.log(`[reconcile] inspected ${allCommits.length} commits across ${config.repos.length} repos`);

  const missed: CommitMeta[] = [];
  if (allCommits.length > 0) {
    const pool = new pg.Pool({ connectionString: process.env.CHANGELOG_DB_URL, max: 2 });
    const client = await pool.connect();
    try {
      const shas = allCommits.map((c) => c.sha);
      const missedShas = await findMissedShas(client, shas);
      for (const c of allCommits) {
        if (missedShas.has(c.sha)) missed.push(c);
      }
    } finally {
      client.release();
      await pool.end();
    }
  }

  console.log(`[reconcile] ${missed.length} commit(s) missing changelog entries`);

  let openedCount = 0;
  for (const c of missed) {
    if (openIssue(c)) openedCount++;
  }

  await postSlackSummary(missed);

  const summary = {
    ran_at: new Date().toISOString(),
    lookback_hours: LOOKBACK_HOURS,
    repos_inspected: config.repos.length,
    commits_inspected: allCommits.length,
    missed_count: missed.length,
    issues_opened: openedCount,
    missed: missed.map((c) => ({
      repo: c.repo,
      sha: c.sha,
      branch: c.branch,
      author: c.author,
      url: c.htmlUrl,
    })),
  };
  const outFile = path.join(
    REPORTS_DIR,
    `reconcile-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  await writeFile(outFile, JSON.stringify(summary, null, 2));
  console.log(`[reconcile] report → ${outFile}`);
}

main().catch((err) => {
  console.error("[reconcile] FATAL:", err);
  process.exit(1);
});
