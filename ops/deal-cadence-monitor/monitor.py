#!/usr/bin/env python3
"""
Deal-cadence + table-growth monitor (deal-scale early-warning).

READ-ONLY. Runs a few SELECT COUNT / size queries against the prod campaign DB
once a day and posts a Slack alert ONLY when a threshold is breached:

  * import cadence  — a single day's `deals` inserts exceed DAILY_INSERT_ALERT
                      (the lead-gen / bulk-import inflection the deal-scale audit
                      flagged: growth here is episodic bulk imports, not organic).
  * table growth    — any watched table crosses its size band (the co-inflating
                      cluster: deals, deal_configurations, deal_activities,
                      request_status — request_status is the first to hit ~5GB
                      at a 2.0-style 23x).

Every run logs the current numbers (to stdout / the Actions log) for liveness,
whether or not it alerts — so an absence of Slack noise is not "is it running?"
ambiguity: check the workflow run history.

Environment
-----------
DB_DSN         (required) Postgres DSN for a READ-ONLY role, over the WG address:
               postgresql://deal_monitor_ro:***@10.8.0.4:5432/revhero_prod_campaign
SLACK_WEBHOOK  (optional) Slack incoming-webhook URL. If unset, alerts are logged
               only (never fatal — a monitor must not page because paging is down).
TEST_ALERT     (optional) "true" forces one Slack post regardless of thresholds,
               to validate the Slack path from a manual workflow_dispatch.

Exit codes
----------
0 — success (including "threshold breached, alert sent" and "all nominal").
1 — systemic failure (DB unreachable, missing DB_DSN, unhandled exception).
    A failed Slack post is logged, NOT fatal.
"""

import json
import logging
import os
import sys
import urllib.request

import psycopg2

# ---------------------------------------------------------------------------
# Thresholds (tune here). MB → bytes for the size bands.
# ---------------------------------------------------------------------------
DAILY_INSERT_ALERT = 5000  # a single day's `deals` inserts above this => alert

MB = 1024 * 1024
SIZE_BANDS = {  # table -> alert-above bytes (current size in comment, 2026-07-23)
    "deals": 500 * MB,                 # ~49 MB now
    "deal_configurations": 500 * MB,   # ~25 MB now
    "deal_activities": 300 * MB,       # ~13 MB now
    "request_status": 1024 * MB,       # ~218 MB now — first to hit ~5GB at 23x
}

# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
    stream=sys.stdout,
)
log = logging.getLogger("deal-cadence-monitor")


def _require_env(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        log.error("Required environment variable %s is not set or empty.", name)
        sys.exit(1)
    return val


DB_DSN = _require_env("DB_DSN")
SLACK_WEBHOOK = os.environ.get("SLACK_WEBHOOK", "").strip()
TEST_ALERT = os.environ.get("TEST_ALERT", "false").strip().lower() == "true"


# ---------------------------------------------------------------------------
# Queries (READ-ONLY)
# ---------------------------------------------------------------------------
# Per-day `deals` insert counts for the last 2 full days + today-so-far, so a
# bulk-import day is caught regardless of exactly when the cron fires.
_INSERTS_BY_DAY_SQL = """
SELECT (created_at AT TIME ZONE 'UTC')::date AS d, COUNT(*) AS n
FROM deals
WHERE created_at >= (now() AT TIME ZONE 'UTC')::date - INTERVAL '2 days'
GROUP BY 1
ORDER BY 1;
"""

# Largest tenant on the peak day, for alert context.
_TOP_TENANT_SQL = """
SELECT owner_account_id, COUNT(*) AS n
FROM deals
WHERE (created_at AT TIME ZONE 'UTC')::date = %(day)s
GROUP BY owner_account_id
ORDER BY n DESC
LIMIT 1;
"""

_TABLE_SIZES_SQL = """
SELECT c.relname, pg_total_relation_size(c.oid) AS bytes
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = ANY(%(tables)s);
"""


def _human(nbytes: int) -> str:
    v = float(nbytes)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if v < 1024 or unit == "TB":
            return f"{v:.0f}{unit}" if unit == "B" else f"{v:.1f}{unit}"
        v /= 1024
    return f"{nbytes}B"


def post_slack(text: str) -> None:
    if not SLACK_WEBHOOK:
        log.warning("SLACK_WEBHOOK unset — alert not delivered. Message was:\n%s", text)
        return
    try:
        req = urllib.request.Request(
            SLACK_WEBHOOK,
            data=json.dumps({"text": text}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=15)
        log.info("Slack alert delivered.")
    except Exception as exc:  # never fatal — a monitor must not die because paging is down
        log.warning("Slack post failed (non-fatal): %s", exc)


def main() -> int:
    log.info(
        "Deal-cadence monitor starting | daily_insert_alert=%d test_alert=%s",
        DAILY_INSERT_ALERT,
        TEST_ALERT,
    )

    try:
        conn = psycopg2.connect(DB_DSN)
        conn.autocommit = True  # read-only, no transaction needed
    except Exception as exc:
        log.error("Cannot connect to DB: %s", exc)
        return 1

    alerts: list[str] = []
    try:
        with conn.cursor() as cur:
            # --- import cadence --------------------------------------------
            cur.execute(_INSERTS_BY_DAY_SQL)
            by_day = cur.fetchall()  # [(date, n), ...]
            log.info("deals inserts by day (last 2d + today): %s",
                     ", ".join(f"{d}={n}" for d, n in by_day) or "(none)")

            peak_day, peak_n = (None, 0)
            for d, n in by_day:
                if n > peak_n:
                    peak_day, peak_n = d, n

            if peak_n > DAILY_INSERT_ALERT:
                top = "n/a"
                cur.execute(_TOP_TENANT_SQL, {"day": peak_day})
                row = cur.fetchone()
                if row:
                    top = f"owner_account_id={row[0]} ({row[1]})"
                alerts.append(
                    f"• *Import cadence*: {peak_n} deals inserted on {peak_day} "
                    f"(> {DAILY_INSERT_ALERT} threshold). Top tenant: {top}."
                )

            # --- table growth ----------------------------------------------
            cur.execute(_TABLE_SIZES_SQL, {"tables": list(SIZE_BANDS.keys())})
            sizes = dict(cur.fetchall())  # relname -> bytes
            log.info("watched table sizes: %s",
                     ", ".join(f"{t}={_human(sizes.get(t, 0))}" for t in SIZE_BANDS))

            for tbl, band in SIZE_BANDS.items():
                b = sizes.get(tbl)
                if b is not None and b > band:
                    alerts.append(
                        f"• *Table growth*: `{tbl}` is {_human(b)} "
                        f"(> {_human(band)} band)."
                    )
    except Exception as exc:
        log.error("Query failed: %s", exc)
        conn.close()
        return 1
    finally:
        conn.close()

    if alerts:
        msg = (
            ":rotating_light: *Deal-scale monitor* — threshold breach on prod "
            "`revhero_prod_campaign`:\n" + "\n".join(alerts) +
            "\n\nContext: growth here is episodic bulk imports; a sustained "
            "breach is the signal that the deferred deal-scale index/partition "
            "work (Downloads/deal-scale-audit doc) is now warranted."
        )
        post_slack(msg)
        log.info("SUMMARY | breached=%d alert_sent=%s", len(alerts), bool(SLACK_WEBHOOK))
    elif TEST_ALERT:
        post_slack(
            ":white_check_mark: *Deal-scale monitor* test run — path is working, "
            "no real breach. (TEST_ALERT=true)"
        )
        log.info("SUMMARY | breached=0 test_alert_sent=true")
    else:
        log.info("SUMMARY | breached=0 — all nominal, no alert.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
