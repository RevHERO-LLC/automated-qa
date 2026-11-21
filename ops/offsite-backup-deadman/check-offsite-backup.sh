#!/usr/bin/env bash
# check-offsite-backup.sh — DEAD-MAN check for the VPS4 offsite Postgres backup (#1255, plan P5-D1).
#
# WHY: /usr/local/bin/pg-backup.sh on VPS4 uploads verified prod dumps to S3 every night. From 2026-09-12 to
# 2026-11-21 it failed EVERY night (stale embedded DB password) and nobody was told: the S3 prefix went EMPTY as the
# 30-day lifecycle expired the last good copies. A backup that silently stops reads exactly like a healthy one. So
# THIS check — deliberately a separate process on a separate host (VPS2 systemd timer) — looks at the S3 side and
# Slacks when the newest offsite object is too old.
#
# It runs  aws s3api list-objects-v2 --bucket $S3_BUCKET --prefix $S3_PREFIX --query 'max(Contents[].LastModified)'
# with a READ-ONLY IAM identity (the backup host's key is write-only by design, so it cannot be used here), and alerts:
#   * newest object older than STALE_HOURS (default 26) or the prefix is EMPTY -> kind "stale"  (definitive, at once)
#   * the AWS call fails / unparsable / future timestamp                   -> kind "failed" (needs CONFIRM_RUNS
#                                                                              consecutive runs: a network blip must
#                                                                              not page)
#   * the check itself cannot run (no aws CLI)                             -> kind "config" (alerts at once, exit 2)
#
# FAIL LOUD (same contract as ops/analytics-alarm-deadman): no SLACK_WEBHOOK => exit 2; Slack undeliverable => exit 1
# and the alert state is NOT recorded (retried next run); the unit failing shows in `systemctl --failed`.
# Dedupe: a NEW or CHANGED kind alerts immediately; the same kind re-alerts at most every REMIND_HOURS (REMINDER);
# when the backup is fresh again, one "RECOVERED" message is posted and the state resets.
#
# Env: SLACK_WEBHOOK (REQUIRED), AWS_PROFILE (the read-only profile; optional if instance creds exist),
#      S3_BUCKET (920373022094-database-backups), S3_PREFIX (postgres/prod/), STALE_HOURS (26), CONFIRM_RUNS (2),
#      REMIND_HOURS (12), STATE_DIR (/var/lib/offsite-backup-deadman), LANE_LABEL (prod),
#      TEST_ALERT ("true" => post one Slack message to validate the path), DEADMAN_NOW_EPOCH (tests only).
# Exit: 0 ran (ok / alert delivered / suppressed) | 1 Slack undeliverable | 2 cannot run (config).

set -uo pipefail

SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"
S3_BUCKET="${S3_BUCKET:-920373022094-database-backups}"
S3_PREFIX="${S3_PREFIX:-postgres/prod/}"
STATE_DIR="${STATE_DIR:-/var/lib/offsite-backup-deadman}"
STATE_FILE="${STATE_DIR}/state"
LABEL="${LANE_LABEL:-prod}"
TEST_ALERT="${TEST_ALERT:-false}"

log() { echo "[offsite-deadman $(date -u +%H:%M:%SZ)] $*"; }

# A bad knob must never silently disable the check: fall back to the default and say so.
int_or_default() { # name default
  local v="${!1:-}"
  if [[ "$v" =~ ^[0-9]+$ ]] && [ "$v" -ge 1 ]; then echo "$v"; else
    [ -n "$v" ] && log "WARN: $1='$v' is not a positive integer — using default $2" >&2
    echo "$2"
  fi
}
STALE_HOURS="$(int_or_default STALE_HOURS 26)"
CONFIRM_RUNS="$(int_or_default CONFIRM_RUNS 2)"
REMIND_HOURS="$(int_or_default REMIND_HOURS 12)"

now_epoch() { echo "${DEADMAN_NOW_EPOCH:-$(date +%s)}"; }
fmt_ts() { date -u -d "@$1" '+%Y-%m-%d %H:%MZ' 2>/dev/null || echo "?"; }

# --- Slack (same idiom as analytics-alarm-deadman). Returns 0 only when the post was accepted.
slack_post() {
  printf '%s' "$1" | jq -Rs '{text:.}' | curl -fsS -m 15 -X POST -H 'Content-Type: application/json' -d @- "$SLACK_WEBHOOK" >/dev/null 2>&1
}

# --- state: kind (empty = healthy), consecutive failure count, since, last alert time.
state_get() { sed -n "s/^$1=//p" "$STATE_FILE" 2>/dev/null | head -1; }
state_put() { # kind fail_count since last_alert
  mkdir -p "$STATE_DIR" 2>/dev/null || { log "WARN: cannot create $STATE_DIR — dedupe state NOT saved"; return 1; }
  local tmp="${STATE_FILE}.tmp.$$"
  printf 'kind=%s\nfail_count=%s\nsince=%s\nlast_alert=%s\n' "$1" "$2" "$3" "$4" > "$tmp" && mv -f "$tmp" "$STATE_FILE"
}

# Pure decision (identical semantics to analytics-alarm-deadman): observed kind, fail_count BEFORE this run, now.
# Prints: none | wait | alert | remind | recover
decide() {
  local obs="$1" fc="$2" now="$3" st_kind st_last
  st_kind="$(state_get kind)"; st_last="$(state_get last_alert)"; st_last="${st_last:-0}"
  if [ "$obs" = ok ]; then
    [ -n "$st_kind" ] && echo recover || echo none
    return
  fi
  if [ "$obs" = failed ] && [ "$st_kind" != failed ] && [ $((fc + 1)) -lt "$CONFIRM_RUNS" ]; then
    echo wait; return
  fi
  if [ "$st_kind" != "$obs" ]; then echo alert; return; fi
  if [ $(( now - st_last )) -ge $(( REMIND_HOURS * 3600 )) ]; then echo remind; return; fi
  echo none
}

# --- observe. Sets OBS (ok|stale|failed|config), REASON, NEWEST, AGE_S.
OBS="" REASON="" NEWEST="" AGE_S=""
observe() {
  local out err rc epoch now
  if ! command -v aws >/dev/null 2>&1; then OBS=config; REASON="aws CLI not installed on this host"; return; fi
  err="$(mktemp)"
  out="$(aws s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "$S3_PREFIX" \
          --query 'max(Contents[].LastModified)' --output text 2>"$err")"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    OBS=failed; REASON="aws s3api list-objects-v2 failed (rc=${rc}: $(head -c 200 "$err" | tr -d '\n'))"
    grep -q -i -E 'AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|ExpiredToken' "$err" && REASON+=" — the READ-ONLY credential was rejected (rotated/expired/wrong profile?)"
    rm -f "$err"; return
  fi
  rm -f "$err"
  out="$(printf '%s' "$out" | tr -d '\r' | head -1)"
  now="$(now_epoch)"
  if [ -z "$out" ] || [ "$out" = "None" ] || [ "$out" = "null" ]; then
    OBS=stale; REASON="the offsite prefix s3://${S3_BUCKET}/${S3_PREFIX} is EMPTY — there is NO offsite copy of prod"
    return
  fi
  if ! epoch="$(date -u -d "$out" +%s 2>/dev/null)"; then
    OBS=failed; REASON="newest LastModified '${out:0:40}' is not a parseable timestamp"; return
  fi
  NEWEST="$out"; AGE_S=$(( now - epoch ))
  if [ "$AGE_S" -lt -300 ]; then OBS=failed; REASON="newest object ${out} is $(( -AGE_S ))s in the FUTURE (clock skew) — cannot judge freshness"
  elif [ "$AGE_S" -gt $(( STALE_HOURS * 3600 )) ]; then OBS=stale; REASON="newest offsite object ${out} = $(( AGE_S / 3600 )) h old (threshold ${STALE_HOURS} h)"
  else OBS=ok; REASON="newest offsite object ${out} = $(( AGE_S / 3600 )) h old"; fi
}

compose() { # kind header
  local kind="$1" head="$2"
  case "$kind" in
    stale)  echo "${head} the OFFSITE prod database backup is STALE (${LABEL}): ${REASON}. If VPS4's disk is lost now, prod data is lost. Check /var/log/pg-backup.log on VPS4 (and /var/backups/postgres/.last-offsite-success), fix, and run /usr/local/bin/pg-backup.sh by hand. Dead-man: automated-qa/ops/offsite-backup-deadman."
    ;;
    failed) echo "${head} the offsite-backup dead-man could not read S3 (${LABEL}): ${REASON}. A missing answer is treated as an ALERT, not as health. Dead-man: automated-qa/ops/offsite-backup-deadman."
    ;;
    config) echo "${head} the offsite-backup dead-man cannot RUN (${LABEL}): ${REASON}. The offsite backup is currently UNWATCHED. Fix the host / /etc/revhero/offsite-backup-deadman.env."
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
log "observed=${OBS} stale_after=${STALE_HOURS}h :: ${REASON}"

if [ "$TEST_ALERT" = "true" ]; then
  if slack_post ":white_check_mark: *Offsite backup dead-man* test run (${LABEL}) — Slack path OK. Current observation: ${OBS} — ${REASON} (TEST_ALERT=true)"; then log "Slack test alert sent."; exit 0; fi
  log "ERROR: Slack POST failed (test alert)." >&2; exit 1
fi

prev_fc="$(state_get fail_count)"; prev_fc="${prev_fc:-0}"
prev_since="$(state_get since)"; prev_since="${prev_since:-$now}"
prev_last="$(state_get last_alert)"; prev_last="${prev_last:-0}"
prev_kind="$(state_get kind)"
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
    if [ "$decision" = remind ]; then head=":rotating_light: *Offsite backup dead-man* — REMINDER (still failing since $(fmt_ts "$prev_since")):"
    else head=":rotating_light: *Offsite backup dead-man* —"; fi
    if slack_post "$(compose "$OBS" "$head")"; then
      log "Slack ${decision} sent (kind=${OBS})."
      [ "$decision" = alert ] && since="$now" || since="$prev_since"
      [ "$OBS" = failed ] && new_fc=$((prev_fc + 1)) || new_fc=0
      state_put "$OBS" "$new_fc" "$since" "$now"
    else
      log "ERROR: Slack POST failed — alert NOT recorded, will retry next run." >&2; rc_final=1
    fi
    ;;
  recover)
    if slack_post ":white_check_mark: *Offsite backup dead-man* — RECOVERED (${LABEL}): ${REASON}. It had been alerting (${prev_kind}) since $(fmt_ts "$prev_since")."; then
      log "Slack recovery sent."; state_put "" 0 "" 0
    else
      log "ERROR: Slack POST failed (recovery notice) — will retry next run." >&2; rc_final=1
    fi
    ;;
esac

[ "$OBS" = config ] && [ "$rc_final" -eq 0 ] && rc_final=2
exit "$rc_final"
