#!/usr/bin/env bash
# Hermetic red/green test for the #220 guarded auto-repair in check-overlay-fdb.sh.
# Runs the REAL script against a mocked 3-node swarm (mock docker / ssh / nsenter / ip / bridge / curl / jq on
# PATH; no network, no swarm, no root). The mock `bridge` mutates a per-node fdb file and the mock ping is
# reachable ONLY IF the caller node holds a VTEP for the target MAC that points at the node that REALLY owns it
# — so a wrong repair cannot pass verification. Plus unit tests for the resolver, ledger, validators and knobs.
#   bash ops/overlay-fdb-detector/test-auto-repair.sh   -> exit 0 = all PASS
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/check-overlay-fdb.sh"
WORK="$(mktemp -d)"; trap 'rm -rf "${WORK}"' EXIT
MOCKBIN="${WORK}/mockbin"; mkdir -p "${MOCKBIN}"
W="${WORK}/world"
fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1: expected '$3', got '$2'"; fail=1; fi; }
bash -n "${SCRIPT}" && echo "PASS  bash -n check-overlay-fdb.sh" || { echo "FAIL  bash -n"; exit 1; }

# ============================ UNIT: validators, knobs, resolver, ledger ============================
( # subshell: sourcing defines the detector's functions without touching the scenarios below
  export STATE_DIR="${WORK}/unit-state"; mkdir -p "$STATE_DIR"
  FDB_LIB_ONLY=1 . "${SCRIPT}"
  u() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1: expected '$3', got '$2'"; echo "UNIT_FAIL" >> "${WORK}/unit.fail"; fi; }
  t() { if "$@"; then echo yes; else echo no; fi; }
  u "is_mac accepts a lowercase MAC"                 "$(t is_mac 02:42:0a:00:01:be)" yes
  u "is_mac rejects uppercase / short / injection"   "$(t is_mac 02:42:0A:00:01:BE)$(t is_mac 02:42:0a:00:01)$(t is_mac '02:42:0a:00:01:be;id')" nonono
  u "is_ipv4 accepts an address, rejects junk"       "$(t is_ipv4 10.0.1.5)$(t is_ipv4 '10.0.1.5; id')$(t is_ipv4 10.0.1)$(t is_ipv4 'a.b.c.d')" yesnonono
  u "is_ns accepts a docker netns id, rejects paths" "$(t is_ns 1-n5tbze8b2q)$(t is_ns ../x)$(t is_ns 'a b')$(t is_ns '*')" yesnonono
  u "is_cname accepts a swarm task name, rejects shell" "$(t is_cname revhero-sms-service-q7l5m8.1.abc)$(t is_cname 'x;y')$(t is_cname '$(id)')" yesnono

  # --- resolver: OK only for exactly one node reporting BOTH the IP and the MAC, and agreeing ---
  rst() { ip2nodes=(); mac2nodes=(); ip2name=(); node_containers=(); }
  L='LOCAL_CONTAINER ip=10.0.1.190/24 mac=02:42:0a:00:01:be name=sms-1'
  M=02:42:0a:00:01:be; I=10.0.1.190
  rst; ingest_local_line "$L" 10.9.0.3
  u "resolver: unique owner of IP+MAC => OK <addr>" "$(resolve_owner $I $M 10.9.0.2)" "OK 10.9.0.3"
  rst
  u "resolver: nobody reports it => UNRESOLVED" "$(resolve_owner $I $M 10.9.0.2)" "UNRESOLVED"
  rst; ingest_local_line "$L" 10.9.0.3; ingest_local_line "$L" 10.9.0.4
  u "resolver: IP+MAC claimed by two nodes => AMBIGUOUS (stale endpoint)" "$(resolve_owner $I $M 10.9.0.2 | grep -c 'IP 10.0.1.190 is reported as local by several nodes')" 1
  rst; ingest_local_line "$L" 10.9.0.3; ingest_local_line 'LOCAL_CONTAINER ip=10.0.1.191/24 mac=02:42:0a:00:01:be name=x' 10.9.0.4
  u "resolver: MAC claimed by two nodes => AMBIGUOUS" "$(resolve_owner $I $M 10.9.0.2 | grep -c 'MAC 02:42:0a:00:01:be is reported as local by several nodes')" 1
  rst; ingest_local_line 'LOCAL_CONTAINER ip=10.0.1.190/24 mac=02:42:0a:00:01:ff name=x' 10.9.0.3; ingest_local_line 'LOCAL_CONTAINER ip=10.0.1.99/24 mac=02:42:0a:00:01:be name=y' 10.9.0.4
  u "resolver: IP and MAC point at DIFFERENT nodes => AMBIGUOUS" "$(resolve_owner $I $M 10.9.0.2 | grep -c 'DIFFERENT nodes')" 1
  rst; ingest_local_line 'LOCAL_CONTAINER ip=10.0.1.190/24 name=sms-1' 10.9.0.3
  u "resolver: only the IP resolves (no MAC reported) => AMBIGUOUS" "$(resolve_owner $I $M 10.9.0.2 | grep -c 'only one of IP/MAC')" 1
  rst; ingest_local_line "$L" 10.9.0.2
  u "resolver: the owner IS the gap node => AMBIGUOUS (VTEP to self)" "$(resolve_owner $I $M 10.9.0.2 | grep -c 'gap node itself')" 1
  rst; ingest_local_line "$L" "wrk.example.com"
  u "resolver: a non-IPv4 owner address => AMBIGUOUS" "$(resolve_owner $I $M 10.9.0.2 | grep -c 'not an IPv4 literal')" 1

  # --- ledger: rolling-hour cap + the no-retry block ---
  t0=1760000000
  u "ledger: empty => 0 attempts, not blocked" "$(ledger_count_last_hour $t0)$(t ledger_blocked K@1.1.1.1 $t0)" 0no
  ledger_add $t0 K1@1.1.1.1 10.9.0.3 attempt; ledger_add $((t0+10)) K2@1.1.1.1 10.9.0.3 attempt; ledger_add $((t0+20)) K3@1.1.1.1 10.9.0.3 attempt
  u "ledger: 3 attempts inside the hour count 3"            "$(ledger_count_last_hour $((t0+3599)))" 3
  u "ledger: the oldest attempt leaves the window at +3600s" "$(ledger_count_last_hour $((t0+3600)))" 2
  ledger_add $((t0+30)) K1@1.1.1.1 10.9.0.3 verified
  u "ledger: only 'attempt' lines count toward the cap"       "$(ledger_count_last_hour $((t0+40)))" 3
  ledger_add $t0 B@1.1.1.1 10.9.0.3 unverified-reverted
  u "block: a failed-verification repair blocks that gap for REPAIR_BLOCK_HOURS" "$(t ledger_blocked B@1.1.1.1 $((t0+21599)))" yes
  u "block: ...and expires after 6h"                         "$(t ledger_blocked B@1.1.1.1 $((t0+21600)))" no
  u "block: another gap is not blocked"                      "$(t ledger_blocked Z@1.1.1.1 $((t0+60)))" no
  ledger_add $t0 A@1.1.1.1 10.9.0.3 apply-failed
  u "block: apply-failed blocks too"                         "$(t ledger_blocked A@1.1.1.1 $((t0+60)))" yes
  u "block: a verified repair does not block"                "$(t ledger_blocked K1@1.1.1.1 $((t0+60)))" no
)
unit_fail=0; [ -f "${WORK}/unit.fail" ] && unit_fail=1
check "unit tests: no failures" "$unit_fail" 0
# knobs (own subshells: each sources the script with a different env)
knob() { ( export STATE_DIR="${WORK}/knob-state"; env "$@" bash -c 'FDB_LIB_ONLY=1 . "$0"; echo "$MAX_REPAIRS_PER_HOUR $MAX_CLAMPED $REPAIR_BLOCK_HOURS"' "${SCRIPT}" ); }
check "knob: default cap is 3, block 6h"                        "$(knob X=1)" "3 0 6"
check "knob: a cap above 3 is CLAMPED to the hard ceiling"      "$(knob MAX_REPAIRS_PER_HOUR=10)" "3 1 6"
check "knob: a lower cap is honoured"                           "$(knob MAX_REPAIRS_PER_HOUR=1)" "1 0 6"
check "knob: a garbage cap falls back to 3 (never loosens)"     "$(knob MAX_REPAIRS_PER_HOUR=abc)" "3 0 6"
check "knob: a negative cap falls back to 3"                    "$(knob MAX_REPAIRS_PER_HOUR=-5)" "3 0 6"
check "knob: a garbage block window falls back to 6h"           "$(knob REPAIR_BLOCK_HOURS=x)" "3 0 6"

# ============================ MOCK SWARM ============================
cat > "${MOCKBIN}/docker" <<'MOCKDOCKER'
#!/usr/bin/env bash
NODE="${MOCK_NODE:-10.9.0.1}"
case "$1" in
  info)
    [ "${MOCK_DOCKER_DOWN:-}" = "$NODE" ] && exit 1
    [ "${2:-}" = "--format" ] && echo "10.9.0.1"
    exit 0 ;;
  node)
    case "$2" in ls) awk '{print $1}' "$MOCK_W/nodes" ;; inspect) awk -v h="$3" '$1==h{print $2}' "$MOCK_W/nodes" ;; esac
    exit 0 ;;
  network)   # network inspect dokploy-network -f <template>
    case "$5" in
      *IPAM*) echo "10.0.1.0/24" ;;
      *LOCAL_CONTAINER*) awk '{printf "LOCAL_CONTAINER ip=%s/24 mac=%s name=%s\n", $2, $3, $1}' "$MOCK_W/n/$NODE/containers" ;;
    esac
    exit 0 ;;
  inspect)   # inspect -f '{{.State.Pid}}' <name>
    [ -n "${MOCK_NO_PID:-}" ] && exit 0
    awk -v n="$4" '$1==n{print $4}' "$MOCK_W/n/$NODE/containers"; exit 0 ;;
esac
exit 0
MOCKDOCKER
cat > "${MOCKBIN}/ssh" <<'MOCKSSH'
#!/usr/bin/env bash
args=("$@"); i=0
while [ $i -lt ${#args[@]} ]; do case "${args[$i]}" in -o) i=$((i+2)) ;; -*) i=$((i+1)) ;; *) break ;; esac; done
addr="${args[$i]#root@}"; i=$((i+1)); cmd="${args[*]:$i}"
echo "ssh ${addr} :: ${cmd}" >> "$MOCK_W/ssh.log"
[ "${MOCK_SSH_DOWN:-}" = "$addr" ] && { echo "ssh: connect to host ${addr} port 22: Connection timed out" >&2; exit 255; }
MOCK_NODE="$addr" exec bash -c "$cmd"
MOCKSSH
cat > "${MOCKBIN}/nsenter" <<'MOCKNSENTER'
#!/usr/bin/env bash
case "$1" in
  --net=*) echo "netns-cmd node=${MOCK_NODE:-10.9.0.1} :: $*" >> "$MOCK_W/netns.log"; shift; exec "$@" ;;
  -t)      # nsenter -t <pid> -n ping -c 3 -W 2 <ip>   (the REAL-CALLER form)
    pid="$2"; target="${*: -1}"
    echo "ping from-pid=${pid} to=${target}" >> "$MOCK_W/ping.log"
    cfile="$(grep -l -E "^[^ ]+ [^ ]+ [^ ]+ ${pid}\$" "$MOCK_W"/n/*/containers | head -1)"
    [ -z "$cfile" ] && exit 2
    cnode="$(basename "$(dirname "$cfile")")"
    tnode=""; tmac=""
    for f in "$MOCK_W"/n/*/containers; do
      l="$(awk -v ip="$target" '$2==ip && $4!=0 {print $3; exit}' "$f")"
      [ -n "$l" ] && { tmac="$l"; tnode="$(basename "$(dirname "$f")")"; }
    done
    reach=1
    if [ -n "$tnode" ]; then
      if [ "$cnode" = "$tnode" ]; then reach=0
      elif awk -v m="$tmac" -v d="$tnode" '$1==m && $2==d{f=1} END{exit f?0:1}' "$MOCK_W/n/$cnode/fdb"; then reach=0; fi
    fi
    [ "${MOCK_PING_FORCE:-}" = ok ] && reach=0
    [ "${MOCK_PING_BLOCK:-}" = "$target" ] && reach=1
    if [ -f "$MOCK_W/hook" ]; then   # fires AFTER this answer is computed: a change between BEFORE and the write
      case "$(cat "$MOCK_W/hook")" in
        stale) echo "stale-sms 10.0.1.190 02:42:0a:00:01:be 0" >> "$MOCK_W/n/10.9.0.2/containers" ;;
        heal)  echo "02:42:0a:00:01:be 10.9.0.3" >> "$MOCK_W/n/10.9.0.2/fdb" ;;
      esac
      rm -f "$MOCK_W/hook"
    fi
    exit $reach ;;
esac
exit 0
MOCKNSENTER
cat > "${MOCKBIN}/ip" <<'MOCKIP'
#!/usr/bin/env bash
NODE="${MOCK_NODE:-10.9.0.1}"
case "$1 $2" in
  "-d link") exit 0 ;;
  "neigh show")   # PERMANENT neighbours = real containers on the OTHER nodes (+ stale ones from neigh_extra)
    for f in "$MOCK_W"/n/*/containers; do
      n="$(basename "$(dirname "$f")")"; [ "$n" = "$NODE" ] && continue
      awk '$4!=0{printf "%s lladdr %s PERMANENT\n", $2, $3}' "$f"
    done
    [ -f "$MOCK_W/n/$NODE/neigh_extra" ] && awk '{printf "%s lladdr %s PERMANENT\n", $1, $2}' "$MOCK_W/n/$NODE/neigh_extra" ;;
esac
exit 0
MOCKIP
cat > "${MOCKBIN}/bridge" <<'MOCKBRIDGE'
#!/usr/bin/env bash
NODE="${MOCK_NODE:-10.9.0.1}"; F="$MOCK_W/n/$NODE/fdb"
case "$1 $2" in
  "fdb show")   # NB the real output omits "dev vxlan0" from each line
    awk '{printf "%s dst %s link-netnsid 0 self permanent\n", $1, $2}' "$F"
    for f in "$MOCK_W"/n/*/containers; do n="$(basename "$(dirname "$f")")"; [ "$n" = "$NODE" ] && continue
      awk '$4!=0{printf "%s master br0 \n", $3}' "$f"; done ;;
  "fdb replace")   # replace <mac> dev vxlan0 dst <addr> self permanent
    [ -n "${MOCK_APPLY_FAIL:-}" ] && { echo "RTNETLINK answers: Operation not permitted" >&2; exit 1; }
    grep -v "^$3 " "$F" > "$F.t"; echo "$3 $7" >> "$F.t"; mv "$F.t" "$F"
    echo "${NODE} replace $3 dst $7" >> "$MOCK_W/mutations.log" ;;
  "fdb del")
    [ -n "${MOCK_REVERT_FAIL:-}" ] && { echo "RTNETLINK answers: Operation not permitted" >&2; exit 1; }
    grep -q "^$3 $7\$" "$F" || exit 2
    grep -v "^$3 $7\$" "$F" > "$F.t"; mv "$F.t" "$F"
    echo "${NODE} del $3 dst $7" >> "$MOCK_W/mutations.log" ;;
esac
exit 0
MOCKBRIDGE
cat > "${MOCKBIN}/curl" <<'MOCKCURL'
#!/usr/bin/env bash
{ echo "---- POST ${*: -1}"; cat; echo; } >> "$MOCK_W/slack.log"
[ "${MOCK_SLACK_FAIL:-0}" = 1 ] && exit 22
exit 0
MOCKCURL
cat > "${MOCKBIN}/jq" <<'MOCKJQ'
#!/usr/bin/env bash
in="$(cat)"; e="${in//\\/\\\\}"; e="${e//\"/\\\"}"; e="${e//$'\n'/\\n}"; printf '{"text":"%s"}' "$e"
MOCKJQ
chmod +x "${MOCKBIN}"/*
export PATH="${MOCKBIN}:${PATH}"

NOW=1793450096
T0=1793450096
build_world() {
  NOW="$T0"; rm -rf "$W"; mkdir -p "$W/n/10.9.0.1" "$W/n/10.9.0.2" "$W/n/10.9.0.3" "$W/netns" "$W/state"; : > "$W/netns/1-testns"
  printf 'mgr 10.9.0.1\nweb 10.9.0.2\nwrk 10.9.0.3\n' > "$W/nodes"
  printf 'mgr-app 10.0.1.10 02:42:0a:00:01:0a 1000\n' > "$W/n/10.9.0.1/containers"
  printf 'dokploy-network-endpoint 10.0.1.2 02:42:0a:00:01:02 0\nweb-caller 10.0.1.50 02:42:0a:00:01:32 2000\n' > "$W/n/10.9.0.2/containers"
  printf 'da-1 10.0.1.21 02:42:0a:00:01:15 3002\nredis-1 10.0.1.79 02:42:0a:00:01:4f 3001\nsms-1 10.0.1.190 02:42:0a:00:01:be 3000\nusers-1 10.0.1.164 02:42:0a:00:01:a4 3003\n' > "$W/n/10.9.0.3/containers"
  for n in 10.9.0.1 10.9.0.2 10.9.0.3; do   # healthy fdb: a VTEP for every real container on every OTHER node
    : > "$W/n/$n/fdb"
    for o in 10.9.0.1 10.9.0.2 10.9.0.3; do [ "$o" = "$n" ] && continue; awk -v d="$o" '$4!=0{print $3, d}' "$W/n/$o/containers" >> "$W/n/$n/fdb"; done
  done
  : > "$W/mutations.log"; : > "$W/slack.log"; : > "$W/ping.log"; : > "$W/ssh.log"; : > "$W/netns.log"; rm -f "$W/hook"
}
drop_vtep() { grep -v "^$2 " "$W/n/$1/fdb" > "$W/t"; mv "$W/t" "$W/n/$1/fdb"; }   # <node> <mac>: create a gap
SMS=02:42:0a:00:01:be; REDIS=02:42:0a:00:01:4f; DA=02:42:0a:00:01:15; USERS=02:42:0a:00:01:a4
run_detector() { out="$(env MOCK_W="$W" STATE_DIR="$W/state" NETNS_DIR="$W/netns" SLACK_WEBHOOK=https://hooks.invalid/x FDB_NOW_EPOCH="$NOW" "$@" bash "$SCRIPT" 2>&1 </dev/null)"; rc=$?; }
posts()     { grep -c '^---- POST' "$W/slack.log"; }
slack_has() { grep -c -F -- "$1" "$W/slack.log"; }                       # messages containing the text
slack_occ() { grep -o -F -- "$1" "$W/slack.log" | wc -l | tr -d ' '; }   # occurrences of the text
muts()      { wc -l < "$W/mutations.log" | tr -d ' '; }
fdb_has()   { grep -c "^$2 $3\$" "$W/n/$1/fdb"; }
ledger()    { cat "$W/state/repair-ledger" 2>/dev/null | awk -v o="$1" '$4==o' | wc -l | tr -d ' '; }

# ============================ SCENARIOS ============================
# 1 --- no gaps: silent, no mutation
build_world; run_detector AUTO_REPAIR_ENABLED=true
check "healthy fleet: exit 0"                 "$rc" 0
check "healthy fleet: says nominal"           "$(echo "$out" | grep -c 'nominal')" 1
check "healthy fleet: no Slack, no mutation"  "$(posts)/$(muts)" "0/0"

# 2 --- DRY-RUN is the DEFAULT: an unambiguous gap changes NOTHING but is reported with what it would do
build_world; drop_vtep 10.9.0.2 $SMS; run_detector
check "default (flag unset) = dry-run mode"            "$(echo "$out" | grep -c 'auto-repair mode: dry-run')" 1
check "dry-run: NO mutation on any node"               "$(muts)" 0
check "dry-run: the gap is still open (no dst entry)"  "$(fdb_has 10.9.0.2 $SMS 10.9.0.3)" 0
check "dry-run: the standard alert is posted once"     "$(posts)" 1
check "dry-run: alert says what it WOULD run"          "$(slack_has 'would run on 10.9.0.2')" 1
check "dry-run: ...names the resolved owner (FIX line + dry-run note)" "$(slack_occ "bridge fdb replace ${SMS} dev vxlan0 dst 10.9.0.3 self permanent")" 2
check "dry-run: ...and the undo it would use"          "$(slack_has 'Undo would be')" 1
check "dry-run: the BEFORE test ran from the real caller (pid 2000)" "$(grep -c 'from-pid=2000 to=10.0.1.190' "$W/ping.log")" 1
check "dry-run: no repair ledger entry (dry-run costs no budget)"    "$(ledger attempt)" 0
check "dry-run: Slack says nothing was changed"        "$(slack_has 'NOTHING was changed')" 1

# 3 --- only the exact string "true" arms it
for v in false yes 1 True TRUE ""; do
  build_world; drop_vtep 10.9.0.2 $SMS; run_detector AUTO_REPAIR_ENABLED="$v"
  check "AUTO_REPAIR_ENABLED='$v' stays dry-run (no mutation)" "$(muts)" 0
done

# 4 --- ARMED + unambiguous owner: one replace, verified from the real caller, announced with the undo
build_world; drop_vtep 10.9.0.2 $SMS; run_detector AUTO_REPAIR_ENABLED=true
check "armed: mode is armed"                                  "$(echo "$out" | grep -c 'auto-repair mode: armed')" 1
check "armed: exactly ONE mutation"                           "$(muts)" 1
check "armed: it is a replace of the right MAC on the gap node with the OWNER as dst" "$(cat "$W/mutations.log")" "10.9.0.2 replace ${SMS} dst 10.9.0.3"
check "armed: the VTEP entry now exists"                      "$(fdb_has 10.9.0.2 $SMS 10.9.0.3)" 1
check "armed: BEFORE and AFTER were both run from the real caller container" "$(grep -c 'from-pid=2000 to=10.0.1.190' "$W/ping.log")" 2
check "armed: NO test ever ran from a gateway netns"          "$(grep -c 'ping' "$W/netns.log")" 0
check "armed: exactly one Slack post (the repaired gap is not re-alerted)" "$(posts)" 1
check "armed: Slack says APPLIED"                             "$(slack_has 'auto-repair APPLIED')" 1
check "armed: Slack shows BEFORE failed / AFTER ok"           "$(slack_has 'ping 10.0.1.190 FAILED')$(slack_has 'ping 10.0.1.190 OK')" 11
check "armed: Slack carries the exact UNDO command"           "$(slack_has "bridge fdb del ${SMS} dev vxlan0 dst 10.9.0.3 self permanent")" 1
check "armed: Slack says how many repairs this hour"          "$(slack_has 'Auto-repairs in the last hour: 1/3')" 1
check "armed: ledger has one attempt + one verified"          "$(ledger attempt)/$(ledger verified)" "1/1"
run_detector AUTO_REPAIR_ENABLED=true
check "armed: next run is nominal, no further mutation/post"  "$(muts)/$(posts)" "1/1"

# 5 --- armed without a webhook: refuses to arm (never mutate silently)
build_world; drop_vtep 10.9.0.2 $SMS; run_detector AUTO_REPAIR_ENABLED=true SLACK_WEBHOOK=
check "armed w/o webhook: refuses, stays dry-run"  "$(echo "$out" | grep -c 'refusing to arm')" 1
check "armed w/o webhook: NO mutation"             "$(muts)" 0

# 6 --- AMBIGUOUS owner (a stale endpoint on the gap node claims the same IP+MAC): alert-only, never a guess
build_world; drop_vtep 10.9.0.2 $SMS; echo "stale-sms 10.0.1.190 ${SMS} 0" >> "$W/n/10.9.0.2/containers"; run_detector AUTO_REPAIR_ENABLED=true
check "ambiguous owner: NO mutation"                    "$(muts)" 0
check "ambiguous owner: one alert is posted"            "$(posts)" 1
check "ambiguous owner: the alert says AMBIGUOUS + why (owner field + note)" "$(slack_occ 'reported as local by several nodes')" 2
check "ambiguous owner: no ready-to-paste command with a guessed dst" "$(slack_has "dst 10.9.0.3 self permanent")" 0
check "ambiguous owner: the note says alert-only"       "$(slack_has 'AUTO-REPAIR: alert-only')" 1
check "ambiguous owner: the journal explains the refusal" "$(echo "$out" | grep -c '\[alert-only\]: AUTO-REPAIR: alert-only')" 1

# 7 --- UNRESOLVED owner: the neighbour entry outlived its container (no node reports it): alert-only
build_world; drop_vtep 10.9.0.2 $SMS; grep -v '^sms-1 ' "$W/n/10.9.0.3/containers" > "$W/t"; mv "$W/t" "$W/n/10.9.0.3/containers"
echo "10.0.1.190 ${SMS}" > "$W/n/10.9.0.2/neigh_extra"; run_detector AUTO_REPAIR_ENABLED=true
check "unresolved owner: NO mutation"                    "$(muts)" 0
check "unresolved owner: the alert says UNRESOLVED"      "$(slack_has 'UNRESOLVED')" 1
check "unresolved owner: no ready-to-paste real dst"     "$(slack_has "dst 10.9.0.3 self permanent")" 0

# 8 --- INCOMPLETE cluster view (a node's docker is down / ssh is down): ownership is unprovable => alert-only
build_world; drop_vtep 10.9.0.2 $SMS; run_detector AUTO_REPAIR_ENABLED=true MOCK_DOCKER_DOWN=10.9.0.3
check "docker down on the owner node: NO mutation"       "$(muts)" 0
check "docker down: the alert says the cluster view is incomplete" "$(slack_has 'cluster view incomplete')" 1
build_world; drop_vtep 10.9.0.2 $SMS; run_detector AUTO_REPAIR_ENABLED=true MOCK_SSH_DOWN=10.9.0.3
check "ssh down to the owner node: NO mutation"          "$(muts)" 0
check "ssh down: the alert names the unreachable node"   "$(slack_has 'INCOMPLETE')" 1

# 9 --- HOURLY CAP: 4 gaps => 3 repaired, the 4th alert-only; the window slides; then it is repaired
build_world; for m in $SMS $REDIS $DA $USERS; do drop_vtep 10.9.0.2 $m; done; run_detector AUTO_REPAIR_ENABLED=true
check "cap: 3 repairs in one run, not 4"                  "$(muts)" 3
check "cap: the 3 repaired gaps have their VTEP"          "$(fdb_has 10.9.0.2 $DA 10.9.0.3)$(fdb_has 10.9.0.2 $REDIS 10.9.0.3)$(fdb_has 10.9.0.2 $USERS 10.9.0.3)" 111
check "cap: the 4th gap (sms) is untouched"               "$(fdb_has 10.9.0.2 $SMS 10.9.0.3)" 0
check "cap: 3 APPLIED + 1 alert-only alert = 4 posts"     "$(posts)" 4
check "cap: the alert says the hourly cap was reached"    "$(slack_has 'hourly cap reached (3/3')" 1
check "cap: the ledger holds exactly 3 attempts"          "$(ledger attempt)" 3
check "cap: the 3rd APPLIED message says 3/3"             "$(slack_has 'Auto-repairs in the last hour: 3/3')" 1
NOW=$((T0 + 600)); run_detector AUTO_REPAIR_ENABLED=true
check "cap: 10 min later the 4th is STILL alert-only (no mutation, alert deduped)" "$(muts)/$(posts)" "3/4"
NOW=$((T0 + 3700)); run_detector AUTO_REPAIR_ENABLED=true
check "cap: once the first repairs leave the 1h window the 4th is repaired" "$(muts)" 4
check "cap: ...and announced"                              "$(slack_has 'auto-repair APPLIED')" 4
run_detector AUTO_REPAIR_ENABLED=true
check "cap: the next nominal run posts one RESOLVED notice" "$(slack_has 'previously reported VTEP gap(s) are RESOLVED')" 1

# 10 --- the cap cannot be raised above 3; a lower cap is honoured
build_world; for m in $SMS $REDIS $DA $USERS; do drop_vtep 10.9.0.2 $m; done; run_detector AUTO_REPAIR_ENABLED=true MAX_REPAIRS_PER_HOUR=10
check "clamp: MAX_REPAIRS_PER_HOUR=10 still allows only 3" "$(muts)" 3
check "clamp: the run says it clamped"                     "$(echo "$out" | grep -c 'clamped to 3')" 1
build_world; for m in $SMS $REDIS $DA $USERS; do drop_vtep 10.9.0.2 $m; done; run_detector AUTO_REPAIR_ENABLED=true MAX_REPAIRS_PER_HOUR=1
check "lower cap: MAX_REPAIRS_PER_HOUR=1 allows only 1"    "$(muts)" 1

# 11 --- the path already works from a real caller despite the gap: not touched
build_world; drop_vtep 10.9.0.2 $SMS; run_detector AUTO_REPAIR_ENABLED=true MOCK_PING_FORCE=ok
check "already reachable: NO mutation"                     "$(muts)" 0
check "already reachable: the alert explains why"          "$(slack_has 'REACHABLE from real caller web-caller')" 1

# 12 --- no real caller on the gap node (only the load-balancer endpoint): cannot verify => alert-only
build_world; drop_vtep 10.9.0.2 $SMS; sed -i '/^web-caller /d' "$W/n/10.9.0.2/containers"; run_detector AUTO_REPAIR_ENABLED=true
check "no real caller: NO mutation"                        "$(muts)" 0
check "no real caller: the alert says so"                  "$(slack_has 'no real caller container on 10.9.0.2')" 1
check "no real caller: nothing was pinged"                 "$(wc -l < "$W/ping.log" | tr -d ' ')" 0

# 13 --- the probe cannot run (no PID for the container): cannot verify => alert-only
build_world; drop_vtep 10.9.0.2 $SMS; run_detector AUTO_REPAIR_ENABLED=true MOCK_NO_PID=1
check "probe unavailable: NO mutation"                     "$(muts)" 0
check "probe unavailable: the alert says it cannot test"   "$(slack_has 'cannot test from a real caller container')" 1

# 14 --- TOCTOU: the owner becomes ambiguous between the BEFORE test and the write
build_world; drop_vtep 10.9.0.2 $SMS; echo stale > "$W/hook"; run_detector AUTO_REPAIR_ENABLED=true
check "owner changed after BEFORE: NO mutation"            "$(muts)" 0
check "owner changed after BEFORE: the note says re-resolution caught it" "$(slack_has 'on re-resolution')" 1
check "owner changed after BEFORE: no ledger attempt"      "$(ledger attempt)" 0

# 15 --- TOCTOU: the gap heals itself between the BEFORE test and the write
build_world; drop_vtep 10.9.0.2 $SMS; echo heal > "$W/hook"; run_detector AUTO_REPAIR_ENABLED=true
check "healed before the write: NO mutation by us"         "$(muts)" 0
check "healed before the write: nothing to alert"          "$(posts)" 0
check "healed before the write: the journal says so"       "$(echo "$out" | grep -c 'gap healed on its own before the write')" 1

# 16 --- AFTER does not verify (ICMP blocked): REVERTED to the exact pre-state; no thrash afterwards
build_world; drop_vtep 10.9.0.2 $SMS; run_detector AUTO_REPAIR_ENABLED=true MOCK_PING_BLOCK=10.0.1.190
check "unverified: replace THEN del (the node is put back)" "$(awk '{print $2}' "$W/mutations.log" | tr '\n' ' ')" "replace del "
check "unverified: the gap is back to its pre-state"        "$(fdb_has 10.9.0.2 $SMS 10.9.0.3)" 0
check "unverified: Slack announces the REVERT (own message)" "$(slack_has 'auto-repair did NOT verify')" 1
check "unverified: ...with the before/after evidence"       "$(slack_has 'ping 10.0.1.190 FAILED')" 1
check "unverified: the still-open gap is alerted (2 posts)" "$(posts)" 2
check "unverified: ledger = 1 attempt + 1 unverified-reverted" "$(ledger attempt)/$(ledger unverified-reverted)" "1/1"
NOW=$((T0 + 600)); run_detector AUTO_REPAIR_ENABLED=true MOCK_PING_BLOCK=10.0.1.190
check "unverified: NOT retried 10 min later (blocked)"      "$(muts)" 2
check "unverified: the journal says it is blocked (alert deduped, reason not)" "$(echo "$out" | grep -c 'failed verification')" 1
NOW=$((T0 + 21600 + 60)); run_detector AUTO_REPAIR_ENABLED=true MOCK_PING_BLOCK=10.0.1.190
check "unverified: retried only after REPAIR_BLOCK_HOURS (6h)" "$(muts)" 4

# 17 --- the revert itself fails: loud, entry still in place, UNDO NOW
build_world; drop_vtep 10.9.0.2 $SMS; run_detector AUTO_REPAIR_ENABLED=true MOCK_PING_BLOCK=10.0.1.190 MOCK_REVERT_FAIL=1
check "revert failed: the new entry is STILL in place"      "$(fdb_has 10.9.0.2 $SMS 10.9.0.3)" 1
check "revert failed: Slack says so with UNDO NOW"          "$(slack_has 'did NOT verify and the REVERT FAILED')$(slack_has 'UNDO NOW')" 11
check "revert failed: ledger records revert-failed"         "$(ledger revert-failed)" 1

# 18 --- the apply itself fails: recorded, announced, blocked, nothing verified
build_world; drop_vtep 10.9.0.2 $SMS; run_detector AUTO_REPAIR_ENABLED=true MOCK_APPLY_FAIL=1
check "apply failed: no mutation happened"                  "$(muts)" 0
check "apply failed: Slack says could not APPLY"            "$(slack_has 'could not APPLY')" 1
check "apply failed: ledger = attempt + apply-failed"       "$(ledger attempt)/$(ledger apply-failed)" "1/1"

# 19 --- fail CLOSED: a ledger that cannot be written => no mutation
build_world; drop_vtep 10.9.0.2 $SMS; mkdir "$W/state/repair-ledger"; run_detector AUTO_REPAIR_ENABLED=true
check "unwritable ledger: NO mutation"                      "$(muts)" 0
check "unwritable ledger: the note says why"                "$(slack_has 'cannot write the repair ledger')" 1

# 20 --- mixed run: the unambiguous gap is repaired, the ambiguous one stays alert-only
build_world; drop_vtep 10.9.0.2 $SMS; drop_vtep 10.9.0.2 $REDIS; echo "stale-redis 10.0.1.79 ${REDIS} 0" >> "$W/n/10.9.0.2/containers"; run_detector AUTO_REPAIR_ENABLED=true
check "mixed: only the unambiguous gap (sms) was repaired"  "$(cat "$W/mutations.log")" "10.9.0.2 replace ${SMS} dst 10.9.0.3"
check "mixed: the ambiguous gap (redis) is untouched"       "$(fdb_has 10.9.0.2 $REDIS 10.9.0.3)" 0
check "mixed: 1 APPLIED + 1 alert for the leftover = 2 posts" "$(posts)" 2

# 21 --- TEST_ALERT names the mode (so an install-time test shows whether it is armed)
build_world; run_detector TEST_ALERT=true
check "TEST_ALERT: dry-run by default"                      "$(slack_has 'auto-repair mode: dry-run')" 1
build_world; run_detector TEST_ALERT=true AUTO_REPAIR_ENABLED=true
check "TEST_ALERT: armed when enabled"                      "$(slack_has 'auto-repair mode: armed')" 1

# 22 --- the REAL owner's node is unreachable while a STALE claim sits on another node: the stale claimant must
#        never look like the owner (in dry-run it would otherwise print a "would run ... dst <wrong node>")
build_world; drop_vtep 10.9.0.2 $SMS; echo "stale-sms 10.0.1.190 ${SMS} 0" >> "$W/n/10.9.0.1/containers"; run_detector MOCK_SSH_DOWN=10.9.0.3
check "stale claim + owner node down (dry-run): never claims it would repair" "$(slack_has 'would run on')" 0
check "stale claim + owner node down (dry-run): the note names the incomplete view" "$(slack_has 'cluster view incomplete')" 1
build_world; drop_vtep 10.9.0.2 $SMS; echo "stale-sms 10.0.1.190 ${SMS} 0" >> "$W/n/10.9.0.1/containers"; run_detector AUTO_REPAIR_ENABLED=true MOCK_SSH_DOWN=10.9.0.3
check "stale claim + owner node down (armed): NO mutation"                    "$(muts)" 0
echo "----"
[ "$fail" -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$fail"
