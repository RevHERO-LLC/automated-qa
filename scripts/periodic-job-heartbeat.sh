#!/usr/bin/env bash
#
# periodic-job-heartbeat.sh — assert every known background job on prod actually ran.
#
# WHY THIS EXISTS (#269)
# ---------------------
# On 2026-09-11 a half-applied secret rotation broke every AI-personalized send for
# three days. Nothing crashed and nothing alarmed. Reviewing the backlog through that
# lens turned up FOUR separate background jobs that had silently stopped — swarm's
# reconcile pass, email-ingress's nightly token refresh, activity retention, and
# automated-qa's own email-drift-check. Every one was found by accident, by a human
# who happened to look.
#
# A periodic job that stops has no natural signal: the logs simply contain one fewer
# line, and nobody greps for a line that is absent. This script makes that absence
# the alarm.
#
# HOW IT DECIDES  (the part worth understanding before editing)
# -------------------------------------------------------------
# The naive check — "did the marker appear in the last N hours?" — FALSE-ALARMS on
# every redeploy. `docker service logs` is per-CONTAINER: when a service rolls, its
# log history restarts from zero. Measured on prod 2026-09-14, four of five services
# had less than an hour of history because they had been redeployed that afternoon,
# while the interval we wanted to assert was 24h. A monitor built that way would cry
# wolf after every deploy, get muted, and then be worth less than nothing.
#
# So the verdict is gated on CONTAINER UPTIME, giving three outcomes:
#
#   OK            marker seen inside the window                      -> job is alive
#   DEAD          marker ABSENT *and* container older than the        -> ALERT
#                 job's own interval (it has had a full chance to run)
#   INDETERMINATE marker absent but container younger than the        -> no alert,
#                 interval (it may simply not be due yet)                still printed
#
# INDETERMINATE is deliberately not an alert. A monitor that alarms when it does not
# know is the same failure as one that stays silent when it does.
#
# 🚨 IT MUST ALERT ON ITS OWN FAILURE. email-drift-check only Slacks when it FINDS
# drift, so when its credential went stale its HTTP 401 produced a red workflow that
# nobody watched — for three days. `set -euo pipefail` here plus an `if: failure()`
# Slack step in the calling workflow means this script dying is itself paged. A
# heartbeat monitor that fails silently manufactures false confidence, which is
# strictly worse than having no monitor at all.
#
# Runs on the self-hosted VPS2 runner, which is a swarm manager — hence plain
# `docker service logs` with no SSH hop or credential of its own.

set -uo pipefail

# Per-scan cap. `docker service logs --since 26h` can HANG INDEFINITELY: measured on prod
# 2026-09-14, a 26h scan of revhero-email-ingress-laa4mj never returned (killed at 10s) while
# `--since 2h` on the same service returned instantly. It is not task count (5 tasks) — the long
# window itself is pathological on a high-volume service.
#
# Without this cap the monitor wedges on job 2 of 6 and reports NOTHING, which is the exact
# silent failure it exists to catch: a hang is not a failure, so `if: failure()` never fires and
# the run just sits there until the CI job timeout. A capped scan that reports TIMEOUT is
# strictly better than a complete check that never finishes.
LOG_SCAN_TIMEOUT="${LOG_SCAN_TIMEOUT:-45}"

SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"
TEST_ALERT="${TEST_ALERT:-false}"

# job|service|marker|interval_minutes|log_window
#
# interval_minutes = how often the job SHOULD run; it is the uptime a container must
#   exceed before a missing marker is treated as death rather than "not due yet".
# log_window       = how far back to grep. Kept comfortably wider than the interval so
#   a job that runs slightly late is not mistaken for one that never ran.
#
# Markers were calibrated against live prod logs rather than read out of the source,
# because a marker that does not match what the DEPLOYED build prints is a monitor
# that is green for the wrong reason.
#
# Swarm agent reconcile IS now covered: #259 reached prod as b145a1c, which logs the
# cycle unconditionally including the all-zeros case. Before that, an idle cycle printed
# nothing at all — so "no marker" and "job dead" were the same observation, which is the
# bug #259 fixed. Verified on prod before adding this row: TWO distinct 'reconcile cycle
# complete' lines five minutes apart, because a boot-only run IS the failure mode here.
JOBS=(
  "activity-retention|revhero-activity-service-uxhhme|retention sweep removed|1440|26h"
  "email-token-refresh|revhero-email-ingress-laa4mj|agent-token-refresh|1440|26h"
  "siteforge-dispatcher|revhero-campaign-service-ydky5d|siteforge-dispatcher|10|30m"
  "siteforge-cleanup|revhero-campaign-service-ydky5d|siteforge-cleanup|60|3h"
  "dealmover-sweeper|revhero-deal-mover-vmzya0|Running sweeper|30|70m"
  "swarm-agent-reconcile|app-compress-bluetooth-sensor-pksr4y|reconcile cycle complete|5|20m"
)

# uptime_minutes <service> — minutes since the RUNNING task started.
#
# Uses `docker service ps`, not `docker ps` + inspect: the latter only sees containers
# on the local node, and on this cluster several of these services are scheduled
# elsewhere (it returned an empty uptime for activity-service and email-ingress when
# tried that way). `docker service ps` answers cluster-wide from any manager.
uptime_minutes() {
  local svc="$1" state
  state=$(docker service ps "$svc" \
            --filter desired-state=running \
            --format '{{.CurrentState}}' 2>/dev/null | head -1 || true)
  # e.g. "Running 45 minutes ago" / "Running 2 days ago" / "Running about an hour ago"
  [ -z "$state" ] && { echo "-1"; return; }
  local n unit
  n=$(echo "$state" | grep -oE '[0-9]+' | head -1 || true)
  unit=$(echo "$state" | grep -oE '(second|minute|hour|day|week|month)' | head -1 || true)
  # "about an hour ago" / "a minute ago" carry no digit
  [ -z "$n" ] && n=1
  case "$unit" in
    second) echo $(( n / 60 )) ;;
    minute) echo "$n" ;;
    hour)   echo $(( n * 60 )) ;;
    day)    echo $(( n * 1440 )) ;;
    week)   echo $(( n * 10080 )) ;;
    month)  echo $(( n * 43200 )) ;;
    *)      echo "-1" ;;
  esac
}

dead=()
indeterminate=()
ok=()

printf '%-22s %-40s %-9s %-9s %s\n' JOB SERVICE MARKER UPTIME VERDICT
printf '%s\n' "--------------------------------------------------------------------------------------------"

for row in "${JOBS[@]}"; do
  IFS='|' read -r job svc marker interval window <<< "$row"

  # grep -q -m1, NOT grep -c: we only need "did it run at least once", and -m1 lets grep exit
  # at the FIRST match so docker's stream is closed immediately. `grep -c` reads the entire
  # window even when the marker is on line one — on a high-volume service that is the whole
  # cost. This makes the HEALTHY path fast and leaves the slow full read only for the case
  # where the marker is genuinely absent, which is the case we are willing to spend time on.
  timeout "$LOG_SCAN_TIMEOUT" docker service logs "$svc" --since "$window" 2>&1     | grep -q -m1 -- "$marker"
  # Capture the WHOLE array in one statement: reading ${PIPESTATUS[0]} is itself a command and
  # clobbers PIPESTATUS, so ${PIPESTATUS[1]} would then be unset (and fatal under set -u).
  pipe=("${PIPESTATUS[@]}")
  scan_rc=${pipe[0]:-0}   # docker/timeout: 124 = the scan was capped
  grep_rc=${pipe[1]:-1}   # grep: 0 = marker found
  hits=0
  [ "$grep_rc" -eq 0 ] && hits=1
  rc=0
  [ "$scan_rc" -eq 124 ] && [ "$hits" -eq 0 ] && rc=124
  up=$(uptime_minutes "$svc")

  if [ "$rc" -eq 124 ]; then
    # The CHECK failed, which is different from the job being dead — and it must alert,
    # because a monitor that cannot see is not a monitor.
    verdict="TIMEOUT"
    dead+=("$job: log scan of $svc exceeded ${LOG_SCAN_TIMEOUT}s — THE CHECK FAILED, the job's state is UNKNOWN (not necessarily dead)")
    printf '%-22s %-40s %-9s %-9s %s
' "$job" "${svc:0:40}" "?" "${up}m" "$verdict"
    continue
  fi

  if [ "$hits" -gt 0 ]; then
    verdict="OK"; ok+=("$job")
  elif [ "$up" -lt 0 ]; then
    # The service itself is missing or not running — that is worse than a dead job.
    verdict="DEAD (service not running)"; dead+=("$job: service $svc has no running task")
  elif [ "$up" -ge "$interval" ]; then
    verdict="DEAD"
    dead+=("$job: no '$marker' in $svc for ${window}, container up ${up}m (interval ${interval}m)")
  else
    verdict="INDETERMINATE"
    indeterminate+=("$job (container up ${up}m < interval ${interval}m — redeployed recently)")
  fi

  printf '%-22s %-40s %-9s %-9s %s\n' "$job" "${svc:0:40}" "$([ "$hits" -gt 0 ] && echo seen || echo ABSENT)" "${up}m" "$verdict"
done

# ---------------------------------------------------------------------------------------------
# DATA FRESHNESS — a job can "run" and still deliver nothing.
#
# Every check above asks "did this job execute?". That is not the same as "did it work". The
# analytics ingest pipeline proves the gap: the service was up, the collectors were firing, and
# every single insert was failing with
#   ERROR: no partition of relation "ai_calls" found for row (SQLSTATE 23514)
# because daily partitions ran out. Measured 2026-09-14: newest row 2026-09-01, 313 HOURS STALE,
# in BOTH prod and staging, for 13 days. Nothing alarmed, because the collectors are deliberately
# fire-and-forget ("Don't retry. Don't block.") and the process-level checks all looked healthy.
#
# This is the same outage shape as 2026-06-21 -> 2026-08-02 (six weeks, zero signal). The repair
# both times was a fixed-window partition backfill, which expires. A freshness check is what makes
# the NEXT expiry visible on day one instead of day thirteen.
#
# Credentials are read from the running container at call time — no copy here to go stale, the
# same reasoning as the sweeper trigger.
ANALYTICS_STALE_HOURS="${ANALYTICS_STALE_HOURS:-24}"

check_analytics_freshness() {
  local cid host port db user pw age
  cid=$(docker ps -q --filter name=app-connect-cross-platform-protocol | head -1)
  if [ -z "$cid" ]; then
    printf '%-22s %-40s %-9s %-9s %s
' "analytics-freshness" "internal-analytics" "?" "-" "SKIPPED (container not on this node)"
    return
  fi
  host=$(docker exec "$cid" printenv ANALYTICS_DB_HOST 2>/dev/null)
  port=$(docker exec "$cid" printenv ANALYTICS_DB_PORT 2>/dev/null)
  db=$(docker exec "$cid" printenv ANALYTICS_DB_NAME 2>/dev/null)
  user=$(docker exec "$cid" printenv ANALYTICS_DB_USER 2>/dev/null)
  pw=$(docker exec "$cid" printenv ANALYTICS_DB_PASSWORD 2>/dev/null)
  if [ -z "$host" ] || [ -z "$db" ] || [ -z "$user" ] || [ -z "$pw" ]; then
    printf '%-22s %-40s %-9s %-9s %s
' "analytics-freshness" "internal-analytics" "?" "-" "SKIPPED (db config unreadable)"
    return
  fi
  # NB: the tables live in the internal_analytics SCHEMA, and the timestamp column is `ts`,
  # not created_at. An unqualified query fails with 'relation "ai_calls" does not exist'.
  age=$(PGPASSWORD="$pw" timeout 45 psql -h "$host" -p "${port:-5432}" -U "$user" -d "$db" -tAX         -c "SELECT COALESCE(ROUND(EXTRACT(EPOCH FROM (NOW()-MAX(ts)))/3600)::text,'-1') FROM internal_analytics.ai_calls;" 2>/dev/null | tr -d ' ')
  if [ -z "$age" ]; then
    printf '%-22s %-40s %-9s %-9s %s
' "analytics-freshness" "internal-analytics" "?" "-" "TIMEOUT/ERROR"
    dead+=("analytics-freshness: could not read max(ts) from internal_analytics.ai_calls — THE CHECK FAILED, freshness UNKNOWN")
    return
  fi
  if [ "$age" -ge "$ANALYTICS_STALE_HOURS" ] 2>/dev/null; then
    printf '%-22s %-40s %-9s %-9s %s
' "analytics-freshness" "internal-analytics" "${age}h" "-" "STALE"
    dead+=("analytics-freshness: newest internal_analytics.ai_calls row is ${age}h old (threshold ${ANALYTICS_STALE_HOURS}h). The service is UP and the collectors are firing — inserts are being REJECTED. Usual cause: daily partitions ran out (ERROR: no partition of relation \"ai_calls\" found for row).")
  else
    printf '%-22s %-40s %-9s %-9s %s
' "analytics-freshness" "internal-analytics" "${age}h" "-" "OK"
  fi
}

check_analytics_freshness

echo
echo "ok=${#ok[@]} dead=${#dead[@]} indeterminate=${#indeterminate[@]}"

if [ "$TEST_ALERT" = "true" ]; then
  dead+=("TEST ALERT — manually dispatched, not a real finding. Proves the Slack path works.")
fi

[ ${#dead[@]} -eq 0 ] && { echo "All monitored periodic jobs are alive."; exit 0; }

echo
echo "::warning::${#dead[@]} periodic job(s) appear to have stopped"
lines=$(printf '• %s\n' "${dead[@]}")
echo "$lines"

if [ -n "$SLACK_WEBHOOK" ]; then
  payload=$(python3 -c '
import json, sys
print(json.dumps({"text": ":rotating_light: *Periodic job heartbeat — %d job(s) not running*\n\n%s\n\n_A background job stopping is silent by nature; this check exists because four of them did exactly that in Sept 2026._" % (int(sys.argv[1]), sys.argv[2])}))
' "${#dead[@]}" "$lines")
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "$payload" "$SLACK_WEBHOOK")
  echo "slack HTTP $code"
  # A non-2xx here must fail the run: an alert that was never delivered is the same
  # as no alert, and this script's whole purpose is to not fail quietly.
  if [ "$code" -lt 200 ] || [ "$code" -ge 300 ]; then
    echo "::error::Slack POST failed ($code)"
    exit 1
  fi
  # Tell the workflow we already delivered our own alert, so its failure() handler
  # does not post a SECOND message for the same run. The handler exists to catch the
  # case where this script dies before reaching here (docker gone, marker lookup
  # exploding) — the exact silent-death mode that let email-drift-check sit red for
  # three days — not to re-announce findings we just sent.
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "alerted=true" >> "$GITHUB_OUTPUT"; fi
else
  echo "::error::SLACK_WEBHOOK is not set — findings could not be delivered"
  exit 1
fi

exit 1
