#!/usr/bin/env bash
# Renew Gmail + Microsoft mailbox watch subscriptions in email-ingress.
#
# Replaces the unreliable Dokploy "Google Mailbox Refresh prod" schedule, which
# was enabled (cron `0 0 */2 * *`) with a working script yet silently stopped
# firing ~2026-06-19 -> Gmail push watches lapsed fleet-wide (a watch lives only
# ~7 days). josh@gigapress.net (and others) went dark; a customer's POSITIVE
# reply, sitting in the normal inbox, was never pushed to us and never ingested.
#
# This runs every 2h (well inside email-ingress's re-arm margin so nothing
# lapses) and FAILS LOUD.
#
# Alerting (#1249, 2026-11-16). The first version paged Slack on ANY single non-200 and
# swallowed every problem with the page itself (webhook unset -> skipped without a word;
# Slack refusing the post -> `>/dev/null || true`), so a 28 h outage (2026-11-10 18:39Z to
# 11-11 22:37Z: every call hung to curl's 150 s timeout, HTTP 000) left no alert anyone
# could find, while a lone 502 during an email-ingress restart would have paged. Now, per
# endpoint, using the same shape as analytics-alarm-deadman / overlay-fdb-detector:
#   * success = any 2xx. Anything else (HTTP 000 = no answer, 4xx, 5xx) is a failed run.
#   * consecutive failed runs are counted in STATE_DIR; ONE alert goes to Slack when the
#     count reaches ALERT_AFTER_FAILURES (default 2), so one blip never pages. The same
#     outage re-alerts as a labelled reminder every REMIND_EVERY runs (default 12 = 24 h).
#   * when an endpoint that alerted answers 2xx again, ONE "RECOVERED" message is posted.
#   * the alert path cannot fail silently: an unset SLACK_WEBHOOK or a Slack post that was
#     not accepted (curl -f) is logged at user.err to journald, and the alert state is NOT
#     recorded, so the next run tries again. The unit still exits 1 on any failed run, so
#     `systemctl --failed` shows it. If STATE_DIR is unusable it alerts on every failed run
#     instead of going quiet.
#   * TEST_ALERT=true posts one Slack message to prove the webhook works (run it once after
#     installing or rotating the webhook), then exits without renewing anything.
#
# Install: see README.md. Env: /etc/revhero/mailbox-watch-renewer.env
#   SLACK_WEBHOOK, EMAIL_INGRESS_BASE, EMAIL_INGRESS_INTERNAL_SECRET,
#   ALERT_AFTER_FAILURES (2), REMIND_EVERY (12), CURL_TIMEOUT (150),
#   STATE_DIR (/var/lib/mailbox-watch-renewer), TEST_ALERT, RENEWER_ENV_FILE (tests only).
set -uo pipefail
ENV_FILE="${RENEWER_ENV_FILE:-/etc/revhero/mailbox-watch-renewer.env}"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
BASE="${EMAIL_INGRESS_BASE:-https://email-ingress.revhero.io}"
TAG=mailbox-watch-renewer
SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"
STATE_DIR="${STATE_DIR:-/var/lib/mailbox-watch-renewer}"
ALERT_AFTER_FAILURES="${ALERT_AFTER_FAILURES:-2}"
REMIND_EVERY="${REMIND_EVERY:-12}"
CURL_TIMEOUT="${CURL_TIMEOUT:-150}"
case "$ALERT_AFTER_FAILURES" in ''|*[!0-9]*) ALERT_AFTER_FAILURES=2 ;; esac
case "$REMIND_EVERY" in ''|*[!0-9]*) REMIND_EVERY=12 ;; esac
case "$CURL_TIMEOUT" in ''|*[!0-9]*) CURL_TIMEOUT=150 ;; esac
[ "$ALERT_AFTER_FAILURES" -ge 1 ] || ALERT_AFTER_FAILURES=1
[ "$REMIND_EVERY" -ge 1 ] || REMIND_EVERY=1

log() { logger -t "$TAG" "$*"; }
log_err() { logger -t "$TAG" -p user.err "ERROR: $*"; }

# Escape a string for a JSON string value (no jq: this script never needed it).
json_escape() {
  local s="$1"
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\r'/\\r}; s=${s//$'\t'/\\t}
  printf '%s' "$s"
}
# Same curl idiom as analytics-alarm-deadman / overlay-fdb-detector: -f makes a refused post a
# failure. Returns 0 ONLY when Slack accepted it; callers must not record alert state otherwise.
slack_post() {
  [ -n "$SLACK_WEBHOOK" ] || return 1
  printf '{"text":"%s"}' "$(json_escape "$1")" |
    curl -fsS -m 15 -X POST -H 'Content-Type: application/json' -d @- "$SLACK_WEBHOOK" >/dev/null 2>&1
}

hdr_file=""
err_file=$(mktemp)
trap 'rm -f "$hdr_file" "$err_file"' EXIT

if [ "${TEST_ALERT:-false}" = "true" ]; then
  if [ -z "$SLACK_WEBHOOK" ]; then log_err "TEST_ALERT: SLACK_WEBHOOK is not set in $ENV_FILE; failure alerts cannot be delivered"; exit 2; fi
  if slack_post ":white_check_mark: *mailbox-watch-renewer* test alert from VPS2 - Slack path OK (TEST_ALERT=true)"; then
    log "TEST_ALERT: Slack test alert delivered."; exit 0
  fi
  log_err "TEST_ALERT: the Slack post was NOT accepted (check SLACK_WEBHOOK in $ENV_FILE)"; exit 1
fi

[ -n "$SLACK_WEBHOOK" ] || log "WARNING: SLACK_WEBHOOK is not set in $ENV_FILE; a failed renewal cannot be alerted to Slack"

state_ok=1
{ mkdir -p "$STATE_DIR" 2>/dev/null && [ -w "$STATE_DIR" ]; } || state_ok=0
[ "$state_ok" = 1 ] || log_err "cannot write state in $STATE_DIR; alerting on EVERY failed run (no consecutive-failure threshold) until it is fixed"
read_fails() { local v; v=$(cat "$STATE_DIR/$1.fails" 2>/dev/null); case "$v" in ''|*[!0-9]*) v=0 ;; esac; echo "$v"; }

# #1057: email-ingress is putting an internal-auth gate on /v1/user-mailboxes (log-only until it
# enforces). Send the shared secret when one is configured; curl reads the header from a 0600
# temp file (removed on exit) so the value never appears in `ps`. Without it the calls still work today, but
# they will 401 the day email-ingress enforces -- warn loudly so that is never a surprise.
secret_args=()
if [ -n "${EMAIL_INGRESS_INTERNAL_SECRET:-}" ]; then
  hdr_file=$(mktemp)   # mktemp creates it 0600
  printf 'X-Internal-Secret: %s\n' "$EMAIL_INGRESS_INTERNAL_SECRET" > "$hdr_file"
  secret_args=(-H "@$hdr_file")
else
  log "WARNING: EMAIL_INGRESS_INTERNAL_SECRET is not set in $ENV_FILE; renewals will 401 once email-ingress enforces internal auth"
fi

fail=0
alert_eps=(); alert_text=""
recover_eps=(); recover_text=""
for ep in refresh-expired-google refresh-expired-microsoft; do
  out=$(curl -sS -m "$CURL_TIMEOUT" -w $'\n%{http_code}' -X POST "${secret_args[@]}" "$BASE/v1/user-mailboxes/$ep" 2>"$err_file") || true
  code=$(printf '%s' "$out" | tail -n1)
  body=$(printf '%s' "$out" | sed '$d' | tr '\n' ' ')
  case "$code" in [0-9][0-9][0-9]) ;; *) code=000 ;; esac
  # HTTP 000 = no answer at all (the #1249 hang): curl's own error is the useful part.
  if [ "$code" = 000 ] && [ -s "$err_file" ]; then body=$(tr '\n' ' ' < "$err_file"); fi
  log "$ep -> HTTP ${code}: ${body}"

  case "$code" in
    2??)
      if [ -e "$STATE_DIR/$ep.alerted" ]; then
        recover_eps+=("$ep")
        recover_text="${recover_text}${ep} answers HTTP ${code} again after $(read_fails "$ep") failed run(s); "
      elif [ "$state_ok" = 1 ]; then
        rm -f "$STATE_DIR/$ep.fails"   # a blip below the threshold is forgotten without a word
      fi
      ;;
    *)
      fail=1
      if [ "$state_ok" = 1 ]; then
        n=$(( $(read_fails "$ep") + 1 ))
        printf '%s\n' "$n" > "$STATE_DIR/$ep.fails"
      else
        n=$ALERT_AFTER_FAILURES
      fi
      if [ "$n" -ge "$ALERT_AFTER_FAILURES" ]; then
        kind=""
        if [ "$state_ok" != 1 ] || [ ! -e "$STATE_DIR/$ep.alerted" ]; then
          kind="new"
        elif [ $(( (n - ALERT_AFTER_FAILURES) % REMIND_EVERY )) -eq 0 ]; then
          kind="reminder"
        fi
        if [ -n "$kind" ]; then
          sample=$(printf '%s' "${body:0:160}" | tr -c '[:print:]' ' ')
          [ "$kind" = "reminder" ] && prefix="STILL FAILING (reminder) " || prefix=""
          alert_eps+=("$ep")
          alert_text="${alert_text}${prefix}${ep}: ${n} failed run(s) in a row, last HTTP ${code} (${sample}); "
        fi
      fi
      ;;
  esac
done

if [ "${#alert_eps[@]}" -gt 0 ]; then
  msg=":rotating_light: *mailbox-watch-renewer FAILED on VPS2* - ${alert_text}- Gmail/MS watch renewal is not getting a 2xx from email-ingress; email ingestion will lapse if this continues."
  if [ -z "$SLACK_WEBHOOK" ]; then
    log_err "SLACK_WEBHOOK is not set in $ENV_FILE; this failure alert could NOT be delivered: ${alert_text}"
  elif slack_post "$msg"; then
    log "Slack failure alert delivered for: ${alert_eps[*]}"
    if [ "$state_ok" = 1 ]; then for ep in "${alert_eps[@]}"; do : > "$STATE_DIR/$ep.alerted"; done; fi
  else
    log_err "the Slack post was NOT accepted; the failure alert for ${alert_eps[*]} was not delivered and will be retried next run: ${alert_text}"
  fi
fi

if [ "${#recover_eps[@]}" -gt 0 ]; then
  msg=":white_check_mark: *mailbox-watch-renewer RECOVERED on VPS2* - ${recover_text}- email-ingress renewals are working again."
  if slack_post "$msg"; then
    log "Slack recovery message delivered for: ${recover_eps[*]}"
    for ep in "${recover_eps[@]}"; do rm -f "$STATE_DIR/$ep.alerted" "$STATE_DIR/$ep.fails"; done
  else
    log_err "the Slack post was NOT accepted; the recovery message for ${recover_eps[*]} will be retried next run"
  fi
fi
exit "$fail"
