#!/usr/bin/env bash
# Hermetic red/green test for check-alarm-heartbeat.sh (the analytics alarm-loop dead-man).
# Mocks curl / jq / docker on PATH (no network, no swarm, no real jq needed) and runs the REAL script.
#   bash ops/analytics-alarm-deadman/test-deadman.sh   -> exit 0 = all PASS
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/check-alarm-heartbeat.sh"
WORK="$(mktemp -d)"; trap 'rm -rf "${WORK}"' EXIT
MOCKBIN="${WORK}/mockbin"; mkdir -p "${MOCKBIN}"

fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1: expected '$3', got '$2'"; fail=1; fi; }

bash -n "${SCRIPT}" && echo "PASS  bash -n check-alarm-heartbeat.sh" || { echo "FAIL  bash -n"; exit 1; }

# --- mock curl: heartbeat URL -> scenario (MOCK_HB_BODY / MOCK_HB_HTTP / MOCK_HB_RC); anything else = Slack ----
cat > "${MOCKBIN}/curl" <<'MOCKCURL'
#!/usr/bin/env bash
args=("$@"); url="${args[$((${#args[@]}-1))]}"
out=""; usecfg=0
for ((i=0;i<${#args[@]};i++)); do
  case "${args[$i]}" in -o) out="${args[$((i+1))]}";; -K) usecfg=1;; esac
done
case "${url}" in
  */v1/internal/alarms/heartbeat)
    echo "$*" >> "${MOCK_LOG}/hb-argv.log"
    [ "${usecfg}" = 1 ] && cat >> "${MOCK_LOG}/hb-stdin.log"
    if [ "${MOCK_HB_RC:-0}" != 0 ]; then echo "curl: (7) Failed to connect (mock)" >&2; exit "${MOCK_HB_RC}"; fi
    [ -n "${out}" ] && printf '%s' "${MOCK_HB_BODY:-}" > "${out}"
    printf '%s' "${MOCK_HB_HTTP:-200}"; exit 0 ;;
  *)
    { echo "---- POST ${url}"; cat; echo; } >> "${MOCK_LOG}/slack.log"
    [ "${MOCK_SLACK_FAIL:-0}" = 1 ] && exit 22
    exit 0 ;;
esac
MOCKCURL
cat > "${MOCKBIN}/jq" <<'MOCKJQ'
#!/usr/bin/env bash
# only the one filter the script uses: -Rs '{text:.}'  (raw stdin -> {"text":"..."})
in="$(cat)"; e="${in//\\/\\\\}"; e="${e//\"/\\\"}"; e="${e//$'\n'/\\n}"; printf '{"text":"%s"}' "$e"
MOCKJQ
cat > "${MOCKBIN}/docker" <<'MOCKDOCKER'
#!/usr/bin/env bash
echo "docker $*" >> "${MOCK_LOG}/docker.log"
if [ "$1 $2" = "service inspect" ] && [ -n "${MOCK_SVC_ENV:-}" ]; then printf '%b\n' "${MOCK_SVC_ENV}"; exit 0; fi
exit 1
MOCKDOCKER
chmod +x "${MOCKBIN}/curl" "${MOCKBIN}/jq" "${MOCKBIN}/docker"
export PATH="${MOCKBIN}:${PATH}"

NOW=1793450096                                   # fixed "now" (DEADMAN_NOW_EPOCH) => deterministic ages
ts_ago() { date -u -d "@$((NOW - $1))" +%Y-%m-%dT%H:%M:%SZ; }
SECRET_VAL="s3cr3t-Value_for.tests+/="           # must never appear in argv or logs

new_case() { # fresh log dir + state dir, default env
  CASE="${WORK}/case.$RANDOM$RANDOM"; mkdir -p "${CASE}/log"
  export MOCK_LOG="${CASE}/log" STATE_DIR="${CASE}/state" DEADMAN_NOW_EPOCH="${NOW}"
  export SLACK_WEBHOOK="https://hooks.invalid/T/B/x" ANALYTICS_INTERNAL_SECRET="${SECRET_VAL}"
  export ANALYTICS_BASE_URL="https://analytics.invalid" LANE_LABEL=test
  unset ANALYTICS_SERVICE MOCK_HB_BODY MOCK_HB_HTTP MOCK_HB_RC MOCK_SLACK_FAIL MOCK_SVC_ENV TEST_ALERT
  : > "${MOCK_LOG}/slack.log"
}
run() { out="$(bash "${SCRIPT}" 2>&1)"; rc=$?; }
posts() { grep -c '^---- POST' "${MOCK_LOG}/slack.log"; }
last_post() { awk '/^---- POST/{buf=""} {buf=buf $0 "\n"} END{printf "%s", buf}' "${MOCK_LOG}/slack.log"; }
hb_body() { export MOCK_HB_BODY="$1"; }

# 1 --- fresh heartbeat: silent + healthy -----------------------------------------------------------
new_case; hb_body "{\"last_run_at\":\"$(ts_ago 120)\"}"; run
check "fresh heartbeat (2 min): exit 0" "$rc" 0
check "fresh heartbeat: NO Slack post" "$(posts)" 0

# 2 --- stale > 30 min: alerts at once (definitive) ----------------------------------------------------
new_case; hb_body "{\"last_run_at\":\"$(ts_ago 2700)\"}"; run
check "stale (45 min): exit 0 (alert delivered)" "$rc" 0
check "stale: ONE Slack post at once" "$(posts)" 1
check "stale: message says the loop STOPPED" "$(last_post | grep -c 'alarm loop has STOPPED')" 1
check "stale: message carries the last run + age" "$(last_post | grep -c '45 min ago')" 1
run
check "stale again next run: deduped (still 1 post)" "$(posts)" 1
# 3 --- reminder after REMIND_HOURS (6h) ----------------------------------------------------------------
DEADMAN_NOW_EPOCH=$((NOW + 6*3600 + 60)) run
check "stale for 6h+: REMINDER posted" "$(posts)" 2
check "reminder is labelled" "$(last_post | grep -c REMINDER)" 1
# 4 --- recovery: one RECOVERED, then silence -----------------------------------------------------------
hb_body "{\"last_run_at\":\"$(ts_ago 60)\"}"; run
check "fresh again after alert: RECOVERED posted" "$(last_post | grep -c RECOVERED)" 1
n_after_recover="$(posts)"; run
check "healthy run after RECOVERED: no further post" "$(posts)" "${n_after_recover}"

# 5 --- the call FAILS: a missing response is itself an alert (after CONFIRM_RUNS=2) -----------------------
new_case; export MOCK_HB_RC=7; run
check "1st failed call: waits (blip tolerance), no post" "$(posts)" 0
check "1st failed call: exit 0" "$rc" 0
run
check "2nd consecutive failed call: ALERT posted" "$(posts)" 1
check "failed-call alert says a missing response is an alert" "$(last_post | grep -c 'could not confirm')" 1
check "failed-call alert names the no-response cause" "$(last_post | grep -c 'no response from')" 1
run
check "3rd failed call: deduped" "$(posts)" 1
# transient blip then healthy => never alerts, state resets
new_case; export MOCK_HB_RC=7; run; export MOCK_HB_RC=0; hb_body "{\"last_run_at\":\"$(ts_ago 30)\"}"; run
check "blip then healthy: no alert at all" "$(posts)" 0
export MOCK_HB_RC=7; run
check "after a healthy run the failure counter restarted (1 failure => wait)" "$(posts)" 0

# 6 --- HTTP errors / unusable bodies are failures, not health ---------------------------------------------
new_case; export MOCK_HB_HTTP=401; hb_body '{"message":"Unauthorized"}'; run; run
check "HTTP 401 twice: alert" "$(posts)" 1
check "401 alert says the secret was REJECTED" "$(last_post | grep -c 'REJECTED')" 1
new_case; export MOCK_HB_HTTP=502; hb_body 'bad gateway'; run; run
check "HTTP 502 twice: alert" "$(last_post | grep -c 'HTTP 502')" 1
new_case; hb_body '{"last_run_at":null}'; run; run
check "last_run_at:null twice: alert (never recorded)" "$(last_post | grep -c 'no last_run_at')" 1
new_case; hb_body '{"last_run_at":"0001-01-01T00:00:00Z"}'; run; run
check "zero-time heartbeat twice: alert (never recorded a run)" "$(last_post | grep -c 'zero time')" 1
new_case; hb_body '{"last_run_at":"yesterday-ish"}'; run; run
check "garbage timestamp twice: alert" "$(last_post | grep -c 'not a valid RFC3339')" 1
new_case; hb_body "{\"last_run_at\":\"$(date -u -d "@$((NOW + 4000))" +%Y-%m-%dT%H:%M:%SZ)\"}"; run; run
check "future timestamp twice: alert (cannot judge freshness)" "$(last_post | grep -c 'FUTURE')" 1

# 7 --- response envelope variants -------------------------------------------------------------------------
new_case; hb_body "{\"data\":{\"last_run_at\":\"$(ts_ago 90)\"},\"message\":\"ok\"}"; run
check "{data:{last_run_at}} envelope, fresh: silent" "$(posts)" 0
new_case; hb_body "{\"data\":{\"last_run_at\":\"$(ts_ago 4000).123456789Z\"},\"message\":\"ok\"}"; hb_body "{\"data\":{\"last_run_at\":\"$(date -u -d "@$((NOW-4000))" +%Y-%m-%dT%H:%M:%S).123456789+00:00\"},\"message\":\"ok\"}"; run
check "envelope + nanoseconds + numeric offset, stale: alert" "$(posts)" 1

# 8 --- fail loud: no webhook; Slack down; no secret ---------------------------------------------------------
new_case; unset SLACK_WEBHOOK; hb_body "{\"last_run_at\":\"$(ts_ago 60)\"}"; run
check "no SLACK_WEBHOOK: exit 2 (loud)" "$rc" 2
check "no SLACK_WEBHOOK: says it cannot deliver" "$(echo "$out" | grep -c 'cannot deliver')" 1
check "no SLACK_WEBHOOK: never called the heartbeat" "$(test -f "${MOCK_LOG}/hb-argv.log" && echo called || echo none)" none
new_case; export MOCK_SLACK_FAIL=1; hb_body "{\"last_run_at\":\"$(ts_ago 2700)\"}"; run
check "Slack down while alert due: exit 1 (loud)" "$rc" 1
check "Slack down: alert state NOT recorded" "$(test -f "${STATE_DIR}/state" && echo saved || echo none)" none
export MOCK_SLACK_FAIL=0; run
check "Slack back up: the alert is retried and delivered" "$(last_post | grep -c 'STOPPED')" 1
check "...and that run exits 0" "$rc" 0
new_case; unset ANALYTICS_INTERNAL_SECRET; hb_body "{\"last_run_at\":\"$(ts_ago 60)\"}"; run
check "no secret configured: ALERTS (config) at once" "$(last_post | grep -c 'cannot RUN')" 1
check "no secret configured: unit stays RED (exit 2)" "$rc" 2
check "no secret configured: heartbeat never called" "$(test -f "${MOCK_LOG}/hb-argv.log" && echo called || echo none)" none

# 9 --- the secret: read from the swarm service spec, handed over on STDIN, never in argv / output ---------------
new_case; unset ANALYTICS_INTERNAL_SECRET; export ANALYTICS_SERVICE=analytics-test-svc
export MOCK_SVC_ENV="FOO=bar\nINTERNAL_SERVICES_WEBHOOK_SECRET=${SECRET_VAL}\nZED=1"
hb_body "{\"last_run_at\":\"$(ts_ago 60)\"}"; run
check "secret from the service spec: check runs healthy" "$rc" 0
check "service spec was read via docker service inspect" "$(grep -c 'service inspect analytics-test-svc' "${MOCK_LOG}/docker.log")" 1
check "secret reached curl on STDIN as the X-Internal-Secret header" "$(grep -c "X-Internal-Secret: ${SECRET_VAL}" "${MOCK_LOG}/hb-stdin.log")" 1
check "secret is NOT in curl's argv" "$(grep -cF "${SECRET_VAL}" "${MOCK_LOG}/hb-argv.log")" 0
check "secret is NOT in the script output" "$(echo "$out" | grep -cF "${SECRET_VAL}")" 0
check "header-only auth: no ?secret= query form" "$(grep -c 'secret=' "${MOCK_LOG}/hb-argv.log")" 0
new_case; export ANALYTICS_INTERNAL_SECRET='bad"secret
x'; run
check "a secret with unexpected characters is refused (config alert)" "$(last_post | grep -c 'unexpected characters')" 1

# 10 --- TEST_ALERT validates the path without touching state ------------------------------------------------
new_case; export TEST_ALERT=true; hb_body "{\"last_run_at\":\"$(ts_ago 60)\"}"; run
check "TEST_ALERT posts one message" "$(posts)" 1
check "TEST_ALERT leaves no dedupe state" "$(test -f "${STATE_DIR}/state" && echo saved || echo none)" none

echo "----"
[ "$fail" -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$fail"
