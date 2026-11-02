#!/usr/bin/env bash
# check-alarm-heartbeat.sh — DEAD-MAN check for the analytics-service alarm loop (m1030 Phase 3, U16 family).
#
# WHY: the analytics alarm loop is the single thing that raises every other alert in the bundle (AI-failure,
# send-volume, new AI bookings, reconciler caps, SiteForge backlog, ...). A loop that has died raises NOTHING,
# and "no alerts" reads exactly like "all healthy". So the loop stamps a last-run timestamp, and THIS check —
# deliberately a separate process on a separate host (VPS2 systemd timer) — alerts when that stamp goes stale.
#
# It calls analytics-service  GET /v1/internal/alarms/heartbeat  (contract C5)  ->  {"last_run_at": "<RFC3339>"}
# (a {"data":{"last_run_at":...}} envelope is accepted too) and Slacks when:
#   * last_run_at is older than STALE_MINUTES (default 30)            -> kind "stale"   (definitive, alerts at once)
#   * the call fails / non-2xx / no usable timestamp / future stamp   -> kind "failed"  (a missing response IS an alert;
#                                                                        needs CONFIRM_RUNS consecutive runs so a
#                                                                        rolling deploy of analytics doesn't page)
#   * the check itself cannot run (no secret)                         -> kind "config"  (alerts at once, exit 2)
#
# FAIL LOUD: a monitor that fails silently manufactures confidence (see periodic-job-heartbeat.yml: a stale
# credential blinded email-drift-check for three days). So: no SLACK_WEBHOOK => exit 2; Slack undeliverable =>
# exit 1 and the alert state is NOT recorded (it retries next run); unit failure shows in `systemctl --failed`.
#
# Dedupe (same shape as overlay-fdb-detector): a NEW or CHANGED kind alerts immediately; the same kind re-alerts
# at most every REMIND_HOURS, labelled REMINDER; when the heartbeat is fresh again, one "RECOVERED" message is
# posted and the state resets.
#
# Credential: X-Internal-Secret (header ONLY — never the ?secret= query form, URLs get logged). Resolved at run
# time, in this order: ANALYTICS_INTERNAL_SECRET (env) | the swarm service SPEC of ANALYTICS_SERVICE (read at call
# time like scripts/analytics-partition-topup.sh, so a secret rotation can't leave a stale copy here). The secret is
# handed to curl on STDIN (-K -), so it never appears in argv / `ps` / a shell trace, and is never logged.
#
# Env: SLACK_WEBHOOK (REQUIRED), ANALYTICS_BASE_URL (default https://internal-analytics.revhero.io),
#      ANALYTICS_INTERNAL_SECRET | ANALYTICS_SERVICE, STALE_MINUTES (30), CONFIRM_RUNS (2), REMIND_HOURS (6),
#      CURL_TIMEOUT (15), STATE_DIR (/var/lib/analytics-alarm-deadman), LANE_LABEL (prod),
#      TEST_ALERT ("true" => post one Slack message to validate the path), DEADMAN_NOW_EPOCH (tests only).
# Exit: 0 ran (ok / alert delivered / suppressed) | 1 Slack undeliverable | 2 cannot run (config).

set -uo pipefail

SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"
ANALYTICS_BASE_URL="${ANALYTICS_BASE_URL:-https://internal-analytics.revhero.io}"
ANALYTICS_INTERNAL_SECRET="${ANALYTICS_INTERNAL_SECRET:-}"
ANALYTICS_SERVICE="${ANALYTICS_SERVICE:-}"
STATE_DIR="${STATE_DIR:-/var/lib/analytics-alarm-deadman}"
STATE_FILE="${STATE_DIR}/state"
LABEL="${LANE_LABEL:-prod}"
TEST_ALERT="${TEST_ALERT:-false}"
HEARTBEAT_PATH="/v1/internal/alarms/heartbeat"

log() { echo "[alarm-deadman $(date -u +%H:%M:%SZ)] $*"; }

# A bad knob must never silently disable the check: fall back to the default and say so.
int_or_default() { # name default
  local v="${!1:-}"
  if [[ "$v" =~ ^[0-9]+$ ]] && [ "$v" -ge 1 ]; then echo "$v"; else
    [ -n "$v" ] && log "WARN: $1='$v' is not a positive integer — using default $2" >&2
    echo "$2"
  fi
}
STALE_MINUTES="$(int_or_default STALE_MINUTES 30)"
CONFIRM_RUNS="$(int_or_default CONFIRM_RUNS 2)"
REMIND_HOURS="$(int_or_default REMIND_HOURS 6)"
CURL_TIMEOUT="$(int_or_default CURL_TIMEOUT 15)"

now_epoch() { echo "${DEADMAN_NOW_EPOCH:-$(date +%s)}"; }
fmt_ts() { date -u -d "@$1" '+%Y-%m-%d %H:%MZ' 2>/dev/null || echo "?"; }

# --- Slack: same idiom as overlay-fdb-detector (jq-escaped text, curl to the incoming webhook). Returns 0 only
#     when the post was accepted — callers must NOT record alert state on failure.
slack_post() {
  printf '%s' "$1" | jq -Rs '{text:.}' | curl -fsS -m 15 -X POST -H 'Content-Type: application/json' -d @- "$SLACK_WEBHOOK" >/dev/null 2>&1
}

# --- state: kind (what we are alerting on, empty = healthy), consecutive failure count, since, last alert time.
state_get() { sed -n "s/^$1=//p" "$STATE_FILE" 2>/dev/null | head -1; }
state_put() { # kind fail_count since last_alert
  mkdir -p "$STATE_DIR" 2>/dev/null || { log "WARN: cannot create $STATE_DIR — dedupe state NOT saved"; return 1; }
  local tmp="${STATE_FILE}.tmp.$$"
  printf 'kind=%s\nfail_count=%s\nsince=%s\nlast_alert=%s\n' "$1" "$2" "$3" "$4" > "$tmp" && mv -f "$tmp" "$STATE_FILE"
}

# Pure decision: observed kind (ok|stale|failed|config), fail_count so far (BEFORE this run), now.
# Prints: none | wait | alert | remind | recover
decide() {
  local obs="$1" fc="$2" now="$3" st_kind st_last
  st_kind="$(state_get kind)"; st_last="$(state_get last_alert)"; st_last="${st_last:-0}"
  if [ "$obs" = ok ]; then
    [ -n "$st_kind" ] && echo recover || echo none
    return
  fi
  if [ "$obs" = failed ] && [ "$st_kind" != failed ] && [ $((fc + 1)) -lt "$CONFIRM_RUNS" ]; then
    echo wait; return   # a transient blip (e.g. analytics rolling) — confirm on the next run before paging
  fi
  if [ "$st_kind" != "$obs" ]; then echo alert; return; fi
  if [ $(( now - st_last )) -ge $(( REMIND_HOURS * 3600 )) ]; then echo remind; return; fi
  echo none
}

# --- resolve the credential (never logged) ---------------------------------------------------------------
CONFIG_ERR=""
SECRET=""
resolve_secret() {
  if [ -n "$ANALYTICS_INTERNAL_SECRET" ]; then
    SECRET="$ANALYTICS_INTERNAL_SECRET"
  elif [ -n "$ANALYTICS_SERVICE" ]; then
    local envs
    envs="$(docker service inspect "$ANALYTICS_SERVICE" --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' 2>/dev/null)" || true
    SECRET="$(printf '%s\n' "$envs" | grep '^INTERNAL_SERVICES_WEBHOOK_SECRET=' | head -1 | cut -d= -f2-)"
    [ -z "$SECRET" ] && { CONFIG_ERR="could not read INTERNAL_SERVICES_WEBHOOK_SECRET from the spec of swarm service '${ANALYTICS_SERVICE}' (renamed/removed, or this is not the manager)"; return 1; }
  else
    CONFIG_ERR="neither ANALYTICS_INTERNAL_SECRET nor ANALYTICS_SERVICE is set in the env file"; return 1
  fi
  # The value is written into a curl config line: refuse anything that could break out of it.
  if ! [[ "$SECRET" =~ ^[A-Za-z0-9._~+/=:-]+$ ]]; then CONFIG_ERR="the internal secret contains unexpected characters (refusing to build a request with it)"; SECRET=""; return 1; fi
  return 0
}

# --- fetch + classify. Sets OBS (ok|stale|failed|config), REASON, LAST_RUN, AGE_S. --------------------------
OBS="" REASON="" LAST_RUN="" AGE_S=""
observe() {
  local body err http rc ts epoch now
  if ! resolve_secret; then OBS=config; REASON="$CONFIG_ERR"; return; fi
  body="$(mktemp)"; err="$(mktemp)"
  http="$(printf 'header = "X-Internal-Secret: %s"\n' "$SECRET" \
          | curl -sS -m "$CURL_TIMEOUT" -K - -o "$body" -w '%{http_code}' "${ANALYTICS_BASE_URL%/}${HEARTBEAT_PATH}" 2>"$err")"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    OBS=failed; REASON="no response from ${ANALYTICS_BASE_URL%/}${HEARTBEAT_PATH} (curl rc=${rc}: $(head -c 200 "$err" | tr -d '\n'))"
  elif ! [[ "$http" =~ ^2[0-9][0-9]$ ]]; then
    OBS=failed; REASON="HTTP ${http} from the heartbeat endpoint"
    case "$http" in 401|403) REASON+=" — the internal secret was REJECTED (rotated? wrong service?)";; 404) REASON+=" — route not found (heartbeat endpoint not deployed, or the service is mid-roll)";; esac
  else
    # key anywhere in the body => a bare {"last_run_at":..} and a {"data":{"last_run_at":..}} envelope both work;
    # JSON null / a missing key simply doesn't match.
    ts="$(head -c 65536 "$body" | grep -o '"last_run_at"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"$/\1/')"
    now="$(now_epoch)"
    if [ -z "$ts" ]; then
      OBS=failed; REASON="the heartbeat response has no last_run_at (null/missing — the alarm loop has not recorded a run since the service started)"
    elif ! [[ "$ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$ ]] \
         || ! epoch="$(date -u -d "$ts" +%s 2>/dev/null)"; then
      OBS=failed; REASON="last_run_at '${ts:0:40}' is not a valid RFC3339 timestamp"
    elif [ "$epoch" -lt 946684800 ]; then
      OBS=failed; LAST_RUN="$ts"; REASON="last_run_at is the zero time (${ts:0:25}) — the loop has never recorded a run"
    else
      LAST_RUN="$ts"; AGE_S=$(( now - epoch ))
      if [ "$AGE_S" -lt -300 ]; then OBS=failed; REASON="last_run_at ${ts} is $(( -AGE_S ))s in the FUTURE (clock skew) — cannot judge freshness"
      elif [ "$AGE_S" -gt $(( STALE_MINUTES * 60 )) ]; then OBS=stale; REASON="last run ${ts} = $(( AGE_S / 60 )) min ago (threshold ${STALE_MINUTES} min)"
      else OBS=ok; REASON="last run ${ts} = $(( AGE_S / 60 )) min ago"; fi
    fi
  fi
  rm -f "$body" "$err"
}

compose() { # kind label-prefix
  local kind="$1" head="$2"
  case "$kind" in
    stale)  echo "${head} the analytics alarm loop has STOPPED (${LABEL}): ${REASON}. Every alert in the bundle (AI-failure, send-volume, AI bookings, reconciler caps, SiteForge backlog...) is SILENT right now — absence of alerts is NOT health. Check the analytics-service container/logs for '[alarms]' lines and restart the loop (redeploy). Dead-man: automated-qa/ops/analytics-alarm-deadman."
    ;;
    failed) echo "${head} the dead-man check could not confirm the analytics alarm loop is alive (${LABEL}): ${REASON}. A missing/invalid response is treated as an ALERT, not as health. Dead-man: automated-qa/ops/analytics-alarm-deadman."
    ;;
    config) echo "${head} the dead-man check cannot RUN (${LABEL}): ${REASON}. The alarm loop is currently UNWATCHED. Fix /etc/revhero/analytics-alarm-deadman.env."
    ;;
  esac
}

# Sourced by test-deadman.sh for the pure functions only (never set in production).
if [ "${DEADMAN_LIB_ONLY:-}" = "1" ]; then return 0; fi

if [ -z "$SLACK_WEBHOOK" ]; then
  log "ERROR: SLACK_WEBHOOK is not set — this monitor cannot deliver findings (failing loudly)." >&2
  exit 2
fi

observe
now="$(now_epoch)"
log "observed=${OBS} stale_after=${STALE_MINUTES}m :: ${REASON}"

if [ "$TEST_ALERT" = "true" ]; then
  if slack_post ":white_check_mark: *Analytics alarm dead-man* test run (${LABEL}) — Slack path OK. Current observation: ${OBS} — ${REASON} (TEST_ALERT=true)"; then log "Slack test alert sent."; exit 0; fi
  log "ERROR: Slack POST failed (test alert)." >&2; exit 1
fi

prev_fc="$(state_get fail_count)"; prev_fc="${prev_fc:-0}"
prev_since="$(state_get since)"; prev_since="${prev_since:-$now}"
prev_last="$(state_get last_alert)"; prev_last="${prev_last:-0}"
prev_kind="$(state_get kind)"
# config problems are not transient: confirm immediately (only "failed" waits for CONFIRM_RUNS).
decision="$(decide "$OBS" "$prev_fc" "$now")"
log "decision=${decision} (state kind='${prev_kind}', consecutive_failures=${prev_fc})"

rc_final=0
case "$decision" in
  none)
    [ "$OBS" = ok ] && state_put "" 0 "" 0 >/dev/null 2>&1
    ;;
  wait)
    state_put "$prev_kind" $((prev_fc + 1)) "$prev_since" "$prev_last" ;;
  alert|remind)
    if [ "$decision" = remind ]; then head=":rotating_light: *Analytics alarm dead-man* — REMINDER (still failing since $(fmt_ts "$prev_since")):"
    else head=":rotating_light: *Analytics alarm dead-man* —"; fi
    if slack_post "$(compose "$OBS" "$head")"; then
      log "Slack ${decision} sent (kind=${OBS})."
      [ "$decision" = alert ] && since="$now" || since="$prev_since"
      # only consecutive "failed" observations count toward CONFIRM_RUNS; stale/config are definitive.
      [ "$OBS" = failed ] && new_fc=$((prev_fc + 1)) || new_fc=0
      state_put "$OBS" "$new_fc" "$since" "$now"
    else
      log "ERROR: Slack POST failed — alert NOT recorded, will retry next run." >&2; rc_final=1
    fi
    ;;
  recover)
    if slack_post ":white_check_mark: *Analytics alarm dead-man* — RECOVERED (${LABEL}): ${REASON}. It had been alerting (${prev_kind}) since $(fmt_ts "$prev_since")."; then
      log "Slack recovery sent."; state_put "" 0 "" 0
    else
      log "ERROR: Slack POST failed (recovery notice) — will retry next run." >&2; rc_final=1
    fi
    ;;
esac

# An un-runnable check stays RED in systemd (visible in `systemctl --failed`) even after its alert was delivered.
[ "$OBS" = config ] && [ "$rc_final" -eq 0 ] && rc_final=2
exit "$rc_final"
