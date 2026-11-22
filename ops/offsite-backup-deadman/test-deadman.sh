#!/usr/bin/env bash
# Hermetic red/green test for check-offsite-backup.sh (the offsite-backup dead-man, #1255).
# Mocks aws / curl / jq on PATH (no network, no AWS) and runs the REAL script.
#   bash ops/offsite-backup-deadman/test-deadman.sh   -> exit 0 = all PASS
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/check-offsite-backup.sh"
WORK="$(mktemp -d)"; trap 'rm -rf "${WORK}"' EXIT
MOCKBIN="${WORK}/mockbin"; mkdir -p "${MOCKBIN}"

fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1: expected '$3', got '$2'"; fail=1; fi; }

bash -n "${SCRIPT}" && echo "PASS  bash -n check-offsite-backup.sh" || { echo "FAIL  bash -n"; exit 1; }

cat > "${MOCKBIN}/aws" <<'MOCKAWS'
#!/usr/bin/env bash
echo "aws $*" >> "${MOCK_LOG}/aws.log"
if [ "${MOCK_AWS_RC:-0}" != 0 ]; then echo "${MOCK_AWS_ERR:-An error occurred (AccessDenied) when calling the ListObjectsV2 operation}" >&2; exit "${MOCK_AWS_RC}"; fi
printf '%s\n' "${MOCK_AWS_OUT:-None}"
MOCKAWS
cat > "${MOCKBIN}/curl" <<'MOCKCURL'
#!/usr/bin/env bash
{ echo "---- POST"; cat; echo; } >> "${MOCK_LOG}/slack.log"
[ "${MOCK_SLACK_FAIL:-0}" = 1 ] && exit 22
exit 0
MOCKCURL
cat > "${MOCKBIN}/jq" <<'MOCKJQ'
#!/usr/bin/env bash
in="$(cat)"; e="${in//\\/\\\\}"; e="${e//\"/\\\"}"; e="${e//$'\n'/\\n}"; printf '{"text":"%s"}' "$e"
MOCKJQ
chmod +x "${MOCKBIN}/aws" "${MOCKBIN}/curl" "${MOCKBIN}/jq"
export PATH="${MOCKBIN}:${PATH}"

NOW=1795400000                                   # fixed "now" => deterministic ages
ts_ago() { date -u -d "@$((NOW - $1))" +%Y-%m-%dT%H:%M:%S+00:00; }

new_case() {
  CASE="${WORK}/case.$RANDOM$RANDOM"; mkdir -p "${CASE}/log"
  export MOCK_LOG="${CASE}/log" STATE_DIR="${CASE}/state" DEADMAN_NOW_EPOCH="${NOW}"
  export SLACK_WEBHOOK="https://hooks.invalid/T/B/x" LANE_LABEL=test
  unset MOCK_AWS_OUT MOCK_AWS_RC MOCK_AWS_ERR MOCK_SLACK_FAIL TEST_ALERT
}
run() { bash "${SCRIPT}" >"${CASE}/out" 2>&1; echo $?; }
posts() { grep -c '^---- POST' "${MOCK_LOG}/slack.log" 2>/dev/null || echo 0; }
kind() { sed -n 's/^kind=//p' "${STATE_DIR}/state" 2>/dev/null | head -1; }

# 1. fresh backup (3 h old) -> no alert, exit 0
new_case; export MOCK_AWS_OUT="$(ts_ago 10800)"
check "fresh: exit 0" "$(run)" 0
check "fresh: no Slack post" "$(posts)" 0

# 2. stale backup (30 h old) -> one alert, state kind=stale
new_case; export MOCK_AWS_OUT="$(ts_ago 108000)"
check "stale: exit 0" "$(run)" 0
check "stale: one Slack post" "$(posts)" 1
check "stale: state kind" "$(kind)" stale
grep -q "STALE" "${MOCK_LOG}/slack.log" && echo "PASS  stale: message says STALE" || { echo "FAIL  stale: message"; fail=1; }
# 2b. same stale again within REMIND_HOURS -> suppressed
check "stale again: exit 0" "$(run)" 0
check "stale again: still one post (deduped)" "$(posts)" 1
# 2c. backup fresh again -> RECOVERED
export MOCK_AWS_OUT="$(ts_ago 3600)"
check "recover: exit 0" "$(run)" 0
check "recover: second post" "$(posts)" 2
grep -q "RECOVERED" "${MOCK_LOG}/slack.log" && echo "PASS  recover: RECOVERED message" || { echo "FAIL  recover message"; fail=1; }
check "recover: state cleared" "$(kind)" ""

# 3. empty prefix (the 2026-11 incident) -> stale alert immediately
new_case; export MOCK_AWS_OUT="None"
check "empty: exit 0" "$(run)" 0
check "empty: one post" "$(posts)" 1
grep -q "EMPTY" "${MOCK_LOG}/slack.log" && echo "PASS  empty: message says EMPTY" || { echo "FAIL  empty message"; fail=1; }

# 4. AWS read fails once -> wait (CONFIRM_RUNS=2), twice -> alert mentioning the credential
new_case; export MOCK_AWS_RC=255
check "aws fail 1: exit 0" "$(run)" 0
check "aws fail 1: no post yet" "$(posts)" 0
check "aws fail 2: exit 0" "$(run)" 0
check "aws fail 2: one post" "$(posts)" 1
grep -q "READ-ONLY credential was rejected" "${MOCK_LOG}/slack.log" && echo "PASS  aws fail: names the credential" || { echo "FAIL  aws fail message"; fail=1; }

# 5. no SLACK_WEBHOOK -> exit 2 (fail loud)
new_case; unset SLACK_WEBHOOK; export MOCK_AWS_OUT="$(ts_ago 108000)"
check "no webhook: exit 2" "$(run)" 2

# 6. Slack down on a stale alert -> exit 1 and the alert is NOT recorded (retried next run)
new_case; export MOCK_AWS_OUT="$(ts_ago 108000)" MOCK_SLACK_FAIL=1
check "slack down: exit 1" "$(run)" 1
check "slack down: state not recorded" "$(kind)" ""

# 8. more than 1000 objects: the CLI prints one max PER PAGE; the newest page decides (older page first)
new_case; export MOCK_AWS_OUT="$(ts_ago 200000)
$(ts_ago 3600)"
check "multi-page: exit 0" "$(run)" 0
check "multi-page: newest page wins, no alert" "$(posts)" 0
# 8b. multi-page where every page is old -> still stale
new_case; export MOCK_AWS_OUT="$(ts_ago 200000)
$(ts_ago 100000)"
check "multi-page old: exit 0" "$(run)" 0
check "multi-page old: one stale post" "$(posts)" 1

# 7. the prefix + read-only profile reach aws as configured
new_case; export MOCK_AWS_OUT="$(ts_ago 7200)" S3_PREFIX="postgres/prod/"
run >/dev/null
grep -q -- "--prefix postgres/prod/" "${MOCK_LOG}/aws.log" && echo "PASS  aws called with the prod prefix" || { echo "FAIL  aws prefix"; fail=1; }

[ "$fail" -eq 0 ] && echo "ALL PASS" || echo "SOME FAILED"
exit "$fail"
