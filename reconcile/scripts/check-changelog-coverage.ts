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
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { writeFileSync, unlinkSync } from "node:fs";
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
// Optional: ISO timestamp; commits authored before this are skipped even if
// they fall in the LOOKBACK_HOURS window. Useful right after the changelog
// rollout to avoid flooding the issues queue with historical pushes.
const SINCE_FLOOR = process.env.RECONCILE_SINCE_FLOOR_ISO;

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
  // GitHub's search query parser eats bracket characters in `[CHANGELOG-MISSED]`,
  // so we search by the unique SHA prefix slug and filter in JS.
  const shaSlug = title.split("@")[1] ?? title;
  const query = `${shaSlug} in:title`;
  const cmd = `gh issue list --repo ${ISSUE_REPO} --state all --search ${shellQuote(query)} --json title --limit 10`;
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

  // Use --body-file via a temp file. Inline --body breaks on backticks,
  // dollar signs, parentheses, and other shell metacharacters that
  // routinely appear in commit messages.
  const bodyFile = path.join(REPORTS_DIR, `body-${commit.sha.slice(0, 7)}-${Date.now()}.md`);
  try {
    writeFileSync(bodyFile, body, "utf8");
  } catch (err) {
    console.warn(`[reconcile] failed to write body file for ${title}:`, err);
    return false;
  }

  const tryCreate = (withLabel: boolean): { ok: boolean; stderr: string } => {
    const labelArg = withLabel ? ' --label changelog-missed' : "";
    const cmd = `gh issue create --repo ${ISSUE_REPO} --title ${shellQuote(title)} --body-file ${shellQuote(bodyFile)}${labelArg}`;
    try {
      const raw = execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
      console.log(`[reconcile] opened issue${withLabel ? "" : " (no label)"}: ${title} → ${raw.trim()}`);
      return { ok: true, stderr: "" };
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
      return { ok: false, stderr };
    }
  };

  let result = tryCreate(true);
  if (!result.ok && result.stderr.includes("could not add label")) {
    result = tryCreate(false);
  }
  if (!result.ok) {
    console.warn(`[reconcile] gh issue create failed for ${title}: ${result.stderr.slice(0, 200)}`);
  }

  // Best-effort cleanup of the temp body file.
  try {
    unlinkSync(bodyFile);
  } catch {
    /* ignore */
  }
  return result.ok;
}

function shellQuote(value: string): string {
  // POSIX single-quote escape: wrap in single quotes, replace any internal
  // single quote with '\''. Safe for any string including those with
  // backticks, dollars, parens, etc.
  return `'${value.replace(/'/g, "'\\''")}'`;
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
  const lookbackIso = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
  const sinceIso =
    SINCE_FLOOR && SINCE_FLOOR > lookbackIso ? SINCE_FLOOR : lookbackIso;
  if (SINCE_FLOOR) {
    console.log(`[reconcile] using SINCE_FLOOR=${SINCE_FLOOR} (lookback=${lookbackIso})`);
  }

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
