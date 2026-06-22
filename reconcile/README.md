# reconcile/ — Layer 3 Claude Changelog enforcement

Daily systemd timer on VPS2 that compares the last 24h of staging+main commits across all 13 RevHero repos against `changelog.changes`. Any push that shipped without a corresponding changelog entry → one `[CHANGELOG-MISSED]` GitHub Issue + one Slack summary line.

It also runs a **self-healing auto-close sweep**: each run closes any open `[CHANGELOG-MISSED]` issue whose SHA has since been covered by a (late or backfilled) changelog record, so the queue clears itself instead of growing forever.

## Why three layers?

| Layer | Mechanism | Reliability | Catches |
|---|---|---|---|
| 1 | `~/.claude/CLAUDE.md` feedback rule + memory file | ~80% | Soft baseline; survives `/compact` |
| 2 | `~/.claude/hooks/post-push-reminder.ps1` PostToolUse hook | ~99% in-session | Reminds Claude immediately after `git push staging|main` |
| 3 | **THIS SCRIPT** — daily reconciliation cron | drift-detection | Catches whatever Layers 1+2 missed |

## How it works

1. `reconcile.sh` is invoked by `revhero-reconcile.service` (oneshot) on the `OnCalendar=*-*-* 09:00:00` daily timer.
2. The bash entry checks for `GH_TOKEN` and `CHANGELOG_DB_URL` then execs `pnpm exec tsx scripts/check-changelog-coverage.ts`.
3. The script reads `audit/repos.json` (shared with the audit agent — single source of truth for the 13 repos).
4. For each repo × {staging, main}, calls `gh api repos/RevHERO-LLC/<repo>/commits?since=<24h>&sha=<branch>` and parses results.
5. Commits whose message contains `[no-changelog]` are skipped (intentional opt-out for trivia).
6. Remaining SHAs are joined against `changelog.changes.commit_shas` (jsonb) — see `sql/missed-shas.sql`.
7. For each missed SHA: `gh issue create --repo RevHERO-LLC/automated-qa --title "[CHANGELOG-MISSED] <repo>@<sha>"`. The script first checks if an issue with the same title already exists in any state (open/closed) — if yes, dedup hits and we skip.
8. After all issues are opened, posts ONE Slack summary line to `SLACK_WEBHOOK_CLAUDE_CHANGES` if any were missed.
9. Writes `reports/reconcile-<iso-timestamp>.json` for journald + later inspection.
10. **Auto-close sweep (self-healing):** lists every OPEN `[CHANGELOG-MISSED]` issue, re-checks each SHA against `changelog.changes` via `sql/covered-shas.sql` (symmetric prefix match — title SHAs are short 7-char, stored values may be short or full), and closes the now-covered ones with a comment. Toggle off with `RECONCILE_AUTOCLOSE=0`. `RECONCILE_DRY_RUN=1` makes the entire run read-only (reports what it would open and close, writes nothing — no opens, closes, or Slack post). Results land in the JSON report under `autoclose`.

## Postgres role

A read-only `changelog_reader` role is provisioned with `SELECT` on `changelog.changes` only. The script uses this role; it cannot write or escalate even if the connection string leaks. The DSN lives in `/home/claude-audit/.env` next to the audit agent's `GH_TOKEN`.

## Operating

- **Manual run:** `sudo systemctl start revhero-reconcile.service` (foreground via `journalctl -u revhero-reconcile.service -f`).
- **Dry-run the whole reconciliation (read-only):** from `reconcile/` with `/home/claude-audit/.env` loaded, `RECONCILE_DRY_RUN=1 pnpm exec tsx scripts/check-changelog-coverage.ts` — lists what it would open and close without touching anything (no opens, closes, or Slack post).
- **Schedule check:** `systemctl list-timers | grep revhero-reconcile`.
- **Re-trigger after a missed-log:** open the issue, manually POST the record (or close the issue with `[no-changelog]` justification), then re-run.

## Bootstrap order

After Phase 4's prod cutover, this Phase 5 cron is intentionally LAST so the first run sees historical data instead of an empty table.
