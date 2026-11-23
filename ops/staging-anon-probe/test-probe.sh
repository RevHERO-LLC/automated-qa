#!/usr/bin/env bash
# Hermetic red/green test for probe-staging-anon.sh (the staging anonymous-access probe, plan P5-D6).
# Mocks curl on PATH (no network, no Slack) and runs the REAL script. jq must be the real one (it classifies bodies).
#   bash ops/staging-anon-probe/test-probe.sh   -> exit 0 = all PASS
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/probe-staging-anon.sh"
WORK="$(mktemp -d)"; trap 'rm -rf "${WORK}"' EXIT
MOCKBIN="${WORK}/mockbin"; BODIES="${WORK}/bodies"; mkdir -p "${MOCKBIN}" "${BODIES}"

fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1: expected '$3', got '$2'"; fail=1; fi; }
yes_if() { if [ "$2" = 1 ]; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }

command -v jq >/dev/null 2>&1 || { echo "FAIL  the real jq is required (it classifies response bodies)"; exit 1; }
bash -n "${SCRIPT}" && echo "PASS  bash -n probe-staging-anon.sh" || { echo "FAIL  bash -n"; exit 1; }

# ---- mock curl: GET answers come from a table, the Slack POST is recorded. Mirrors the real -w / -o behaviour. ----
cat > "${MOCKBIN}/curl" <<'MOCKCURL'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${MOCK_LOG}/curl.args"
post=0; for a in "$@"; do [ "$a" = "-X" ] && post=1; done
if [ "$post" = 1 ]; then { echo "---- POST"; cat; echo; } >> "${MOCK_LOG}/slack.log"; [ "${MOCK_SLACK_FAIL:-0}" = 1 ] && exit 22; exit 0; fi
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w|--connect-timeout|--max-time|--max-filesize|-A|-H) shift 2 ;;
    -q|-sS|-s|-S) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "$url" >> "${MOCK_LOG}/get.urls"
[ -n "${MOCK_SLOW_FIRST:-}" ] && [ "$(wc -l < "${MOCK_LOG}/get.urls")" -eq 1 ] && sleep "${MOCK_SLOW_FIRST}"
n="$(grep -c -F -x "$url" "${MOCK_LOG}/get.urls")"
mapfile -t lines < <(grep -F "${url}"$'\t' "${MOCK_ROUTES}")
if [ "${#lines[@]}" -eq 0 ]; then echo "curl: (6) Could not resolve host: mock" >&2; printf '000\t0\t'; exit 6; fi
idx=$((n - 1)); [ "$idx" -ge "${#lines[@]}" ] && idx=$((${#lines[@]} - 1))
IFS=$'\t' read -r _ code body rc <<<"${lines[$idx]}"
rc="${rc:-0}"
: > "$out"; [ -n "$body" ] && [ "$body" != "-" ] && cp "${MOCK_BODIES}/${body}" "$out"
ctype="application/json"; case "$body" in *.html) ctype="text/html; charset=utf-8" ;; esac
[ "$rc" != 0 ] && [ "$rc" != 63 ] && { echo "curl: (${rc}) mock failure" >&2; printf '000\t0\t'; exit "$rc"; }
size="$(wc -c < "$out" | tr -d ' ')"; [ "$rc" = 63 ] && size=2000001
printf '%s\t%s\t%s' "$code" "$size" "$ctype"; exit "$rc"
MOCKCURL
chmod +x "${MOCKBIN}/curl"
export PATH="${MOCKBIN}:${PATH}"
export MOCK_BODIES="${BODIES}"

SENT="SENTINEL-TENANT-DATA-4417"
printf '{"data":[{"id":7,"email":"%s"}],"total":1}' "$SENT" > "${BODIES}/data.json"
printf '{"data":[],"total":0}'                                  > "${BODIES}/empty-list.json"
printf '{"error":"unauthorized"}'                               > "${BODIES}/error200.json"
printf '<html><body>%s</body></html>' "$SENT"                   > "${BODIES}/page.html"
printf '{"error":"missing token"}'                              > "${BODIES}/unauth.json"
printf '{"message":"Conversations retrieved","pagination":{"current_page":1,"per_page":10,"total_count":0,"total_pages":0}}' > "${BODIES}/paginated-empty.json"
printf '{"data":{"error":"Key: ParentUserID failed on the required tag"},"message":"Invalid query parameters"}' > "${BODIES}/invalid400.json"
printf '{"data":{"summary":{"campaigns":[],"computed_at":null,"totals":{"messages_sent":0,"deals_won":0}}},"message":"ok"}' > "${BODIES}/zero-summary.json"

NOW=1795400000
U_API=https://api.staging.revhero.ai; U_USR=https://users-service.test.revhero.io; U_SMS=https://sms-service.test.revhero.io
R_PROFILE="${U_API}/v1/user/profile"; R_CAMP="${U_API}/v1/campaigns/list"; R_ADMIN="${U_API}/v1/admin/users/all"
R_HOL="${U_USR}/v1/holidays/user/999999999"; R_CRED="${U_USR}/v1/credit/user/999999999"; R_SMS="${U_SMS}/v1/messages/conversations"
URLS=("$R_PROFILE" "$R_CAMP" "$R_ADMIN" "$R_HOL" "$R_CRED" "$R_SMS")

write_targets() { # CRLF on purpose, with comments and a blank line: the parser must cope
  printf '# test targets\r\n\r\n%s /v1/user/profile users\r\n%s /v1/campaigns/list campaigns\r\n%s /v1/admin/users/all admin\r\n%s/ /v1/holidays/user/999999999 users\r\n%s /v1/credit/user/999999999 users\r\n%s /v1/messages/conversations inbox\r\n' \
    "$U_API" "$U_API" "$U_API" "$U_USR" "$U_USR" "$U_SMS" > "${WORK}/targets"
}
table_reset() { : > "${MOCK_ROUTES}"; for u in "${URLS[@]}"; do printf '%s\t401\tunauth.json\t0\n' "$u" >> "${MOCK_ROUTES}"; done; }
set_route() { # url code [body] [rc]   (replaces every line for that url)
  grep -v -F "$1"$'\t' "${MOCK_ROUTES}" > "${MOCK_ROUTES}.tmp"; printf '%s\t%s\t%s\t%s\n' "$1" "$2" "${3:--}" "${4:-0}" >> "${MOCK_ROUTES}.tmp"; mv "${MOCK_ROUTES}.tmp" "${MOCK_ROUTES}"; }
add_attempt() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "${3:--}" "${4:-0}" >> "${MOCK_ROUTES}"; }

new_case() {
  CASE="${WORK}/case.$RANDOM$RANDOM"; mkdir -p "${CASE}/log"
  export MOCK_LOG="${CASE}/log" MOCK_ROUTES="${CASE}/routes" STATE_DIR="${CASE}/state" PROBE_NOW_EPOCH="${NOW}"
  export SLACK_WEBHOOK="https://hooks.invalid/T/B/x" LANE_LABEL=test PROBE_VANTAGE=test-host RETRY_SLEEP=0
  export TARGETS_FILE="${WORK}/targets"
  unset MOCK_SLACK_FAIL MOCK_SLOW_FIRST TEST_ALERT PROBE_NO_SLACK RETRIES BUDGET_SECS MIN_EVALUATED_PCT CONFIRM_RUNS REMIND_HOURS
  : > "${MOCK_LOG}/get.urls"; : > "${MOCK_LOG}/curl.args"; : > "${MOCK_LOG}/slack.log"
  write_targets; table_reset
}
run() { bash "${SCRIPT}" >"${CASE}/out" 2>&1; echo $?; }
posts() { local c; c="$(grep -c '^---- POST' "${MOCK_LOG}/slack.log" 2>/dev/null)"; echo "${c:-0}"; }
kind() { sed -n 's/^kind=//p' "${STATE_DIR}/state" 2>/dev/null | head -1; }
gets() { wc -l < "${MOCK_LOG}/get.urls" | tr -d ' '; }
slack_has() { grep -q -- "$1" "${MOCK_LOG}/slack.log" && echo 1 || echo 0; }
out_has() { grep -q -- "$1" "${CASE}/out" && echo 1 || echo 0; }
no_sentinel() { # nothing a response body held may appear in the report, the log, Slack or the state file
  if grep -q "$SENT" "${CASE}/out" "${MOCK_LOG}/slack.log" "${STATE_DIR}/state" 2>/dev/null; then echo 0; else echo 1; fi; }

# ---------------------------------------------------------------- pure functions
PROBE_LIB_ONLY=1 source "${SCRIPT}"
for h in https://api.staging.revhero.ai https://users-service.test.revhero.io https://api.staging2.revhero.io https://config.test.revhero.ai https://a.b.test.revhero.io; do
  is_staging_host "$h" && echo "PASS  staging host accepted: $h" || { echo "FAIL  staging host refused: $h"; fail=1; }
done
for h in https://api.revhero.ai https://users-service.revhero.io https://internal-analytics.revhero.io https://staging.revhero.ai http://api.staging.revhero.ai \
         https://api.staging.revhero.ai:8443 https://api.staging.revhero.ai@evil.com https://api.staging.revhero.ai.evil.com https://evil-test.revhero.io \
         https://API.staging.revhero.ai https://test.revhero.io "https://api.staging.revhero.ai/x" ""; do
  is_staging_host "$h" && { echo "FAIL  must be refused: '$h'"; fail=1; } || echo "PASS  refused: '$h'"
done
check "classify 401" "$(classify 401)" refused;  check "classify 403" "$(classify 403)" refused
check "classify 200" "$(classify 200)" 2xx;      check "classify 204" "$(classify 204)" 2xx
check "classify 302" "$(classify 302)" redirect; check "classify 404" "$(classify 404)" absent
check "classify 405" "$(classify 405)" absent;   check "classify 410" "$(classify 410)" absent
check "classify 400" "$(classify 400)" invalid;  check "classify 422" "$(classify 422)" invalid
check "classify 429" "$(classify 429)" error;    check "classify 503" "$(classify 503)" error
check "classify 000" "$(classify 000)" error
echo '{"data":[{"id":1}]}'                  > "${WORK}/b1"; check "has_data: non-empty array"        "$(has_data "${WORK}/b1")" data
echo '{"data":[],"total":0,"page":1}'       > "${WORK}/b2"; check "has_data: empty list + envelope"  "$(has_data "${WORK}/b2")" nodata
echo '{"error":"missing token","code":401}' > "${WORK}/b3"; check "has_data: error envelope"         "$(has_data "${WORK}/b3")" nodata
echo '{"id":9,"email":"a@b.c"}'             > "${WORK}/b4"; check "has_data: a record object"        "$(has_data "${WORK}/b4")" data
echo '[]'                                   > "${WORK}/b5"; check "has_data: empty top-level array"  "$(has_data "${WORK}/b5")" nodata
echo '[{"id":1}]'                           > "${WORK}/b6"; check "has_data: top-level array"        "$(has_data "${WORK}/b6")" data
echo '<html>x</html>'                       > "${WORK}/b7"; check "has_data: not JSON"               "$(has_data "${WORK}/b7")" nonjson
echo '{"data":null}'                        > "${WORK}/b8"; check "has_data: null data"              "$(has_data "${WORK}/b8")" nodata
# the real sms-service shape that was a false LEAK: a message plus a pagination object, no records
echo '{"message":"Conversations retrieved","pagination":{"current_page":1,"per_page":10,"total_count":0,"total_pages":0}}' > "${WORK}/b9"
check "has_data: message + pagination counters only (sms-service)" "$(has_data "${WORK}/b9")" nodata
echo '{"message":"ok"}'                                         > "${WORK}/b10"; check "has_data: message only"             "$(has_data "${WORK}/b10")" nodata
echo '{"data":{"items":[],"meta":{"page":3,"last_page":9,"links":{"next":"x"}}}}' > "${WORK}/b11"; check "has_data: empty items + meta + links" "$(has_data "${WORK}/b11")" nodata
echo '{"data":[{"id":1}],"pagination":{"current_page":1,"total_pages":1}}' > "${WORK}/b12"; check "has_data: a record beside pagination" "$(has_data "${WORK}/b12")" data
echo '{"message":"ok","pagination":{"current_page":1},"owner":"someone"}' > "${WORK}/b13"; check "has_data: a stray scalar outside the envelope" "$(has_data "${WORK}/b13")" data
echo '{"data":{"enabled":true}}'                                > "${WORK}/b14"; check "has_data: a true setting is data"          "$(has_data "${WORK}/b14")" data
# defaults for a tenant that does not exist are not records: zero, false, empty string, null
echo '{"data":{"enabled":false}}'                               > "${WORK}/b15"; check "has_data: a false setting is a default"  "$(has_data "${WORK}/b15")" nodata
echo '{"data":{"rows":[]},"message":"ok"}'                      > "${WORK}/b16"; check "has_data: empty rows"                    "$(has_data "${WORK}/b16")" nodata
# the real analytics shape that was a false LEAK: a zero-filled summary
echo '{"data":{"summary":{"campaigns":[],"computed_at":null,"totals":{"messages_sent":0,"deals_won":0,"revenue_generated":0}}},"message":"ok"}' > "${WORK}/b17"
check "has_data: zero-filled summary (analytics)" "$(has_data "${WORK}/b17")" nodata
echo '{"data":{"summary":{"campaigns":[],"totals":{"messages_sent":57,"deals_won":0}}}}' > "${WORK}/b18"
check "has_data: a summary with a non-zero counter is data" "$(has_data "${WORK}/b18")" data
echo '{"data":{"name":"","owner":null,"count":0,"balance":0.0}}' > "${WORK}/b19"; check "has_data: empty string, null and zeros" "$(has_data "${WORK}/b19")" nodata
echo '{"data":{"balance":12.5}}'                               > "${WORK}/b20"; check "has_data: a non-zero decimal is data"   "$(has_data "${WORK}/b20")" data
echo '{"data":{"email":"someone@example.com"}}'                > "${WORK}/b21"; check "has_data: a non-empty string is data"   "$(has_data "${WORK}/b21")" data
unset PROBE_LIB_ONLY

# ---------------------------------------------------------------- 1. everything refused
new_case; set_route "$R_ADMIN" 403 unauth.json
check "clean: exit 0" "$(run)" 0
check "clean: no Slack post" "$(posts)" 0
check "clean: one GET per target (6, CRLF targets file parsed)" "$(gets)" 6
check "clean: state is clean" "$(kind)" ""
yes_if "clean: report table printed" "$(out_has 'refused  ')"
# every request is a bare anonymous GET
yes_if "requests: curl -q is the first argument of every GET" "$(grep -v -- '-X POST' "${MOCK_LOG}/curl.args" | awk '{ if ($1 != "-q") bad=1 } END { print bad ? 0 : 1 }')"
yes_if "requests: no credential, cookie or auth flag anywhere" "$(grep -i -E -- 'authorization|cookie| -u |--user|--oauth2|bearer| -b |-K |--netrc|x-internal-secret' "${MOCK_LOG}/curl.args" >/dev/null && echo 0 || echo 1)"
yes_if "requests: the only -X is the Slack POST (none here)" "$(grep -c -- '-X' "${MOCK_LOG}/curl.args" | awk '{ print ($1 == 0) ? 1 : 0 }')"
yes_if "requests: every GET target is a staging host" "$(grep -v -E '^https://(api\.staging\.revhero\.ai|users-service\.test\.revhero\.io|sms-service\.test\.revhero\.io)/' "${MOCK_LOG}/get.urls" | wc -l | awk '{ print ($1 == 0) ? 1 : 0 }')"
yes_if "requests: a redirect is never followed (no -L)" "$(grep -c -- ' -L ' "${MOCK_LOG}/curl.args" | awk '{ print ($1 == 0) ? 1 : 0 }')"

# ---------------------------------------------------------------- 2. a leak: alert, dedupe, changed set, recovery
new_case; set_route "$R_HOL" 200 data.json
check "leak: exit 0" "$(run)" 0
check "leak: one Slack post" "$(posts)" 1
check "leak: state kind" "$(kind)" leak
yes_if "leak: the message names the host, the path and the status" "$(slack_has 'users-service.test.revhero.io GET /v1/holidays/user/999999999 -> 200')"
yes_if "leak: the message says records were returned" "$(slack_has 'WITH records')"
check "leak: NO response-body content in the report, the Slack message or the state" "$(no_sentinel)" 1
check "leak again: exit 0" "$(run)" 0
check "leak again: still one post (deduped)" "$(posts)" 1
set_route "$R_CRED" 200 data.json
check "second route leaks: exit 0" "$(run)" 0
check "second route leaks: alerts at once (changed set)" "$(posts)" 2
set_route "$R_HOL" 401 unauth.json; set_route "$R_CRED" 401 unauth.json
check "fixed: exit 0" "$(run)" 0
check "fixed: RECOVERED posted" "$(posts)" 3
yes_if "fixed: the message says RECOVERED" "$(slack_has 'RECOVERED')"
check "fixed: state cleared" "$(kind)" ""
check "recovered then clean again: no more posts" "$( run >/dev/null; posts )" 3

# ---------------------------------------------------------------- 2b. a persisting leak reminds after REMIND_HOURS
new_case; set_route "$R_HOL" 200 data.json
run >/dev/null
export PROBE_NOW_EPOCH=$((NOW + 40 * 3600)); run >/dev/null
check "remind: not yet at 40 h (REMIND_HOURS 46)" "$(posts)" 1
export PROBE_NOW_EPOCH=$((NOW + 47 * 3600)); run >/dev/null
check "remind: re-alerts after 47 h" "$(posts)" 2
yes_if "remind: the message says REMINDER" "$(slack_has 'REMINDER')"

# ---------------------------------------------------------------- 3. 2xx without records is still a finding
new_case; set_route "$R_CAMP" 200 empty-list.json
check "open (empty list): exit 0" "$(run)" 0
check "open (empty list): one post" "$(posts)" 1
check "open (empty list): state kind" "$(kind)" open
yes_if "open: the message explains no records is not proof of auth" "$(slack_has 'no records seen')"
new_case; set_route "$R_CAMP" 200 error200.json
check "open (200 with an error body): exit 0" "$(run)" 0
check "open (200 with an error body): one post" "$(posts)" 1
check "open (200 with an error body): kind" "$(kind)" open
new_case; set_route "$R_CAMP" 200 page.html
run >/dev/null; check "open (non-JSON body): kind" "$(kind)" open
yes_if "open (non-JSON body): says not JSON" "$(slack_has 'not JSON')"
check "open (non-JSON body): body text never leaves the box" "$(no_sentinel)" 1
new_case; set_route "$R_CAMP" 204 -
run >/dev/null; check "open (204 empty): kind" "$(kind)" open
yes_if "open (204 empty): says empty body" "$(slack_has 'empty body')"
# the real sms-service answer (an empty paginated envelope) is "open", NOT a leak
new_case; set_route "$R_SMS" 200 paginated-empty.json
check "empty paginated envelope: exit 0" "$(run)" 0
check "empty paginated envelope: one post" "$(posts)" 1
check "empty paginated envelope: kind is open, not leak" "$(kind)" open
yes_if "empty paginated envelope: the message does not claim records" "$([ "$(slack_has 'WITH records')" = 0 ] && echo 1 || echo 0)"
# the real analytics answer (a zero-filled summary for a nonexistent tenant) is "open", NOT a leak
new_case; set_route "$R_CRED" 200 zero-summary.json
run >/dev/null; check "zero-filled summary: kind is open, not leak" "$(kind)" open
# leak outranks open when both are present
new_case; set_route "$R_CAMP" 200 empty-list.json; set_route "$R_HOL" 200 data.json
run >/dev/null; check "leak outranks open: kind" "$(kind)" leak
yes_if "leak outranks open: both routes listed" "$(( $(slack_has 'campaigns/list') & $(slack_has 'holidays') ))"
# a body over the 2 MB cap is data by definition
new_case; set_route "$R_HOL" 200 data.json 63
run >/dev/null; check "oversize body (curl rc 63): leak" "$(kind)" leak
yes_if "oversize body: says over 2 MB" "$(slack_has 'over 2 MB')"

# ---------------------------------------------------------------- 4. could not evaluate: needs CONFIRM_RUNS, host with no evaluable route
new_case; set_route "$R_SMS" 404 -
check "host with only 404s: run 1 exit 0" "$(run)" 0
check "host with only 404s: run 1 waits (no post)" "$(posts)" 0
check "host with only 404s: run 2 exit 0" "$(run)" 0
check "host with only 404s: run 2 alerts" "$(posts)" 1
check "host with only 404s: state kind" "$(kind)" failed
yes_if "host with only 404s: names the blind host" "$(slack_has 'NO evaluable route on: sms-service.test.revhero.io')"
check "host with only 404s: run 3 deduped" "$(run >/dev/null; posts)" 1
set_route "$R_SMS" 401 unauth.json
check "host answers again: RECOVERED" "$(run >/dev/null; posts)" 2
# 400 = rejected as malformed: reported as "invalid", never a pass, and a host with nothing else is blind
new_case; set_route "$R_SMS" 400 invalid400.json; export PROBE_NO_SLACK=1
check "a 400: report mode exit 4 (host has no evaluable route)" "$(run)" 4
yes_if "a 400: counted as invalid, not absent" "$(out_has 'invalid=1')"
yes_if "a 400: the row says invalid" "$(out_has 'invalid *400')"
new_case; set_route "$R_SMS" 400 invalid400.json
check "a 400 on a host's only route: run 1 waits" "$(run >/dev/null; posts)" 0
check "a 400 on a host's only route: run 2 alerts (blind host)" "$(run >/dev/null; posts)" 1
yes_if "a 400 on a host's only route: names the blind host" "$(slack_has 'NO evaluable route on: sms-service.test.revhero.io')"
new_case; set_route "$R_PROFILE" 000 - 28
check "timeout on one route: run 1 waits" "$(run >/dev/null; posts)" 0
check "timeout on one route: run 2 alerts" "$(run >/dev/null; posts)" 1
yes_if "timeout on one route: kind failed" "$([ "$(kind)" = failed ] && echo 1 || echo 0)"
new_case; export MIN_EVALUATED_PCT=60; set_route "$R_PROFILE" 401 unauth.json; set_route "$R_CAMP" 404 -; set_route "$R_ADMIN" 404 -; set_route "$R_CRED" 404 -
check "3 of 6 evaluated < 60%: run 1 waits" "$(run >/dev/null; posts)" 0
check "3 of 6 evaluated < 60%: run 2 alerts" "$(run >/dev/null; posts)" 1
yes_if "3 of 6 evaluated: says the threshold" "$(slack_has 'threshold 60%')"
check "failed with CONFIRM_RUNS=1 alerts at once" "$( new_case; export CONFIRM_RUNS=1; set_route "$R_PROFILE" 000 - 28; run >/dev/null; posts )" 1

# ---------------------------------------------------------------- 5. retries
new_case; set_route "$R_PROFILE" 503 -; add_attempt "$R_PROFILE" 401 unauth.json
check "retry: 503 then 401 -> clean, exit 0" "$(run)" 0
check "retry: the route was requested twice" "$(grep -c -F -x "$R_PROFILE" "${MOCK_LOG}/get.urls")" 2
check "retry: no post" "$(posts)" 0
new_case; export RETRIES=0; set_route "$R_PROFILE" 503 -; add_attempt "$R_PROFILE" 401 unauth.json
run >/dev/null; check "RETRIES=0: no second try" "$(grep -c -F -x "$R_PROFILE" "${MOCK_LOG}/get.urls")" 1

# ---------------------------------------------------------------- 6. fail loud
new_case; unset SLACK_WEBHOOK; set_route "$R_HOL" 200 data.json
check "no webhook: exit 2" "$(run)" 2
new_case; export MOCK_SLACK_FAIL=1; set_route "$R_HOL" 200 data.json
check "slack down: exit 1" "$(run)" 1
check "slack down: alert NOT recorded (retried next run)" "$(kind)" ""
new_case; export TEST_ALERT=true
check "TEST_ALERT: exit 0" "$(run)" 0
check "TEST_ALERT: one post" "$(posts)" 1
yes_if "TEST_ALERT: says Slack path OK" "$(slack_has 'Slack path OK')"

# ---------------------------------------------------------------- 7. staging only, enforced in code
new_case; printf '%s /v1/user/profile users\nhttps://api.revhero.ai /v1/user/profile users\n' "$U_API" > "${WORK}/targets"
check "prod host in the targets: exit 2" "$(run)" 2
check "prod host in the targets: NOT ONE request was made" "$(gets)" 0
yes_if "prod host in the targets: a config alert names the refusal" "$(slack_has 'REFUSING to probe')"
check "prod host in the targets: kind config recorded" "$(kind)" config
new_case; printf 'https://staging.revhero.ai /v1/x users\n' > "${WORK}/targets"
check "the FE host (no subdomain) is refused too: exit 2" "$(run)" 2
new_case; printf '%s\n' "$U_API" > "${WORK}/targets"
check "a line with no path: exit 2" "$(run)" 2
new_case; printf '%s v1/no-leading-slash users\n' "$U_API" > "${WORK}/targets"
check "a path without a leading slash: exit 2" "$(run)" 2
new_case; : > "${WORK}/targets"
check "an empty targets file: exit 2 (never a silent pass)" "$(run)" 2
new_case; export TARGETS_FILE="${WORK}/does-not-exist"
check "a missing targets file: exit 2" "$(run)" 2

# ---------------------------------------------------------------- 8. time budget
new_case; export BUDGET_SECS=1 MOCK_SLOW_FIRST=1.3 PROBE_NO_SLACK=1
run >/dev/null; yes_if "budget: later targets are reported as skipped, not as healthy" "$(out_has 'time budget')"

# ---------------------------------------------------------------- 9. report mode (the manual run)
new_case; export PROBE_NO_SLACK=1; unset SLACK_WEBHOOK
check "report mode, clean: exit 0 (no webhook needed)" "$(run)" 0
check "report mode, clean: no post, no state file" "$(posts)$([ -e "${STATE_DIR}/state" ] && echo S || echo -)" "0-"
new_case; export PROBE_NO_SLACK=1; set_route "$R_HOL" 200 data.json
check "report mode, leak: exit 3" "$(run)" 3
check "report mode, leak: nothing posted, no state" "$(posts)$([ -e "${STATE_DIR}/state" ] && echo S || echo -)" "0-"
yes_if "report mode, leak: the table shows the route" "$(out_has 'leak ')"
check "report mode, leak: NO body content in the output" "$(no_sentinel)" 1
new_case; export PROBE_NO_SLACK=1; set_route "$R_HOL" 200 page.html
run >/dev/null; check "report mode, html 200: NO body content in the output" "$(no_sentinel)" 1
new_case; export PROBE_NO_SLACK=1; for u in "${URLS[@]}"; do set_route "$u" 404 -; done
check "report mode, all absent: exit 4 (could not evaluate)" "$(run)" 4
new_case; export PROBE_NO_SLACK=1; printf 'https://api.revhero.ai /v1/x users\n' > "${WORK}/targets"
check "report mode, prod host: exit 2 and still no request" "$(run)$(gets)" "20"

[ "$fail" -eq 0 ] && echo "ALL PASS" || echo "SOME FAILED"
exit "$fail"
