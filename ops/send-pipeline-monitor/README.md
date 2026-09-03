# send-pipeline-monitor

Outbound-email early-warning. A read-only cron that pages Slack when the RevHero
send pipeline looks **down** — so a silent outage is caught in ~1–2h instead of
days.

## Why it exists

On **2026-09-03** a Docker Swarm overlay partition (revhero-web could not reach
prod campaign-service over the VXLAN) silently killed **all** outbound email for
**~6 days** — every `/v1/actions/trigger` 500'd behind a generic *"An unexpected
error occurred."* Nothing alerted; it surfaced only when a customer (Velero)
asked why their campaigns weren't sending. Fleet impact at discovery: 203k+ due
deals across 11 tenants, deal-movement 27k/day → ~0.

Nothing in the fleet watched the one metric that would have caught it in minutes:
**are emails actually going out?** This does.

## What it checks (against prod `revhero_prod_email_ingress.sent_emails`)

- **ACUTE** — weekday, ET business window `[BIZ_START_ET, BIZ_END_ET)`, and **zero
  sends in the last `STALL_MINUTES`** → alert. Healthy business hours run
  hundreds/hr, so zero is unambiguous. (Default window 10:00–16:00 ET, 90 min.)
- **DAILY** — weekday, past `DAILY_CHECK_HOUR` ET, and **today's total sends is
  still zero** → alert. A whole business morning with no outbound is broken.

Quiet nights/weekends do **not** alert (active-hours legitimately pause sends).
Every run logs the numbers for liveness; alerts are debounced to ≤ 1 per
`DEBOUNCE_HOURS`.

## Deploy (systemd timer on VPS2 — survives a GitHub Actions outage)

```sh
sudo bash ops/send-pipeline-monitor/install.sh
# then fill in real values:
sudo vi /etc/revhero/send-pipeline-monitor.env   # DB_DSN + SLACK_WEBHOOK
sudo systemctl start send-pipeline-monitor.service
```

Runs every 30 min (`OnUnitActiveSec=30min`). DB access is a **dedicated read-only
role** `send_pipeline_ro` (SELECT on `sent_emails` only) over WireGuard
`10.8.0.4:5432` — same least-privilege pattern as `deal_monitor_ro`. Slack reuses
the org webhook (`SLACK_WEBHOOK_DEPLOYS`).

## Config (env)

| var | default | meaning |
|---|---|---|
| `DB_DSN` | — (required) | RO Postgres DSN over WG |
| `SLACK_WEBHOOK` | — | incoming webhook; unset ⇒ log-only |
| `STALL_MINUTES` | `90` | acute: zero sends in this window ⇒ alert |
| `BIZ_START_ET` / `BIZ_END_ET` | `10` / `16` | weekday ET business window |
| `DAILY_CHECK_HOUR` | `13` | daily: after this ET hour, today=0 ⇒ alert |
| `DEBOUNCE_HOURS` | `2` | min gap between repeat alerts |
| `TEST_ALERT` | `false` | `true` forces one Slack post (validate the path) |

## Runbook when it fires

Check overlay routing revhero-web ↔ revhero-workers (VXLAN FDB `dst` entries),
email-ingress `/v1/templates/render`, and the deal-mover worker + sweeper.
Full diagnosis + fix: project memory `reference_overlay_users_service_partition.md`.
