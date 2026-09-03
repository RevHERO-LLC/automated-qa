#!/usr/bin/env python3
"""
Send-pipeline health monitor — outbound-email early-warning.

READ-ONLY. A single SELECT against the prod email-ingress DB; posts a Slack
alert when the outbound send pipeline looks DOWN:

  * ACUTE — during a weekday ET business window, ZERO sends landed in the last
            STALL_MINUTES. Turns a silent multi-day send outage (e.g. the
            2026-09-03 Swarm overlay partition that killed all sends for ~6 days
            behind a generic "unexpected error") into a ~1-2h page instead of
            days.
  * DAILY — on a weekday, once past DAILY_CHECK_HOUR ET, today's total sends is
            still ZERO. A whole business morning with no outbound = broken.

Every run logs the numbers for liveness (absence of Slack noise is NOT "is it
running?" ambiguity — check the timer/journal). Debounced to <= 1 alert per
DEBOUNCE_HOURS via a marker file so an ongoing outage reminds without spamming.

DB access is via the `psql` client (postgresql-client), NOT psycopg2 — the VPS2
systemd host ships psql but has no psycopg2/pip. (The GHA-runner monitors in this
repo use psycopg2 because their runtime pip-installs it per run; this one runs on
a fixed host, so a zero-dependency client is the robust choice.)

Scope note: "sends" == rows in email_ingress.sent_emails (the dominant outbound
channel). A real pipeline outage takes email down too, so email is a faithful
proxy for "actions are flowing". Extend with an SMS table if a tenant ever goes
SMS-only.

Environment
-----------
DB_DSN         (required) Postgres DSN for a READ-ONLY role over WireGuard:
               postgresql://send_pipeline_ro:***@10.8.0.4:5432/revhero_prod_email_ingress
SLACK_WEBHOOK  (optional) Slack incoming-webhook URL. Unset => log-only (never fatal).
TEST_ALERT     (optional) "true" forces one Slack post regardless of state.
STATE_DIR      (optional) dir for the debounce marker (default: /tmp).

Exit codes: 0 = ran ok (alert sent or nominal). 1 = systemic (DB unreachable / bad env).
"""

import json
import logging
import os
import subprocess
import sys
import time
import urllib.request

# --- thresholds (env-overridable) ------------------------------------------
STALL_MINUTES = int(os.environ.get("STALL_MINUTES", "90"))
BIZ_START_ET = int(os.environ.get("BIZ_START_ET", "10"))  # weekday ET window [start, end)
BIZ_END_ET = int(os.environ.get("BIZ_END_ET", "16"))
DAILY_CHECK_HOUR = int(os.environ.get("DAILY_CHECK_HOUR", "13"))
DEBOUNCE_HOURS = float(os.environ.get("DEBOUNCE_HOURS", "2"))
STATE_DIR = os.environ.get("STATE_DIR", "/tmp")
MARKER = os.path.join(STATE_DIR, "send-pipeline-monitor.last-alert")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
    stream=sys.stdout,
)
log = logging.getLogger("send-pipeline-monitor")


def _require_env(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        log.error("Required environment variable %s is not set or empty.", name)
        sys.exit(1)
    return val


DB_DSN = _require_env("DB_DSN")
SLACK_WEBHOOK = os.environ.get("SLACK_WEBHOOK", "").strip()
TEST_ALERT = os.environ.get("TEST_ALERT", "false").strip().lower() == "true"

# One round-trip returns everything. Weekday (ISO 1=Mon..7=Sun) and hour are
# evaluated in America/New_York so the business-window logic is correct
# regardless of the host clock/TZ. STALL_MINUTES is an int (parsed above), so
# inlining it is injection-safe.
_METRICS_SQL = f"""
SELECT
  EXTRACT(ISODOW FROM now() AT TIME ZONE 'America/New_York')::int,
  EXTRACT(HOUR  FROM now() AT TIME ZONE 'America/New_York')::int,
  (SELECT count(*) FROM sent_emails
     WHERE created_at > now() - ({STALL_MINUTES} * INTERVAL '1 minute')),
  (SELECT count(*) FROM sent_emails
     WHERE (created_at AT TIME ZONE 'America/New_York')::date
         = (now() AT TIME ZONE 'America/New_York')::date);
"""


def _fetch_metrics() -> "tuple[int, int, int, int]":
    """(dow, et_hour, sends_last_window, sends_today) via psql. Raises on failure."""
    proc = subprocess.run(
        ["psql", DB_DSN, "-tA", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", _METRICS_SQL],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"psql rc={proc.returncode}: {proc.stderr.strip()[:300]}")
    parts = proc.stdout.strip().split("|")
    if len(parts) != 4:
        raise RuntimeError(f"unexpected psql output: {proc.stdout!r}")
    return tuple(int(p) for p in parts)  # type: ignore[return-value]


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


def _debounced() -> bool:
    """True if we already alerted within DEBOUNCE_HOURS (suppress a repeat)."""
    try:
        last = os.path.getmtime(MARKER)
    except OSError:
        return False
    return (time.time() - last) < DEBOUNCE_HOURS * 3600


def _stamp() -> None:
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(MARKER, "w") as fh:
            fh.write(str(int(time.time())))
    except OSError as exc:
        log.warning("Could not write debounce marker %s: %s", MARKER, exc)


def main() -> int:
    log.info(
        "Send-pipeline monitor starting | stall_min=%d biz_et=[%d,%d) daily_hr=%d test=%s",
        STALL_MINUTES, BIZ_START_ET, BIZ_END_ET, DAILY_CHECK_HOUR, TEST_ALERT,
    )
    try:
        dow, et_hour, sends_window, sends_today = _fetch_metrics()
    except Exception as exc:
        log.error("DB query failed: %s", exc)
        return 1

    is_weekday = 1 <= dow <= 5
    log.info(
        "STATE | dow=%d et_hour=%d weekday=%s sends_last_%dm=%d sends_today=%d",
        dow, et_hour, is_weekday, STALL_MINUTES, sends_window, sends_today,
    )

    alerts: "list[str]" = []
    if is_weekday:
        if BIZ_START_ET <= et_hour < BIZ_END_ET and sends_window == 0:
            alerts.append(
                f"• *Pipeline DOWN (acute)*: 0 outbound emails in the last {STALL_MINUTES} min "
                f"during weekday business hours ({et_hour:02d}:00 ET). Healthy is hundreds/hr — "
                f"this is a send-pipeline outage (overlay partition / render failure / worker down)."
            )
        if et_hour >= DAILY_CHECK_HOUR and sends_today == 0:
            alerts.append(
                f"• *Zero actions today*: 0 outbound emails sent so far today "
                f"(weekday, {et_hour:02d}:00 ET) — a whole business morning with no outbound."
            )

    if alerts:
        if _debounced() and not TEST_ALERT:
            log.info(
                "SUMMARY | breach but debounced (alerted within %.1fh) — not re-paging.",
                DEBOUNCE_HOURS,
            )
            return 0
        msg = (
            ":rotating_light: *Send-pipeline monitor* — prod outbound email looks DOWN:\n"
            + "\n".join(alerts)
            + "\n\nCheck: overlay routing revhero-web <-> revhero-workers (VXLAN FDB), "
            "email-ingress `/v1/templates/render`, deal-mover worker + sweeper. "
            "Runbook: memory `reference_overlay_users_service_partition.md`."
        )
        post_slack(msg)
        _stamp()
        log.info("SUMMARY | breached=%d alert_sent=%s", len(alerts), bool(SLACK_WEBHOOK))
        return 0

    if TEST_ALERT:
        post_slack(
            ":white_check_mark: *Send-pipeline monitor* test run — Slack path OK, no real breach "
            f"(sends_last_{STALL_MINUTES}m={sends_window}, sends_today={sends_today}, TEST_ALERT=true)."
        )
        log.info("SUMMARY | breached=0 test_alert_sent=true")
    else:
        log.info("SUMMARY | breached=0 — pipeline nominal, no alert.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
