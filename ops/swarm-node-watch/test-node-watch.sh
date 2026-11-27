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
# MOCK_NODELS_HANG=1 / MOCK_NODEINSPECT_HANG=1: the call never answers (a wedged dockerd). `exec sleep` so the script's own
# `timeout` can kill it; the real docker CLI is one process too.
cat > "${MOCKBIN}/docker" <<'MOCKDOCKER'
#!/usr/bin/env bash
echo "docker $*" >> "${MOCK_LOG}/docker.log"
if [ "$1 $2" = "node ls" ]; then
  [ "${MOCK_NODELS_HANG:-0}" = 1 ] && exec sleep 90
  if [ "${MOCK_NODELS_RC:-0}" != 0 ]; then echo "Error response from daemon: This node is not a swarm manager. (mock)" >&2; exit "${MOCK_NODELS_RC}"; fi
  cat "${MOCK_W}/nodes"; exit 0
fi
if [ "$1 $2" = "node inspect" ]; then
  [ "${MOCK_NODEINSPECT_HANG:-0}" = 1 ] && exec sleep 90
  awk -F'|' -v h="$3" '$1==h{print $2}' "${MOCK_W}/addrs"; exit 0
fi
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
        WAVE_CLEAR_BELOW REMIND_HOURS RECOVER_RUNS BLIND_RUNS MOCK_NODELS_HANG MOCK_NODEINSPECT_HANG SWARM_READ_TIMEOUT
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
# run_capped: one run under an emulated unit cap. The real unit has TimeoutStartSec=2min; here it is 30 s, well under the 90 s
# the mock hangs and well over a normal run (a run takes seconds on a slow, loaded box). rc 124 means the cap killed the run,
# i.e. the script did not bound its own hang. Output goes through a file, never a pipe: a killed run can leave an orphaned
# `sleep` that would hold a pipe open until it ends.
run_capped() { timeout 30 bash "${SCRIPT}" > "${CASE}/capped.out" 2>&1; rc=$?; out="$(cat "${CASE}/capped.out")"; }
# state_core: the stored up/down record (what is alerting, since when, last alert, clean-run streak) — never the pending counter
state_core() { grep -E '^(active|since|last_alert|ok_streak)=' "${STATE_DIR}/state" 2>/dev/null; }
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

# 12 --- a swarm read that HANGS must not read as silence.
# The unit's TimeoutStartSec only kills the run (exit 124, nothing posted, nothing pages on a red unit), so the script must cut its own
# read first (SWARM_READ_TIMEOUT, 3 s here) and treat it as the blind spot it is. run_capped emulates the unit cap around the run.
new_case; export MOCK_NODELS_HANG=1 SWARM_READ_TIMEOUT=3; run_capped
check "hung docker node ls: the script cut the read itself, the unit cap never fired" "$([ "$rc" = 124 ] && echo killed-by-cap || echo finished)" finished
check "hung docker node ls, 1st run: waits like any failed read (exit 0, no post)" "${rc} $(posts)" "0 0"
check "hung docker node ls, 1st run: the journal line says the read got no answer" "$(echo "$out" | grep -c 'no answer within 3s')" 1
run_capped
check "hung docker node ls, 2nd run: ONE post" "$(posts)" 1
check "...it says the swarm node list cannot be read, and why" "$(last_post | grep -c 'cannot read the swarm node list (docker node ls gave no answer within 3s)')" 1
check "...the unit goes RED (exit 2), as for any blind watcher" "$rc" 2
run_capped; run_capped
check "hung for a 3rd and 4th run: still ONE post (deduped like every other alert)" "$(posts)" 1
check "...and not one message ever says RECOVERED or 'every node is Ready'" "$(grep -c -E 'RECOVERED|every node is Ready' "${MOCK_LOG}/slack.log")" 0
unset MOCK_NODELS_HANG; run; run
check "the swarm answers again: RECOVERED after two clean runs" "$(last_post | grep -c RECOVERED)" 1
new_case; export MOCK_NODELS_HANG=1 SWARM_READ_TIMEOUT=3 BLIND_RUNS=1; run_capped
check "BLIND_RUNS=1: a hung listing pages on the first run (same debounce knob as every blind spot)" "$(posts)" 1
new_case; export MOCK_NODEINSPECT_HANG=1 SWARM_READ_TIMEOUT=3; run_capped
check "hung docker node inspect: cut by the script too, the unit cap never fired" "$([ "$rc" = 124 ] && echo killed-by-cap || echo finished)" finished
check "hung docker node inspect, 1st run: waits (no post)" "$(posts)" 0
run_capped
check "hung docker node inspect, 2nd run: a 'cannot read the docker journal' alert, not silence" "$(last_post | grep -c 'cannot read the docker journal on web')" 1

# 13 --- a FAILED listing is never a clean run: no RECOVERED, and the stored up/down state is left exactly as it was
new_case; set_nodes "mgr|Ready|Active|Leader" "web|Down|Active|" "stg|Ready|Active|"; run
set_nodes "mgr|Ready|Active|Leader" "web|Ready|Active|" "stg|Ready|Active|"; run
snap="$(state_core)"
check "setup: alert posted, then one clean run counted (ok_streak=1)" "$(posts) $(echo "${snap}" | grep -c '^ok_streak=1$')" "1 1"
export MOCK_NODELS_RC=1; run
check "alert, one clean run, then ONE failed listing: no RECOVERED" "$(grep -c RECOVERED "${MOCK_LOG}/slack.log")" 0
check "...no post at all, exit 0 (a first miss only waits)" "$(posts) ${rc}" "1 0"
check "...the stored state (active, since, last_alert, ok_streak) is exactly as it was" "$(state_core)" "${snap}"
check "...and the run says the nodes were not observed and the alert state was left alone" "$(echo "$out" | grep -c 'alert state left as it was')" 1
unset MOCK_NODELS_RC; run
check "the list answers again, all healthy: RECOVERED now, ONCE (two clean observations)" "$(grep -c RECOVERED "${MOCK_LOG}/slack.log")" 1
new_case; set_nodes "mgr|Ready|Active|Leader" "web|Down|Active|" "stg|Ready|Active|"; run
set_nodes "mgr|Ready|Active|Leader" "web|Ready|Active|" "stg|Ready|Active|"; run
snap="$(state_core)"; export MOCK_NODELS_HANG=1 SWARM_READ_TIMEOUT=3; run_capped
check "alert, one clean run, then ONE HUNG listing: finished by itself, no RECOVERED, no post" "$([ "$rc" = 124 ] && echo killed-by-cap || echo finished) $(grep -c RECOVERED "${MOCK_LOG}/slack.log") $(posts)" "finished 0 1"
check "...the stored state is exactly as it was" "$(state_core)" "${snap}"
# an alert with NO clean run yet, then the list fails: it must neither clear nor lose the alert, and a confirmed blind spot carries it
new_case; set_nodes "mgr|Ready|Active|Leader" "web|Down|Active|" "stg|Ready|Active|"; run                      # alert at NOW
snap="$(state_core)"; export MOCK_NODELS_RC=1; NODEWATCH_NOW_EPOCH=$((NOW + 120)) run
check "web Down alerting, ONE failed listing: no post, state unchanged" "$(posts) ${rc} $([ "$(state_core)" = "${snap}" ] && echo same || echo changed)" "1 0 same"
NODEWATCH_NOW_EPOCH=$((NOW + 240)) run
check "...a 2nd failed listing: ONE more post, the 'cannot read' alert, exit 2" "$(posts) $(last_post | grep -c 'cannot read the swarm node list') ${rc}" "2 1 2"
check "...it still lists the web problem as unverified instead of forgetting it" "$(last_post | grep -c 'node:web=Down/Active')" 1
check "...the stored set keeps the web alert next to the blind one" "$(state_core | grep '^active=')" "active=blind:nodels,node:web=Down/Active"
check "...'since' is still the original alert time (not reset by the blind alert)" "$(state_core | grep '^since=')" "$(echo "${snap}" | grep '^since=')"
check "...and last_alert moved to the blind alert" "$(state_core | grep '^last_alert=')" "last_alert=$((NOW + 240))"
NODEWATCH_NOW_EPOCH=$((NOW + 360)) run
check "...a 3rd failed listing: deduped (still 2 posts)" "$(posts)" 2
NODEWATCH_NOW_EPOCH=$((NOW + 240 + 6*3600 + 60)) run
check "...6 h after the blind alert: a REMINDER, like any unchanged alert" "$(posts) $(last_post | grep -c REMINDER)" "3 1"
check "...and no RECOVERED at any point while the list was unreadable" "$(grep -c RECOVERED "${MOCK_LOG}/slack.log")" 0
unset MOCK_NODELS_RC; set_nodes "mgr|Ready|Active|Leader" "web|Ready|Active|" "stg|Ready|Active|"; run
check "the list answers again, web healthy: one clean run is not enough yet" "$(posts)" 3
run
check "...the second clean run: ONE RECOVERED" "$(last_post | grep -c RECOVERED) $(posts)" "1 4"
# the same, but web is STILL down when the list answers again
new_case; set_nodes "mgr|Ready|Active|Leader" "web|Down|Active|" "stg|Ready|Active|"; run
export MOCK_NODELS_RC=1; run; run
unset MOCK_NODELS_RC; run
check "list answers again, web still Down: a fresh alert for web (the set changed), no RECOVERED" "$(posts) $(last_post | grep -c 'Status=Down') $(grep -c RECOVERED "${MOCK_LOG}/slack.log")" "3 1 0"

# 14 --- a failed listing from a healthy start invents nothing; consecutive means consecutive
new_case; export MOCK_NODELS_RC=1; run; unset MOCK_NODELS_RC; run; run
check "healthy, one failed listing, healthy: silent all along, nothing stored as alerting" "$(posts) $(state_core | grep -c '^active=$')" "0 1"
new_case; export MOCK_NODELS_RC=1; run; unset MOCK_NODELS_RC; run; export MOCK_NODELS_RC=1; run
check "fail, ok, fail: NOT two consecutive failures, so no 'cannot read' alert" "$(posts)" 0

# 15 --- the install-time TEST_ALERT must not call an unreadable swarm "no problems" either
new_case; export TEST_ALERT=true MOCK_NODELS_RC=1; run
check "TEST_ALERT with an unreadable node list: one message that says the swarm state is UNKNOWN" "$(posts) $(last_post | grep -c 'swarm state is UNKNOWN')" "1 1"
check "...and never says 'No current problems'" "$(last_post | grep -c 'No current problems')" 0
check "...and leaves no dedupe state" "$(test -f "${STATE_DIR}/state" && echo saved || echo none)" none

echo "----"
[ "$fail" -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$fail"
