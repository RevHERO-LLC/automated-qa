#!/usr/bin/env bash
# Hermetic red/green test for check-swarm-nodes.sh (the swarm node-drop alert).
# Mocks docker / ssh / curl / jq on PATH (no swarm, no network, no real jq) and runs the REAL script.
#   bash ops/swarm-node-watch/test-node-watch.sh   -> exit 0 = all PASS
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/check-swarm-nodes.sh"
WORK="$(mktemp -d)"; trap 'rm -rf "${WORK}"' EXIT
MOCKBIN="${WORK}/mockbin"; mkdir -p "${MOCKBIN}"

fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1: expected '$3', got '$2'"; fail=1; fi; }

bash -n "${SCRIPT}" && echo "PASS  bash -n check-swarm-nodes.sh" || { echo "FAIL  bash -n"; exit 1; }

# --- mock docker: `node ls` (rc + body from the scenario), `node inspect <host>` (address map) -------------------
cat > "${MOCKBIN}/docker" <<'MOCKDOCKER'
#!/usr/bin/env bash
echo "docker $*" >> "${MOCK_LOG}/docker.log"
if [ "$1 $2" = "node ls" ]; then
  if [ "${MOCK_NODELS_RC:-0}" != 0 ]; then echo "Error response from daemon: This node is not a swarm manager. (mock)" >&2; exit "${MOCK_NODELS_RC}"; fi
  cat "${MOCK_W}/nodes"; exit 0
fi
if [ "$1 $2" = "node inspect" ]; then awk -F'|' -v h="$3" '$1==h{print $2}' "${MOCK_W}/addrs"; exit 0; fi
exit 1
MOCKDOCKER
# --- mock ssh: the real script pipes a script on stdin and addresses root@<addr>; the answer comes from the scenario --
cat > "${MOCKBIN}/ssh" <<'MOCKSSH'
#!/usr/bin/env bash
target=""; for a in "$@"; do case "$a" in root@*) target="${a#root@}";; esac; done
echo "ssh ${target} :: $*" >> "${MOCK_LOG}/ssh.log"
cat > "${MOCK_LOG}/ssh-stdin.log"
if [ -f "${MOCK_W}/ssh_rc.${target}" ]; then echo "ssh: connect to host ${target} port 22: Connection timed out (mock)" >&2; exit "$(cat "${MOCK_W}/ssh_rc.${target}")"; fi
[ -f "${MOCK_W}/waves.${target}" ] && cat "${MOCK_W}/waves.${target}"
exit 0
MOCKSSH
# --- mock curl (Slack only) + jq (the one filter the script uses: -Rs '{text:.}') ---------------------------------
cat > "${MOCKBIN}/curl" <<'MOCKCURL'
#!/usr/bin/env bash
url="${*: -1}"
{ echo "---- POST ${url}"; cat; echo; } >> "${MOCK_LOG}/slack.log"
[ "${MOCK_SLACK_FAIL:-0}" = 1 ] && exit 22
exit 0
MOCKCURL
cat > "${MOCKBIN}/jq" <<'MOCKJQ'
#!/usr/bin/env bash
in="$(cat)"; e="${in//\\/\\\\}"; e="${e//\"/\\\"}"; e="${e//$'\n'/\\n}"; printf '{"text":"%s"}' "$e"
MOCKJQ
chmod +x "${MOCKBIN}/docker" "${MOCKBIN}/ssh" "${MOCKBIN}/curl" "${MOCKBIN}/jq"
export PATH="${MOCKBIN}:${PATH}"

NOW=1793450096                                   # fixed "now" (NODEWATCH_NOW_EPOCH) => deterministic windows
min_ago() { date -u -d "@$((NOW - $1 * 60))" +%Y-%m-%dT%H:%M; }   # UTC minute stamp N minutes before NOW
WEBHOOK="https://hooks.invalid/T/B/secret-webhook-path"

new_case() { # fresh log/world/state dirs, default env, a healthy 3-node cluster (manager + 2 workers), quiet journals
  CASE="${WORK}/case.$RANDOM$RANDOM"; mkdir -p "${CASE}/log" "${CASE}/w"
  export MOCK_LOG="${CASE}/log" MOCK_W="${CASE}/w" STATE_DIR="${CASE}/state" NODEWATCH_NOW_EPOCH="${NOW}"
  export SLACK_WEBHOOK="${WEBHOOK}" LANE_LABEL=test
  unset MOCK_NODELS_RC MOCK_SLACK_FAIL TEST_ALERT EXPECTED_NODES WAVE_THRESHOLD WAVE_WINDOW_MINUTES WAVE_GAP_MINUTES \
        WAVE_CLEAR_BELOW REMIND_HOURS RECOVER_RUNS BLIND_RUNS
  : > "${MOCK_LOG}/slack.log"; : > "${MOCK_LOG}/ssh.log"
  set_nodes "mgr|Ready|Active|Leader" "web|Ready|Active|" "stg|Ready|Active|"
  printf 'mgr|10.0.0.1\nweb|10.0.0.3\nstg|10.0.0.2\n' > "${MOCK_W}/addrs"
  quiet_journals
}
set_nodes() { printf '%s\n' "$@" > "${MOCK_W}/nodes"; }
waves_for() { # <addr> <minutes-ago>...   -> that node's journal reports a failure in those UTC minutes
  local addr="$1"; shift; { local m; for m in "$@"; do min_ago "$m"; done; echo WAVES_OK; } > "${MOCK_W}/waves.${addr}"
}
quiet_journals() { waves_for 10.0.0.3; waves_for 10.0.0.2; }
run() { out="$(bash "${SCRIPT}" 2>&1)"; rc=$?; }
posts() { grep -c '^---- POST' "${MOCK_LOG}/slack.log"; }
last_post() { awk '/^---- POST/{buf=""} {buf=buf $0 "\n"} END{printf "%s", buf}' "${MOCK_LOG}/slack.log"; }
ssh_calls() { grep -c . "${MOCK_LOG}/ssh.log"; }

# ======================= UNIT: wave counting, node classification, key hygiene ========================
( # subshell: sourcing defines the pure functions without touching the scenarios below
  export STATE_DIR="${WORK}/unit-state" NODEWATCH_NOW_EPOCH="${NOW}"
  NODEWATCH_LIB_ONLY=1 . "${SCRIPT}"
  u() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1: expected '$3', got '$2'"; echo UNIT_FAIL >> "${WORK}/unit.fail"; fi; }
  # a script that exits while being sourced, or lacks the pure functions, must FAIL here rather than skip silently
  for fn in count_waves node_problem sanitize_key decide; do
    if declare -F "$fn" >/dev/null; then echo "PASS  library function ${fn} is defined"; else echo "FAIL  library function ${fn} is missing"; echo UNIT_FAIL >> "${WORK}/unit.fail"; fi
  done
  cw() { printf '%s\n' "$@" | count_waves "${NOW}" 60 5; }       # count_waves <now> <window-min> <gap-min> < minute stamps
  u "waves: no failure minutes => 0"                             "$(printf '' | count_waves "${NOW}" 60 5)" 0
  u "waves: one minute => 1"                                     "$(cw "$(min_ago 30)")" 1
  u "waves: adjacent minutes are ONE wave"                       "$(cw "$(min_ago 31)" "$(min_ago 30)")" 1
  u "waves: minutes 5 apart still merge (gap <= 5)"              "$(cw "$(min_ago 40)" "$(min_ago 35)")" 1
  u "waves: minutes 6 apart are two waves"                       "$(cw "$(min_ago 40)" "$(min_ago 34)")" 2
  u "waves: the 11-24 evidence (00:13 01:13 01:41) => 3 waves"   "$(printf '2026-11-24T00:13\n2026-11-24T01:13\n2026-11-24T01:41\n' | count_waves "$(date -u -d 2026-11-24T02:00:00Z +%s)" 120 5)" 3
  u "waves: a minute older than the window is ignored"           "$(cw "$(min_ago 90)" "$(min_ago 10)")" 1
  u "waves: junk lines are ignored, real ones counted"           "$(cw 'journal rotated' "$(min_ago 20)" '' 'WAVES_OK')" 1
  u "waves: unsorted input is sorted first"                      "$(cw "$(min_ago 10)" "$(min_ago 50)" "$(min_ago 11)")" 2
  nh() { node_problem "$@"; }                                    # node_problem <status> <availability> <managerstatus>
  u "node: Ready/Active worker is healthy"                       "$(nh Ready Active '')" ""
  u "node: Ready/Active Leader is healthy"                       "$(nh Ready Active Leader)" ""
  u "node: Ready/Active Reachable manager is healthy"            "$(nh Ready Active Reachable)" ""
  u "node: Down is a problem"                                    "$(nh Down Active '')" "Down/Active"
  u "node: Unknown is a problem"                                 "$(nh Unknown Active '')" "Unknown/Active"
  u "node: Disconnected is a problem"                            "$(nh Disconnected Active '')" "Disconnected/Active"
  u "node: Drain is a problem (not Active)"                      "$(nh Ready Drain '')" "Ready/Drain"
  u "node: Pause is a problem (not Active)"                      "$(nh Ready Pause '')" "Ready/Pause"
  u "node: an Unreachable manager is a problem"                  "$(nh Ready Active Unreachable)" "Ready/Active/Unreachable"
  u "node: a blank status is a problem, never healthy"           "$(nh '' '' '')" "?/?"
  u "key: a hostile hostname is neutralised"                     "$(sanitize_key 'a b;c|d,e')" "a_b_c_d_e"
  u "key: normal characters are kept"                            "$(sanitize_key 'node:web=Down/Active')" "node:web=Down/Active"
  d() { decide "$@"; }                                           # decide <obs> <active> <now> <last_alert> <ok_streak>
  RECOVER_RUNS=2; REMIND_HOURS=6
  u "decide: nothing observed, nothing active => none"           "$(d '' '' "${NOW}" 0 0)" none
  u "decide: new problem => alert"                               "$(d a '' "${NOW}" 0 0)" alert
  u "decide: unchanged problem inside 6h => none"                "$(d a a "${NOW}" $((NOW - 3600)) 0)" none
  u "decide: unchanged problem for 6h => remind"                 "$(d a a "${NOW}" $((NOW - 21600)) 0)" remind
  u "decide: changed set => alert at once"                       "$(d a,b a "${NOW}" $((NOW - 60)) 0)" alert
  u "decide: shrunk set (one cleared) => alert with the rest"    "$(d a a,b "${NOW}" $((NOW - 60)) 0)" alert
  u "decide: healthy once after an alert => wait (flap guard)"   "$(d '' a "${NOW}" $((NOW - 60)) 0)" wait
  u "decide: healthy twice after an alert => recover"            "$(d '' a "${NOW}" $((NOW - 60)) 1)" recover
  echo done > "${WORK}/unit.done"
)
unit_fail=0; [ -f "${WORK}/unit.fail" ] && unit_fail=1
check "unit tests: the block ran to its end" "$(test -f "${WORK}/unit.done" && echo yes || echo no)" yes
check "unit tests: no failures" "$unit_fail" 0

# ======================= SCENARIOS: the real script against the mocked swarm ========================
# 1 --- healthy cluster: silent, exit 0
new_case; run
check "healthy: exit 0" "$rc" 0
check "healthy: NO Slack post" "$(posts)" 0
check "healthy: the manager is not SSHed (managers have no heartbeat to themselves)" "$(grep -c '10.0.0.1' "${MOCK_LOG}/ssh.log")" 0
check "healthy: the workers' journals were read" "$(ssh_calls)" 2
check "healthy: the run logs each worker's wave count" "$(echo "$out" | grep -c 'waves(60m) web=0')" 1

# 2 --- a node Down: alert at once, deduped, reminded, recovered
new_case; set_nodes "mgr|Ready|Active|Leader" "web|Down|Active|" "stg|Ready|Active|"; run
check "Down: exit 0 (alert delivered)" "$rc" 0
check "Down: ONE Slack post at once" "$(posts)" 1
check "Down: the message names the node (bold *web*)" "$(last_post | grep -c '\*web\*')" 1
check "Down: the message shows Status=Down" "$(last_post | grep -c 'Status=Down')" 1
check "Down: the message shows the node address" "$(last_post | grep -c '10.0.0.3')" 1
check "Down: a Down node is not SSHed for waves (its state is the alert)" "$(grep -c '10.0.0.3' "${MOCK_LOG}/ssh.log")" 0
run
check "Down again next run: deduped (still 1 post)" "$(posts)" 1
NODEWATCH_NOW_EPOCH=$((NOW + 6*3600 + 60)) run
check "Down for 6h+: REMINDER posted" "$(posts)" 2
check "reminder is labelled" "$(last_post | grep -c REMINDER)" 1
set_nodes "mgr|Ready|Active|Leader" "web|Ready|Active|" "stg|Ready|Active|"
NODEWATCH_NOW_EPOCH=$((NOW + 6*3600 + 120)) run
check "first healthy run after the alert: no RECOVERED yet (flap guard)" "$(last_post | grep -c RECOVERED)" 0
NODEWATCH_NOW_EPOCH=$((NOW + 6*3600 + 240)) run
check "second healthy run: ONE RECOVERED" "$(last_post | grep -c RECOVERED)" 1
n_after="$(posts)"; NODEWATCH_NOW_EPOCH=$((NOW + 6*3600 + 360)) run
check "healthy after RECOVERED: silence" "$(posts)" "${n_after}"

# 3 --- a flap inside the recovery guard does not produce a second alert
new_case; set_nodes "mgr|Ready|Active|Leader" "web|Down|Active|" "stg|Ready|Active|"; run
set_nodes "mgr|Ready|Active|Leader" "web|Ready|Active|" "stg|Ready|Active|"; run
set_nodes "mgr|Ready|Active|Leader" "web|Down|Active|" "stg|Ready|Active|"; run
check "down, up once, down again: still ONE alert (no flap spam)" "$(posts)" 1
check "...and no RECOVERED was sent in between" "$(grep -c RECOVERED "${MOCK_LOG}/slack.log")" 0

# 4 --- not-Active and not-Ready variants all page
new_case; set_nodes "mgr|Ready|Active|Leader" "web|Ready|Drain|" "stg|Ready|Active|"; run
check "Drain pages" "$(last_post | grep -c 'Availability=Drain')" 1
new_case; set_nodes "mgr|Ready|Active|Leader" "web|Ready|Pause|" "stg|Ready|Active|"; run
check "Pause pages" "$(last_post | grep -c 'Availability=Pause')" 1
new_case; set_nodes "mgr|Ready|Active|Leader" "web|Ready|Active|" "stg|Unknown|Active|"; run
check "Unknown pages" "$(last_post | grep -c 'Status=Unknown')" 1
new_case; set_nodes "mgr|Ready|Active|Unreachable" "web|Ready|Active|" "stg|Ready|Active|"; run
check "an Unreachable manager pages" "$(last_post | grep -c 'Unreachable')" 1

# 4b --- a changed set alerts immediately (a second node falls over)
new_case; set_nodes "mgr|Ready|Active|Leader" "web|Down|Active|" "stg|Ready|Active|"; run
set_nodes "mgr|Ready|Active|Leader" "web|Down|Active|" "stg|Down|Active|"; run
check "second node down: a NEW alert at once (2 posts)" "$(posts)" 2
check "...naming both nodes" "$(last_post | grep -c -E 'Status=Down.*Status=Down|web.*stg')" 1

# 5 --- expected-node list: a node that vanished from `docker node ls`
new_case; export EXPECTED_NODES="mgr,web,stg"; set_nodes "mgr|Ready|Active|Leader" "stg|Ready|Active|"; run
check "EXPECTED_NODES: a missing node pages" "$(last_post | grep -c 'missing')" 1
new_case; export EXPECTED_NODES="mgr,web,stg"; run
check "EXPECTED_NODES: all present is silent" "$(posts)" 0

# 6 --- heartbeat-failure waves per hour (the flaps a state poll cannot see)
new_case; waves_for 10.0.0.3 5 25 45; run
check "3 waves in 60 min (threshold 3): flap alert" "$(posts)" 1
check "flap alert names the node and the count" "$(last_post | grep -c 'web.*3 heartbeat-failure waves')" 1
new_case; waves_for 10.0.0.3 5 25; run
check "2 waves in 60 min: below the threshold, silent" "$(posts)" 0
check "...but the count is logged every run" "$(echo "$out" | grep -c 'waves(60m) web=2')" 1
new_case; waves_for 10.0.0.3 5 6 7 25; run
check "adjacent minutes merge: 4 failing minutes = 2 waves, silent" "$(posts)" 0
new_case; export WAVE_THRESHOLD=1; waves_for 10.0.0.3 5; run
check "WAVE_THRESHOLD=1 pages on a single wave" "$(posts)" 1
new_case; export WAVE_THRESHOLD=0; waves_for 10.0.0.3 5 25 45 55; run
check "WAVE_THRESHOLD=0 switches the wave check OFF (no SSH, no post)" "$(posts)$(ssh_calls)" 00
# flap hysteresis: stays active while any wave is left in the window, clears only after a clean hour
new_case; waves_for 10.0.0.3 5 25 45; run
waves_for 10.0.0.3 20; run; run
check "flap: down to 1 wave in the window stays ACTIVE (no RECOVERED)" "$(grep -c RECOVERED "${MOCK_LOG}/slack.log")" 0
quiet_journals; run; run
check "flap: a clean hour (twice) => ONE RECOVERED" "$(grep -c RECOVERED "${MOCK_LOG}/slack.log")" 1
# both signals at once
new_case; set_nodes "mgr|Ready|Active|Leader" "web|Down|Active|" "stg|Ready|Active|"; waves_for 10.0.0.2 5 25 45; run
check "node down AND another node flapping: ONE message carries both" "$(posts)$(last_post | grep -c 'Status=Down')$(last_post | grep -c 'stg.*heartbeat-failure')" 111

# 7 --- blind spots are alerts, not health
new_case; export MOCK_NODELS_RC=1; run
check "docker node ls fails once: waits (a daemon restart must not page), no post" "$(posts)" 0
check "...and exits 0" "$rc" 0
run
check "docker node ls fails twice: a 'cannot read' alert" "$(last_post | grep -c 'cannot read the swarm node list')" 1
check "...the unit stays RED (exit 2) because the watcher is blind" "$rc" 2
unset MOCK_NODELS_RC; run; run
check "node list readable again: RECOVERED" "$(last_post | grep -c RECOVERED)" 1
new_case; echo 3 > "${MOCK_W}/ssh_rc.10.0.0.3"; run
check "SSH to a Ready worker fails once: waits, no post" "$(posts)" 0
run
check "SSH fails twice: a 'cannot read the journal' alert" "$(last_post | grep -c 'cannot read the docker journal on web')" 1
check "...and the node-state check still ran (no false Down)" "$(last_post | grep -c 'Status=')" 0
new_case; printf 'garbage with no sentinel\n' > "${MOCK_W}/waves.10.0.0.3"; run; run
check "a journal answer without the WAVES_OK sentinel is treated as blind" "$(last_post | grep -c 'cannot read the docker journal on web')" 1
new_case; printf 'WAVES_ERR journalctl-rc-1\n' > "${MOCK_W}/waves.10.0.0.3"; run; run
check "a remote journalctl failure is blind, never 'zero waves'" "$(last_post | grep -c 'cannot read the docker journal on web')" 1

# 8 --- fail loud: no webhook; Slack down
new_case; unset SLACK_WEBHOOK; set_nodes "mgr|Ready|Active|Leader" "web|Down|Active|" "stg|Ready|Active|"; run
check "no SLACK_WEBHOOK: exit 2 (loud)" "$rc" 2
check "no SLACK_WEBHOOK: says it cannot deliver" "$(echo "$out" | grep -c 'cannot deliver')" 1
check "no SLACK_WEBHOOK: never touched docker" "$(test -s "${MOCK_LOG}/docker.log" && echo touched || echo none)" none
new_case; export SLACK_WEBHOOK=REPLACE_ME; run
check "the REPLACE_ME placeholder counts as no webhook: exit 2 (loud)" "$rc" 2
new_case; export MOCK_SLACK_FAIL=1; set_nodes "mgr|Ready|Active|Leader" "web|Down|Active|" "stg|Ready|Active|"; run
check "Slack down while an alert is due: exit 1 (loud)" "$rc" 1
check "Slack down: the alert state is NOT recorded" "$(test -f "${STATE_DIR}/state" && echo saved || echo none)" none
export MOCK_SLACK_FAIL=0; run
check "Slack back up: the alert is retried and delivered" "$(last_post | grep -c 'Status=Down')" 1
check "...and that run exits 0" "$rc" 0

# 9 --- the webhook never leaks into the output
new_case; set_nodes "mgr|Ready|Active|Leader" "web|Down|Active|" "stg|Ready|Active|"; run
check "the webhook URL is never printed" "$(echo "$out" | grep -cF 'secret-webhook-path')" 0

# 10 --- TEST_ALERT: validates the whole path (docker, SSH, Slack) without touching state
new_case; export TEST_ALERT=true; run
check "TEST_ALERT posts exactly one message" "$(posts)" 1
check "TEST_ALERT message says the path is OK and lists the nodes" "$(last_post | grep -c -E 'test run.*mgr.*web.*stg')" 1
check "TEST_ALERT leaves no dedupe state" "$(test -f "${STATE_DIR}/state" && echo saved || echo none)" none
new_case; export TEST_ALERT=true; set_nodes "mgr|Ready|Active|Leader" "web|Down|Active|" "stg|Ready|Active|"; run
check "TEST_ALERT reports a current problem too (and still exits 0)" "$(last_post | grep -c 'Status=Down')$rc" 10

# 11 --- knobs: a bad value never silently disables a check
new_case; export WAVE_THRESHOLD=banana; waves_for 10.0.0.3 5 25 45; run
check "garbage WAVE_THRESHOLD falls back to the default (3) and says so" "$(posts)$(echo "$out" | grep -c 'WAVE_THRESHOLD')" 11
new_case; export RECOVER_RUNS=1; set_nodes "mgr|Ready|Active|Leader" "web|Down|Active|" "stg|Ready|Active|"; run
set_nodes "mgr|Ready|Active|Leader" "web|Ready|Active|" "stg|Ready|Active|"; run
check "RECOVER_RUNS=1: recovered after one healthy run" "$(last_post | grep -c RECOVERED)" 1

echo "----"
[ "$fail" -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$fail"
