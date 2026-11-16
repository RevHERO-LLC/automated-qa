#!/usr/bin/env bash
# Hermetic red/green test for mailbox-watch-renewer.sh (#1249 failure alerting).
# Mocks curl and logger on PATH (no network, no journald) and runs the REAL script against a
# throwaway STATE_DIR. Same shape as ops/analytics-alarm-deadman/test-deadman.sh.
#   bash ops/mailbox-watch-renewer/test-mailbox-watch-renewer.sh   -> exit 0 = all PASS
# SCRIPT=<path> runs the same checks against another copy of the script (red evidence).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT:-${HERE}/mailbox-watch-renewer.sh}"
WORK="$(mktemp -d)"; trap 'rm -rf "${WORK}"' EXIT
MOCKBIN="${WORK}/mockbin"; mkdir -p "${MOCKBIN}"

fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1: expected '$3', got '$2'"; fail=1; fi; }

bash -n "${SCRIPT}" && echo "PASS  bash -n ${SCRIPT##*/}" || { echo "FAIL  bash -n"; exit 1; }

# --- mock curl: an email-ingress endpoint -> scenario (MOCK_GOOGLE / MOCK_MS = HTTP code, 000 = no answer);
#     anything else is the Slack webhook (post recorded, MOCK_SLACK_FAIL=1 makes it refuse like curl -f).
cat > "${MOCKBIN}/curl" <<'MOCKCURL'
#!/usr/bin/env bash
args=("$@"); url="${args[$((${#args[@]}-1))]}"
echo "curl $*" >> "${MOCK_LOG}/curl-argv.log"
slackbody=""
for ((i=0;i<${#args[@]};i++)); do
  case "${args[$i]}" in
    -H) h="${args[$((i+1))]}"; case "$h" in @*) cat "${h#@}" >> "${MOCK_LOG}/hdr.log" 2>/dev/null;; esac ;;
    -d) [ "${args[$((i+1))]}" = "@-" ] && slackbody="$(cat)" ;;
    --data) slackbody="${args[$((i+1))]}" ;;
  esac
done
case "${url}" in
  */refresh-expired-google)    mode="${MOCK_GOOGLE:-200}" ;;
  */refresh-expired-microsoft) mode="${MOCK_MS:-200}" ;;
  *) { echo "---- POST ${url}"; echo "${slackbody}"; } >> "${MOCK_LOG}/slack.log"
     [ "${MOCK_SLACK_FAIL:-0}" = 1 ] && exit 22
     exit 0 ;;
esac
if [ "${mode}" = 000 ]; then
  echo "curl: (28) Operation timed out after 150001 milliseconds with 0 bytes received" >&2
  printf '\n000'; exit 28
fi
printf 'mock body %s\n%s' "${mode}" "${mode}"; exit 0
MOCKCURL
cat > "${MOCKBIN}/logger" <<'MOCKLOGGER'
#!/usr/bin/env bash
echo "$*" >> "${MOCK_LOG}/logger.log"
MOCKLOGGER
chmod +x "${MOCKBIN}/curl" "${MOCKBIN}/logger"
export PATH="${MOCKBIN}:${PATH}"

new_case() { # fresh log dir + state dir, default env
  CASE="${WORK}/case.$RANDOM$RANDOM"; mkdir -p "${CASE}/log"
  export MOCK_LOG="${CASE}/log" STATE_DIR="${CASE}/state" RENEWER_ENV_FILE="${WORK}/none.env"
  export SLACK_WEBHOOK="https://hooks.invalid/T/B/x" EMAIL_INGRESS_BASE="https://email-ingress.invalid"
  unset MOCK_GOOGLE MOCK_MS MOCK_SLACK_FAIL EMAIL_INGRESS_INTERNAL_SECRET TEST_ALERT ALERT_AFTER_FAILURES REMIND_EVERY
  : > "${MOCK_LOG}/slack.log"; : > "${MOCK_LOG}/logger.log"; : > "${MOCK_LOG}/curl-argv.log"
}
run() { out="$(bash "${SCRIPT}" </dev/null 2>&1)"; rc=$?; }
posts() { grep -c '^---- POST' "${MOCK_LOG}/slack.log"; }
last_post() { awk '/^---- POST/{buf=""} {buf=buf $0 "\n"} END{printf "%s", buf}' "${MOCK_LOG}/slack.log"; }
logged() { cat "${MOCK_LOG}/logger.log"; }
has() { case "$1" in *"$2"*) echo yes ;; *) echo no ;; esac; }
fails_of() { cat "${STATE_DIR}/$1.fails" 2>/dev/null || echo none; }
alerted() { if [ -e "${STATE_DIR}/$1.alerted" ]; then echo yes; else echo no; fi; }
G=refresh-expired-google; M=refresh-expired-microsoft

# 1 --- healthy: silent ---------------------------------------------------------------------------
new_case; run
check "healthy: exit 0" "$rc" 0
check "healthy: NO Slack post" "$(posts)" 0
check "healthy: result is logged per endpoint" "$(has "$(logged)" "$G -> HTTP 200")" yes

# 2 --- ONE failed run never pages ---------------------------------------------------------------------
new_case; export MOCK_GOOGLE=000; run
check "1st failed run: exit 1 (unit still shows failed)" "$rc" 1
check "1st failed run: NO Slack post (a single blip does not page)" "$(posts)" 0
check "1st failed run: failure counted" "$(fails_of $G)" 1

# 3 --- the 2nd consecutive failed run alerts, once ------------------------------------------------------
run
check "2nd consecutive failure: exactly ONE Slack post" "$(posts)" 1
check "alert names the failing endpoint" "$(has "$(last_post)" "$G")" yes
check "alert says how many runs failed" "$(has "$(last_post)" "2 failed run(s)")" yes
check "alert carries HTTP 000 and curl's own error" "$(has "$(last_post)" "HTTP 000 (curl: (28) Operation timed out")" yes
check "alert does not mention the healthy endpoint" "$(has "$(last_post)" "$M")" no
check "alert state recorded after delivery" "$(alerted $G)" yes

# 4 --- the same outage does not page again --------------------------------------------------------------
run
check "3rd failure: still failing (exit 1)" "$rc" 1
check "3rd failure: NO second post (deduped)" "$(posts)" 1
check "3rd failure: counter keeps counting" "$(fails_of $G)" 3

# 5 --- recovery: one message, state reset ---------------------------------------------------------------
unset MOCK_GOOGLE; run
check "recovered: exit 0" "$rc" 0
check "recovered: ONE recovery post (2 total)" "$(posts)" 2
check "recovery message says RECOVERED for the endpoint" "$(has "$(last_post)" "RECOVERED")$(has "$(last_post)" "$G answers HTTP 200 again after 3 failed run(s)")" yesyes
check "recovered: alert state cleared" "$(alerted $G)$(fails_of $G)" nonone
run
check "next healthy run: no further posts" "$(posts)" 2

# 6 --- a blip that heals before the threshold: no alert AND no recovery message --------------------------
new_case; export MOCK_GOOGLE=503; run; unset MOCK_GOOGLE; run
check "blip then success: exit 0" "$rc" 0
check "blip then success: nothing posted" "$(posts)" 0
check "blip then success: counter forgotten" "$(fails_of $G)" none

# 7 --- Slack refuses the post: loud, state NOT recorded, retried next run ----------------------------------
new_case; export MOCK_GOOGLE=000 MOCK_SLACK_FAIL=1; run; run
check "slack down: still exit 1" "$rc" 1
check "slack down: the post was attempted" "$(posts)" 1
check "slack down: logged at user.err" "$(has "$(logged)" "-p user.err ERROR: the Slack post was NOT accepted")" yes
check "slack down: alert state NOT recorded" "$(alerted $G)" no
unset MOCK_SLACK_FAIL; run
check "slack back: the alert is retried and delivered" "$(posts)" 2
check "slack back: alert state recorded" "$(alerted $G)" yes

# 8 --- no SLACK_WEBHOOK: not silent -------------------------------------------------------------------
new_case; unset SLACK_WEBHOOK; export MOCK_GOOGLE=000; run; run
check "no webhook: exit 1" "$rc" 1
check "no webhook: nothing could be posted" "$(posts)" 0
check "no webhook: warns on every run" "$(has "$(logged)" "WARNING: SLACK_WEBHOOK is not set")" yes
check "no webhook: the undeliverable alert is logged at user.err" "$(has "$(logged)" "-p user.err ERROR: SLACK_WEBHOOK is not set")$(has "$(logged)" "could NOT be delivered")" yesyes

# 9 --- reminder cadence ----------------------------------------------------------------------------
new_case; export MOCK_GOOGLE=000 ALERT_AFTER_FAILURES=2 REMIND_EVERY=3
run; run; check "reminder: alert at run 2" "$(posts)" 1
run; run; check "reminder: nothing at runs 3-4" "$(posts)" 1
run
check "reminder: labelled reminder at run 5" "$(posts)$(has "$(last_post)" "STILL FAILING (reminder)")" 2yes

# 10 --- both endpoints down: ONE combined message --------------------------------------------------------
new_case; export MOCK_GOOGLE=000 MOCK_MS=502; run; run
check "both down: one combined post" "$(posts)" 1
check "both down: names both endpoints" "$(has "$(last_post)" "$G")$(has "$(last_post)" "$M")" yesyes
check "both down: carries the 502" "$(has "$(last_post)" "HTTP 502")" yes

# 11 --- any 2xx is success ---------------------------------------------------------------------------
new_case; export MOCK_GOOGLE=204 MOCK_MS=202; run
check "2xx other than 200: exit 0" "$rc" 0
check "2xx other than 200: no alert" "$(posts)" 0

# 12 --- TEST_ALERT proves the Slack path without renewing anything -----------------------------------
new_case; export TEST_ALERT=true; run
check "TEST_ALERT: exit 0" "$rc" 0
check "TEST_ALERT: one test post" "$(posts)$(has "$(last_post)" "test alert")" 1yes
check "TEST_ALERT: renews nothing" "$(grep -c refresh-expired "${MOCK_LOG}/curl-argv.log")" 0
unset SLACK_WEBHOOK; run
check "TEST_ALERT without a webhook: exit 2 (loud)" "$rc" 2

# 13 --- unusable STATE_DIR must not silence alerts -------------------------------------------------------
new_case; : > "${CASE}/afile"; export STATE_DIR="${CASE}/afile/state" MOCK_GOOGLE=000; run
check "no state dir: exit 1" "$rc" 1
check "no state dir: alerts on the FIRST failure (fail-safe)" "$(posts)" 1
check "no state dir: says why" "$(has "$(logged)" "cannot write state")" yes

# 14 --- the internal secret still travels in a 0600 header file, never argv or logs -------------------------
new_case; export EMAIL_INGRESS_INTERNAL_SECRET="s3cr3t-Value_for.tests+/="; run
check "secret: exit 0" "$rc" 0
check "secret: sent via the header file" "$(has "$(cat "${MOCK_LOG}/hdr.log")" "X-Internal-Secret: ${EMAIL_INGRESS_INTERNAL_SECRET}")" yes
check "secret: never in curl argv" "$(has "$(cat "${MOCK_LOG}/curl-argv.log")" "${EMAIL_INGRESS_INTERNAL_SECRET}")" no
check "secret: never in the journal" "$(has "$(logged)" "${EMAIL_INGRESS_INTERNAL_SECRET}")" no

[ "$fail" -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$fail"
