#!/usr/bin/env bash
# Hermetic red/green test for periodic-job-heartbeat.sh (the daily "did every periodic prod job actually run?" check).
# Mocks docker on PATH (no swarm, no network, no Slack) and runs the REAL script against fixture service logs whose lines
# carry an AGE, so every row's log window and interval are real thresholds, not labels.
#   bash scripts/test-periodic-job-heartbeat.sh                          -> exit 0 = all PASS
#   HEARTBEAT_SCRIPT=/path/to/copy.sh bash scripts/test-periodic-job-heartbeat.sh   -> the same suite against another copy
#
# What it pins (the two rows added for the prod swarm-dealmover sweeper and the promo gift sweep, plus the six that were there):
#   OK            a marker line inside the row's window                                -> alive, quiet
#   DEAD          no marker inside the window AND the container older than the interval -> one bullet naming the job
#   INDETERMINATE no marker but the container younger than the interval (just redeployed) -> printed, never an alert
#   and the three ways the CHECK ITSELF can fail (no running task, a hung log read) -> an alert, never a quiet OK.
# The marker text, the service name, the window and the interval of each new row are written out below on purpose: if the
# test took them from the script, breaking a row would break the test with it and nothing would fail.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HEARTBEAT_SCRIPT:-${HERE}/periodic-job-heartbeat.sh}"
WORK="$(mktemp -d)"; trap 'rm -rf "${WORK}"' EXIT
MOCKBIN="${WORK}/mockbin"; mkdir -p "${MOCKBIN}"

fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1: expected '$3', got '$2'"; fail=1; fi; }

bash -n "${SCRIPT}" && echo "PASS  bash -n $(basename "${SCRIPT}")" || { echo "FAIL  bash -n"; exit 1; }

# --- mock docker -------------------------------------------------------------------------------------------------------
#   docker service logs <svc> --since <N>m|<N>h   prints the fixture lines whose AGE (minutes) is inside the window, like the
#                                                 real --since; no fixture = no such service (error, rc 1); a hang marker =
#                                                 the read never returns (the script must cut it with its own timeout)
#   docker service ps <svc> ...                   prints the fixture's CurrentState ("Running 3 days ago"); no fixture = no
#                                                 running task (empty, rc 1)
#   anything else (service ls, ps -q)             lists nothing, so the analytics and Atlas side checks skip themselves
cat > "${MOCKBIN}/docker" <<'MOCKDOCKER'
#!/usr/bin/env bash
echo "docker $*" >> "${MOCK_LOG}/docker.log"
if [ "$1 $2" = "service logs" ]; then
  svc="$3"; since=""; prev=""
  for a in "$@"; do [ "$prev" = "--since" ] && since="$a"; prev="$a"; done
  [ -e "${MOCK_W}/hang/${svc}" ] && exec sleep 30
  [ -f "${MOCK_W}/logs/${svc}" ] || { echo "Error response from daemon: service ${svc} not found" >&2; exit 1; }
  n="${since%[mh]}"; if [ "${since: -1}" = h ]; then win=$(( n * 60 )); else win="$n"; fi
  awk -F'\t' -v w="$win" '$1 <= w { print $2 }' "${MOCK_W}/logs/${svc}"
  exit 0
fi
if [ "$1 $2" = "service ps" ]; then [ -f "${MOCK_W}/ps/$3" ] || exit 1; cat "${MOCK_W}/ps/$3"; exit 0; fi
exit 0
MOCKDOCKER
# A curl that only records: the suite never sets SLACK_WEBHOOK, so a call here means the script posted somewhere it should not.
cat > "${MOCKBIN}/curl" <<'MOCKCURL'
#!/usr/bin/env bash
echo "curl $*" >> "${MOCK_CURL_LOG}"; exit 22
MOCKCURL
chmod +x "${MOCKBIN}/docker" "${MOCKBIN}/curl"
export PATH="${MOCKBIN}:${PATH}" MOCK_CURL_LOG="${WORK}/curl.calls"; : > "${MOCK_CURL_LOG}"
# the real script posts to Slack when these are set: a developer's shell must never reach it from here
unset SLACK_WEBHOOK TEST_ALERT GITHUB_OUTPUT LOG_SCAN_TIMEOUT ANALYTICS_STALE_HOURS ATLAS_LIMIT_MB ATLAS_WARN_PCT

# --- the rows under test: service, marker line and thresholds, written out (see the header) ----------------------------
SWARM=app-connect-optical-bandwidth-jvrjeo      # swarm-dealmover API, prod   | window 70m   | interval 30 min  | 'Running sweeper'
PROMO=revhero-users-service-x305hf              # users-service, prod         | window 26h   | interval 1440 min | 'Recurring credit-gift sweep complete'
DEALMOVER=revhero-deal-mover-vmzya0             # an EXISTING row with the SAME marker text as the swarm one ('Running sweeper')
EMAIL=revhero-email-ingress-laa4mj              # an EXISTING row (24 h job)
ACTIVITY=revhero-activity-service-uxhhme        # an EXISTING row (24 h job)
SWARM_LINE='Running sweeper for 2026-11-25T04:30:00Z'
PROMO_LINE='Recurring credit-gift sweep complete: processed=0 gifted=0 skipped=0'
JOBS="activity-retention|email-token-refresh|siteforge-dispatcher|siteforge-cleanup|dealmover-sweeper|swarm-agent-reconcile|swarm-dealmover-sweep|promo-gift-sweep"

logline() { printf '%s\t%s\n' "$2" "$3" >> "${MOCK_W}/logs/$1"; }     # <svc> <age-in-minutes> <text>
up()      { echo "$2" > "${MOCK_W}/ps/$1"; }                           # <svc> <CurrentState text>
marker()  { # <svc> <age-in-minutes|none> <text>: the service's whole log becomes that one line (none = an unrelated line only)
  rm -f "${MOCK_W}/logs/$1" "${MOCK_W}/hang/$1"
  if [ "$2" = none ]; then logline "$1" 5 'an unrelated log line'; else logline "$1" "$2" "$3"; fi
}
gone()    { rm -f "${MOCK_W}/logs/$1" "${MOCK_W}/ps/$1"; }             # unreadable: no such service, no running task
hang()    { rm -f "${MOCK_W}/logs/$1"; : > "${MOCK_W}/hang/$1"; }      # the log read never answers

new_case() { # fresh fixture dir: all eight rows alive (marker 5 minutes old), every service up 3 days
  CASE="${WORK}/case.$RANDOM$RANDOM"; mkdir -p "${CASE}/log" "${CASE}/w/logs" "${CASE}/w/ps" "${CASE}/w/hang"
  export MOCK_LOG="${CASE}/log" MOCK_W="${CASE}/w" LOG_SCAN_TIMEOUT=30
  logline "${ACTIVITY}" 5 'retention sweep removed 0'
  logline "${EMAIL}" 5 'agent-token-refresh ok'
  logline revhero-campaign-service-ydky5d 5 'siteforge-dispatcher tick'
  logline revhero-campaign-service-ydky5d 5 'siteforge-cleanup done'
  logline "${DEALMOVER}" 5 'Running sweeper for 2026-11-25T04:30:00Z'
  logline app-compress-bluetooth-sensor-pksr4y 5 'reconcile cycle complete'
  logline "${SWARM}" 5 "${SWARM_LINE}"
  logline "${PROMO}" 5 "${PROMO_LINE}"
  local s; for s in "${ACTIVITY}" "${EMAIL}" revhero-campaign-service-ydky5d "${DEALMOVER}" app-compress-bluetooth-sensor-pksr4y "${SWARM}" "${PROMO}"; do
    up "$s" 'Running 3 days ago'
  done
}
run() { out="$(bash "${SCRIPT}" 2>&1)"; rc=$?; }
verdict() { printf '%s\n' "$out" | awk -v j="$1" '$1 == j { $1 = $2 = $3 = $4 = ""; sub(/^ +/, ""); print; f = 1; exit } END { if (!f) print "(no row)" }'; }
bullets() { printf '%s\n' "$out" | grep -c "^• $1:" || true; }
bullet()  { printf '%s\n' "$out" | grep -m1 "^• $1:" || true; }
summary() { printf '%s\n' "$out" | grep -m1 '^ok=' || true; }

# 1 --- every row alive: quiet, exit 0, all eight rows listed, only read-only docker verbs
new_case; run
check "all alive: exit 0" "$rc" 0
check "all alive: ok=8 dead=0 indeterminate=0" "$(summary)" "ok=8 dead=0 indeterminate=0"
check "all alive: the script says so" "$(printf '%s\n' "$out" | grep -c 'All monitored periodic jobs are alive')" 1
check "all alive: the table lists each of the eight jobs once" "$(printf '%s\n' "$out" | grep -c -E "^(${JOBS}) ")" 8
check "all alive: swarm-dealmover-sweep is OK" "$(verdict swarm-dealmover-sweep)" OK
check "all alive: promo-gift-sweep is OK" "$(verdict promo-gift-sweep)" OK
check "all alive: no bullet for either new row" "$(bullets swarm-dealmover-sweep)$(bullets promo-gift-sweep)" 00
check "all alive: only read-only docker verbs were used" "$(awk '{print $2" "$3}' "${MOCK_LOG}/docker.log" | sort -u | tr '\n' ',')" "ps -q,service logs,service ls,service ps,"

# 2 --- a fresh marker keeps each row OK right up to the edge of its window (70m and 26h)
new_case; marker "${SWARM}" 69 "${SWARM_LINE}"; marker "${PROMO}" 1550 "${PROMO_LINE}"; run
check "marker 69 min old (window 70m): swarm row OK" "$(verdict swarm-dealmover-sweep)" OK
check "marker 25h50 old (window 26h): promo row OK" "$(verdict promo-gift-sweep)" OK
check "inside both windows: exit 0, ok=8" "${rc} $(summary)" "0 ok=8 dead=0 indeterminate=0"

# 3 --- no marker inside the window AND an old container: DEAD, one bullet that names the job, the service and the window
new_case; marker "${SWARM}" 71 "${SWARM_LINE}"; marker "${PROMO}" 1570 "${PROMO_LINE}"; up "${PROMO}" 'Running 5 days ago'; run
check "swarm marker 71 min old (window 70m), container 3 days: DEAD" "$(verdict swarm-dealmover-sweep)" DEAD
check "swarm: ONE bullet, naming marker, service, window and uptime" "$(bullets swarm-dealmover-sweep) $(bullet swarm-dealmover-sweep)" \
  "1 • swarm-dealmover-sweep: no 'Running sweeper' in app-connect-optical-bandwidth-jvrjeo for 70m, container up 4320m (interval 30m)"
check "promo marker 26h10 old (window 26h), service 5 days: DEAD" "$(verdict promo-gift-sweep)" DEAD
check "promo: ONE bullet, naming marker, service, window and uptime" "$(bullets promo-gift-sweep) $(bullet promo-gift-sweep)" \
  "1 • promo-gift-sweep: no 'Recurring credit-gift sweep complete' in revhero-users-service-x305hf for 26h, container up 7200m (interval 1440m)"
check "two dead rows: exit 1, the other six still OK" "${rc} $(summary)" "1 ok=6 dead=2 indeterminate=0"

# 4 --- the marker was never logged (the state of the swarm sweeper on prod before its trigger was replaced): DEAD, not a quiet OK
new_case; marker "${SWARM}" none; marker "${PROMO}" none; run
check "swarm: no marker line at all, container 3 days: DEAD" "$(verdict swarm-dealmover-sweep)" DEAD
check "promo: no marker line at all, service 3 days: DEAD" "$(verdict promo-gift-sweep)" DEAD
check "never-logged: one bullet each, exit 1" "$(bullets swarm-dealmover-sweep)$(bullets promo-gift-sweep) ${rc}" "11 1"

# 5 --- right after a redeploy the log is empty: INDETERMINATE, printed, never an alert
new_case; marker "${SWARM}" none; up "${SWARM}" 'Running 10 minutes ago'; marker "${PROMO}" none; up "${PROMO}" 'Running 5 hours ago'; run
check "swarm: no marker, container 10 min old: INDETERMINATE" "$(verdict swarm-dealmover-sweep)" INDETERMINATE
check "promo: no marker, service 5 h old: INDETERMINATE" "$(verdict promo-gift-sweep)" INDETERMINATE
check "INDETERMINATE is not an alert: no bullet, exit 0, counted" "$(bullets swarm-dealmover-sweep)$(bullets promo-gift-sweep) ${rc} $(summary)" "00 0 ok=6 dead=0 indeterminate=2"

# 6 --- the interval is the edge between "not due yet" and "dead" (30 min and 24 h)
new_case; marker "${SWARM}" none; up "${SWARM}" 'Running 29 minutes ago'; marker "${PROMO}" none; up "${PROMO}" 'Running 23 hours ago'; run
check "swarm container up 29 min (interval 30): still INDETERMINATE" "$(verdict swarm-dealmover-sweep)" INDETERMINATE
check "promo service up 23 h (interval 24 h): still INDETERMINATE" "$(verdict promo-gift-sweep)" INDETERMINATE
new_case; marker "${SWARM}" none; up "${SWARM}" 'Running 30 minutes ago'; marker "${PROMO}" none; up "${PROMO}" 'Running 24 hours ago'; run
check "swarm container up 30 min (interval 30): DEAD" "$(verdict swarm-dealmover-sweep)" DEAD
check "promo service up 24 h (interval 24 h): DEAD" "$(verdict promo-gift-sweep)" DEAD

# 7 --- the CHECK failing is an alert too: a service that cannot be read, a log read that hangs
new_case; gone "${SWARM}"; gone "${PROMO}"; run
check "swarm: no log and no running task: DEAD (service not running), never a quiet OK" "$(verdict swarm-dealmover-sweep)" "DEAD (service not running)"
check "promo: no log and no running task: DEAD (service not running)" "$(verdict promo-gift-sweep)" "DEAD (service not running)"
check "unreadable services: one bullet each saying there is no running task, exit 1" \
  "$(bullet swarm-dealmover-sweep) | $(bullet promo-gift-sweep) | ${rc}" \
  "• swarm-dealmover-sweep: service app-connect-optical-bandwidth-jvrjeo has no running task | • promo-gift-sweep: service revhero-users-service-x305hf has no running task | 1"
new_case; hang "${SWARM}"; hang "${PROMO}"; LOG_SCAN_TIMEOUT=4 run
check "swarm: a log read that hangs is cut by the script's own timeout: TIMEOUT" "$(verdict swarm-dealmover-sweep)" TIMEOUT
check "promo: a log read that hangs: TIMEOUT" "$(verdict promo-gift-sweep)" TIMEOUT
check "hung reads alert, saying THE CHECK FAILED (not 'the job is dead'), exit 1" \
  "$(bullet swarm-dealmover-sweep | grep -c 'THE CHECK FAILED')$(bullet promo-gift-sweep | grep -c 'THE CHECK FAILED') ${rc}" "11 1"
check "hung reads: the other six rows are still checked and OK" "$(summary)" "ok=6 dead=2 indeterminate=0"

# 8 --- each new row reads ITS OWN service, and only the full marker counts
# 8a: the swarm row shares the text 'Running sweeper' with dealmover-sweeper, so a swarm row pointed at the wrong service would read OK here
new_case; marker "${SWARM}" 80 "${SWARM_LINE}"; run
check "swarm marker stale while dealmover-sweeper (same marker text) is fresh: swarm DEAD" "$(verdict swarm-dealmover-sweep)" DEAD
check "...and dealmover-sweeper stays OK" "$(verdict dealmover-sweeper)" OK
new_case; marker "${DEALMOVER}" 80 'Running sweeper for 2026-11-25T04:30:00Z'; run
check "dealmover-sweeper stale while the swarm marker is fresh: only dealmover-sweeper DEAD" \
  "$(verdict dealmover-sweeper)/$(verdict swarm-dealmover-sweep)/$(summary)" "DEAD/OK/ok=7 dead=1 indeterminate=0"
# 8b: a promo sweep that started but never completed must not count
new_case; marker "${PROMO}" 5 'Recurring credit-gift sweep started: users=12'; run
check "promo: a 'started' line without the 'complete' line is DEAD" "$(verdict promo-gift-sweep)" DEAD

# 9 --- the six existing rows are not regressed: a stale one still alerts alone, a young one is still INDETERMINATE
new_case; marker "${EMAIL}" 2000 'agent-token-refresh ok'; marker "${ACTIVITY}" none; up "${ACTIVITY}" 'Running 5 minutes ago'; run
check "existing row email-token-refresh stale (33 h, window 26h): DEAD with one bullet" "$(verdict email-token-refresh) $(bullets email-token-refresh)" "DEAD 1"
check "existing row activity-retention empty on a 5-minute-old container: INDETERMINATE" "$(verdict activity-retention)" INDETERMINATE
check "the two new rows stay OK next to those failures; totals ok=6 dead=1 indeterminate=1, exit 1" \
  "$(verdict swarm-dealmover-sweep)/$(verdict promo-gift-sweep)/$(summary)/${rc}" "OK/OK/ok=6 dead=1 indeterminate=1/1"

# 10 --- hermetic: nothing was posted anywhere
check "no curl call was made (no SLACK_WEBHOOK in the suite)" "$(wc -l < "${MOCK_CURL_LOG}" | tr -d ' ')" 0

echo "----"
[ "$fail" -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$fail"
