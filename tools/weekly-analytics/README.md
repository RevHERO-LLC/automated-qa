# Weekly Analytics Report

Internal **client-health digest**. Every Monday, for the previous complete calendar week
(Mon–Sun), it collects every active client's analytics, red-flags metrics that moved off
their prior-4-week trend, renders one self-contained HTML document, and posts it to Slack
channel **`C0C2YB9SDB2`** (HTML file upload + a Block Kit summary of the flagged clients).

It is a **read-only consumer** of analytics that already exist — it changes no prod service.

## Pipeline

| Step | File | What it does |
|------|------|--------------|
| collect | `collect.py` | READ-ONLY. Enumerates active tenants (`revhero_prod_users`), SUMs `public.daily_analytics_snapshots` per `parent_user_id` for the report week + prior 4 weeks, computes red flags + derived KPIs, emits the run JSON. |
| render | `render.py` | Pure `data JSON → self-contained HTML` on stdout. Deterministic (no baked clock), theme-aware, inline CSS. Supports diff mode (`render.py cur.json prev.json`). |
| post | `post_slack.py` | Uploads the HTML via Slack's modern external-upload flow + posts a Block Kit summary. `--dry-run` to preview. |
| schedule | `../../.github/workflows/weekly-analytics-report.yml` | Self-hosted GHA cron (Mon 13:00 UTC) wiring the three together. |

`schema.json` documents the run-JSON contract; `sample.json` is a fixture exercising every
render state; `runs/` is the append-only per-run store (also uploaded as a GHA artifact).

## Run locally

```bash
pip install psycopg2-binary requests
export ANALYTICS_DB_DSN='postgresql://revhero:<pw>@10.8.0.4:5432/revhero_prod_analytics'
export USERS_DB_DSN='postgresql://revhero:<pw>@10.8.0.4:5432/revhero_prod_users'
python collect.py --out runs/2026-09-07.json            # previous complete week (or --week-start YYYY-MM-DD)
python render.py runs/2026-09-07.json > report.html      # open in a browser
SLACK_ANALYTICS_BOT_TOKEN='xoxb-...' \
  python post_slack.py --data runs/2026-09-07.json --html report.html --channel C0C2YB9SDB2 --dry-run
```

The DB is reachable only over the WireGuard overlay (`10.8.0.4`) — from a WG-connected box
(the self-hosted runner) or the DB VPS itself (`ssh root@194.140.198.15`, DSN host `127.0.0.1`).

## Red-flag rule (constants at the top of `collect.py`, tunable)

Per client, per health-critical metric: baseline = trailing **4-week average** (over weeks
with activity). Flag when this week moves **≥ 30%** in the unhealthy direction —
**down**: `sends / replies / positive_sentiment / meetings_booked / revenue`;
**up**: `negative_sentiment / blocked`. Min-volume floor: skip metrics whose baseline is
below **10 sends / 3 replies**. **Dropped-to-zero** (prior activity, 0 this week) is a hard
flag. Clients with **< 2** active baseline weeks render without flags ("new").

## Completeness guard (important)

Snapshot rows are **sparse** (no row for a zero-activity day), so a per-client "7 days
expected" check is unreliable. Instead a **global guard** suppresses ALL flags + shows a red
alert banner when the report week looks like an incomplete precalc:
- **day-coverage**: the week has ≥ 2 fewer distinct snapshot-days than a full baseline week
  (table-level day coverage is reliable — with ~10+ active tenants every real day gets ≥1 row); or
- **volume**: report-week send volume < 35% of the trailing weekly average.

This prevents a broken/late precalc from firing false churn alerts across every client.
Known limitation: if the precalc were *chronically* broken (all baseline weeks also
incomplete) the day-coverage guard adapts downward; the volume guard is the backstop.

## Required repo secrets (automated-qa) — set 2026-09-15

| Secret | Value |
|--------|-------|
| `ANALYTICS_DB_DSN` | `postgresql://revhero:<pw>@10.8.0.4:5432/revhero_prod_analytics` |
| `USERS_DB_DSN` | `postgresql://revhero:<pw>@10.8.0.4:5432/revhero_prod_users` |
| `SLACK_ANALYTICS_BOT_TOKEN` | bot `salesnotification` xoxb token (needs `files:write` + `chat:write`; must be a member of the channel) |
| `SLACK_WEBHOOK_DEPLOYS` | (pre-existing) fallback text alert on job failure |

The channel id (`C0C2YB9SDB2`) is not secret — it lives in the workflow `env`.

## Notes / deviations from the original plan

- Table is **`public.daily_analytics_snapshots`**, not `internal_analytics.*` (verified live).
- Tenant totals = SUM grouped by `parent_user_id`, **no `owner_account_id` filter** (matches
  the dashboard's `account_id=0`; no double-count — the row grain is unique on the sextuple).
- The scheduled run **uploads `runs/<week>.json` as a 90-day artifact** rather than
  git-committing to `main` (this repo is PR-only for `main`). Local/manual runs may commit to
  `runs/` via a PR if a longer history is wanted; diff mode then works across two run files.
- `revenue_generated` is whole dollars; `blocked_sms` is always 0; `emails_opened` has no
  dashboard surface (not shown).

## Live issue surfaced by the first run (2026-09-15)

The prod analytics precalc was **missing Sep 10–13 2026** (only 3 of 7 days written for the
Sep 7–13 week) — a real pipeline gap. The completeness guard suppressed flags and flagged it
in the report. That precalc reliability is a separate prod issue (pg_cron / partition class).
