#!/usr/bin/env bash
# check-overlay-fdb.sh — Docker Swarm overlay VTEP/FDB-gap detector (DETECT-ONLY).
#
# On EVERY swarm node, for the APP overlay (dokploy-network) netns, find MACs that
# have a PERMANENT ARP/neigh entry but NO `bridge fdb ... dst` (VTEP) line. That
# asymmetry is the signature of the cross-node partition that silently killed all
# outbound email for ~6 days (2026-08-31 and 2026-09-03): the node knows the peer
# MAC but has nowhere to tunnel its frames, so every connection to that container
# black-holes until `bridge fdb replace <mac> dev vxlan0 dst <peer-host-ip> self
# permanent` is re-added.
#
# SCOPING: only the app overlay is checked (subnet derived from dokploy-network,
# default 10.0.1.). The Swarm ingress network (10.0.0.0/24) is intentionally
# EXCLUDED — a neigh-without-dst is normal there (node endpoints without ingress
# tasks) and would false-positive constantly.
#
# DETECTS + alerts Slack, and (opt-in, #220) can APPLY the repair under hard guards.
# #939 (2026-09-24): each gap's overlay-IP is RESOLVED to the node that OWNS the target
# container (the correct VXLAN `dst`) from each node's OWN local-container view (a
# container runs on exactly one node), and the alert carries a READY-TO-PASTE
# `bridge fdb replace ... dst <owner> ...` command.
# #220 (m1030 P3, D10): the bug never self-heals (moby #52265/#52661; 6 prod hits since
# 08-30; the 10-27 sms gap cost ~2h of human latency), so the same fix can now be applied
# by the detector itself. A wrong MAC->node mapping would silently tunnel traffic to the
# wrong host (worse than the gap), hence the guards:
#   * DRY-RUN IS THE DEFAULT. Nothing is changed unless AUTO_REPAIR_ENABLED=true (exact
#     string) AND SLACK_WEBHOOK is set (a silent mutation of prod networking is refused).
#     Dry-run still logs + alerts exactly what it WOULD do.
#   * Only an UNAMBIGUOUS owner is repaired: exactly one node reports the gap's IP AND MAC
#     as local, the two agree, the owner is not the gap node itself, and the owner is
#     re-resolved (and the gap re-confirmed) immediately before the write. Unresolved,
#     ambiguous or conflicting => alert-only, never a guess.
#   * Re-tested from a REAL caller container (`nsenter -t <container pid> -n ping` — NEVER
#     the overlay gateway netns, which shows 100% loss even when fixed) BEFORE (must FAIL:
#     the break is real) and AFTER (must pass). No caller on the node / probe unavailable /
#     target already reachable => alert-only. A repair that does not verify is REVERTED to
#     the exact pre-state and is not auto-retried for REPAIR_BLOCK_HOURS.
#   * At most MAX_REPAIRS_PER_HOUR (default 3; 3 is also the ceiling) mutations fleet-wide
#     per rolling hour, then alert-only. Counted in a ledger on this (manager-only) host.
#   * Every mutation is announced in Slack: what was done, before/after, and the UNDO.
#
# Runs on the Swarm manager (VPS2); reaches worker nodes over SSH (root key already
# trusted node->node). Read-only everywhere unless auto-repair is armed.
#
# Env: SLACK_WEBHOOK (unset => log-only), STATE_DIR (default /var/lib/overlay-fdb-detector),
#      REMIND_HOURS (default 24), TEST_ALERT ("true" => post one Slack msg to validate path),
#      APP_SUBNET_PREFIX (override the auto-derived app subnet prefix, e.g. "10.0.1.").
#      (DEBOUNCE_HOURS is retired — see "Alert cadence" below.)
#      AUTO_REPAIR_ENABLED ("true" arms #220 auto-repair; anything else = DRY-RUN, the default),
#      MAX_REPAIRS_PER_HOUR (default 3, clamped to <=3), REPAIR_BLOCK_HOURS (default 6: no
#      auto-retry of a gap whose repair failed verification), NETNS_DIR (default
#      /var/run/docker/netns; tests only), FDB_NOW_EPOCH (tests only).
#
# Alert cadence (2026-10-12): the old flat 2h debounce re-posted the SAME unchanged gap
# ~12x/day (one revhero-web -> shared-Redis gap paged ~60 identical alerts 10-07..10-12,
# burying real alerts in #deployments-and-bugs). Now the alert is keyed on a fingerprint
# of the gap SET: a NEW or CHANGED set alerts immediately; an UNCHANGED set re-alerts at
# most every REMIND_HOURS, labelled as a reminder; when the set clears, one "resolved"
# message is posted and the state resets (so a recurrence alerts at once).

set -uo pipefail
SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"
STATE_DIR="${STATE_DIR:-/var/lib/overlay-fdb-detector}"
MARKER="${STATE_DIR}/last-alert"
FP_FILE="${STATE_DIR}/last-alert-fingerprint"
FIRST_FILE="${STATE_DIR}/gap-set-first-seen"
REMIND_HOURS="${REMIND_HOURS:-24}"
TEST_ALERT="${TEST_ALERT:-false}"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=no"

log() { echo "[overlay-fdb $(date -u +%H:%M:%SZ)] $*"; }

# Stable fingerprint of a gap set (order-independent): host + netns + mac + ip per gap.
gap_fingerprint() {
  printf '%s\n' "$1" | sed '/^[[:space:]]*$/d' \
    | sed -E 's/.*(host=[^ ]+).*(ns=[^ ]+).*(mac=[^ ]+).*(ip=[^ ]+).*/\1 \2 \3 \4/' \
    | sort -u | sha256sum | cut -c1-16
}
# new | remind | suppress — for the current set's fingerprint ($1) at time $2 (epoch s).
alert_decision() {
  local fp="$1" now="$2" last_fp last_ts
  last_fp="$(cat "$FP_FILE" 2>/dev/null || true)"
  last_ts="$(cat "$MARKER" 2>/dev/null || echo 0)"
  if [ "$fp" != "$last_fp" ]; then echo new; return; fi
  if [ $(( now - ${last_ts:-0} )) -ge $(( ${REMIND_HOURS%.*} * 3600 )) ]; then echo remind; return; fi
  echo suppress
}
# Record a SUCCESSFULLY posted alert ($1 fingerprint, $2 time, $3 decision).
record_alert() {
  mkdir -p "$STATE_DIR"
  echo "$2" > "$MARKER"
  echo "$1" > "$FP_FILE"
  [ "$3" = "new" ] && echo "$2" > "$FIRST_FILE"
  return 0
}
clear_alert_state() { rm -f "$MARKER" "$FP_FILE" "$FIRST_FILE"; }

# ---------------------------------------------------------------------------------------------
# #220 guarded auto-repair — pure helpers (unit-tested through FDB_LIB_ONLY=1, see test-auto-repair.sh)
# ---------------------------------------------------------------------------------------------
AUTO_REPAIR_ENABLED="${AUTO_REPAIR_ENABLED:-false}"
MAX_REPAIRS_PER_HOUR="${MAX_REPAIRS_PER_HOUR:-3}"
REPAIR_BLOCK_HOURS="${REPAIR_BLOCK_HOURS:-6}"
NETNS_DIR="${NETNS_DIR:-/var/run/docker/netns}"
REMOTE_TIMEOUT="${REMOTE_TIMEOUT:-40}"
# Ledger of mutations on this (manager-only => fleet-wide) host, one line each:
#   <epoch> <mac>@<gap-node-addr> <owner-addr> <attempt|verified|unverified-reverted|revert-failed>
LEDGER="${STATE_DIR}/repair-ledger"
# A bad knob must never silently loosen a guard: non-numeric => the safe default; the cap is clamped to 3.
MAX_CLAMPED=0
case "$MAX_REPAIRS_PER_HOUR" in ''|*[!0-9]*) MAX_REPAIRS_PER_HOUR=3 ;; esac
if [ "$MAX_REPAIRS_PER_HOUR" -gt 3 ]; then MAX_REPAIRS_PER_HOUR=3; MAX_CLAMPED=1; fi
case "$REPAIR_BLOCK_HOURS" in ''|*[!0-9]*) REPAIR_BLOCK_HOURS=6 ;; esac
case "$REMOTE_TIMEOUT" in ''|*[!0-9]*) REMOTE_TIMEOUT=40 ;; esac

now_epoch() { echo "${FDB_NOW_EPOCH:-$(date +%s)}"; }

# Everything that comes back from a remote node is validated before it is put in a command line.
is_mac()   { [[ "${1:-}" =~ ^([0-9a-f]{2}:){5}[0-9a-f]{2}$ ]]; }
is_ipv4()  { [[ "${1:-}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }
is_ns()    { [[ "${1:-}" =~ ^[0-9A-Za-z][0-9A-Za-z_-]*$ ]]; }
is_cname() { [[ "${1:-}" =~ ^[0-9A-Za-z][0-9A-Za-z_.-]*$ ]]; }

# --- ledger: the hourly cap and the no-retry-after-failed-verification block -----------------
ledger_add() {  # now key owner outcome  (returns non-zero when it could not be written: callers fail CLOSED)
  mkdir -p "$STATE_DIR" 2>/dev/null || return 1
  printf '%s %s %s %s\n' "$1" "$2" "$3" "$4" >> "$LEDGER" || return 1
  local tmp="${LEDGER}.tmp.$$"   # keep a week; the cap looks back 1h, the block REPAIR_BLOCK_HOURS
  awk -v cut="$(( $1 - 604800 ))" '$1+0 > cut' "$LEDGER" > "$tmp" 2>/dev/null && mv -f "$tmp" "$LEDGER"
  return 0
}
ledger_count_last_hour() {  # now -> number of mutations (attempts) in the rolling hour
  [ -f "$LEDGER" ] || { echo 0; return; }
  awk -v cut="$(( $1 - 3600 ))" '$4=="attempt" && $1+0 > cut {n++} END{print n+0}' "$LEDGER"
}
ledger_blocked() {  # key now -> true when a repair of this gap failed verification / could not be undone recently
  [ -f "$LEDGER" ] || return 1
  awk -v k="$1" -v cut="$(( $2 - REPAIR_BLOCK_HOURS * 3600 ))" \
    '$2==k && ($4=="unverified-reverted" || $4=="revert-failed" || $4=="apply-failed") && $1+0 > cut {f=1} END{exit f?0:1}' "$LEDGER"
}

# --- owner resolver (#939, hardened for auto-apply) -------------------------------------------
# Filled from every node's LOCAL_CONTAINER lines. Sets (space-separated, de-duplicated) of the node
# addresses that report an overlay IP / MAC as LOCAL. A container runs on exactly one node, so more than
# one claimant is a stale endpoint or an address reuse — and picking one of them is a guess.
declare -A ip2nodes mac2nodes ip2name node_containers
_set_add() { case " $1 " in *" $2 "*) echo "$1" ;; *) echo "${1:+$1 }$2" ;; esac; }
ingest_local_line() {  # "LOCAL_CONTAINER ip=<ip>/<len> mac=<mac> name=<name>"  +  the reporting node's address
  local l="$1" addr="$2" cip cmac cnm
  cip="$(printf '%s' "$l" | grep -oE ' ip=[0-9.]+' | head -1 | cut -d= -f2)"
  cmac="$(printf '%s' "$l" | grep -oE ' mac=[0-9a-fA-F:]+' | head -1 | cut -d= -f2 | tr 'A-F' 'a-f')"
  cnm="$(printf '%s' "$l" | sed -nE 's/.* name=(.*)$/\1/p')"
  if [ -n "$cip" ]; then
    ip2nodes["$cip"]="$(_set_add "${ip2nodes[$cip]:-}" "$addr")"
    ip2name["$cip"]="${cnm:-unknown}"
    node_containers["$addr"]+="${cnm:-unknown} ${cip}"$'\n'
  fi
  if [ -n "$cmac" ]; then mac2nodes["$cmac"]="$(_set_add "${mac2nodes[$cmac]:-}" "$addr")"; fi
  return 0
}
# resolve_owner <ip> <mac> <gap-node-addr>  ->  "OK <owner-addr>" | "UNRESOLVED" | "AMBIGUOUS: <why>"
# OK only when exactly ONE node reports the IP, exactly ONE reports the MAC, they are the SAME node, it is a
# plain IPv4 literal, and it is not the gap node itself. Everything else is alert-only.
resolve_owner() {
  local ip="$1" mac="$2" gap="$3" ipn mn
  ipn="${ip2nodes[$ip]:-}"; mn="${mac2nodes[$mac]:-}"
  if [ -z "$ipn" ] && [ -z "$mn" ]; then echo "UNRESOLVED"; return; fi
  case "$ipn" in *" "*) echo "AMBIGUOUS: IP ${ip} is reported as local by several nodes (${ipn// /, })"; return ;; esac
  case "$mn" in *" "*) echo "AMBIGUOUS: MAC ${mac} is reported as local by several nodes (${mn// /, })"; return ;; esac
  if [ -z "$ipn" ] || [ -z "$mn" ]; then
    echo "AMBIGUOUS: only one of IP/MAC resolves to a node (ip->'${ipn:-none}', mac->'${mn:-none}')"; return
  fi
  if [ "$ipn" != "$mn" ]; then echo "AMBIGUOUS: IP and MAC resolve to DIFFERENT nodes (ip->${ipn}, mac->${mn})"; return; fi
  if ! is_ipv4 "$ipn"; then echo "AMBIGUOUS: owner address '${ipn:0:40}' is not an IPv4 literal"; return; fi
  if [ "$ipn" = "$gap" ]; then echo "AMBIGUOUS: the owner is the gap node itself (${gap}) — a VTEP to itself is meaningless"; return; fi
  echo "OK ${ipn}"
}

# Sourced by test-alert-cadence.sh for the functions above only (never set in production).
if [ "${FDB_LIB_ONLY:-}" = "1" ]; then return 0; fi

# One run at a time: a manual run must not overlap the timer's (double mutation / a miscounted cap).
if command -v flock >/dev/null 2>&1; then
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  if exec 9>"${STATE_DIR}/run.lock"; then
    flock -n 9 || { log "another run holds ${STATE_DIR}/run.lock — exiting (not an error)"; exit 0; }
  fi
fi

# Auto-repair mode: DRY-RUN unless explicitly armed, and never armed without a way to announce it.
REPAIR_MODE="dry-run"
if [ "$AUTO_REPAIR_ENABLED" = "true" ]; then
  if [ -n "$SLACK_WEBHOOK" ]; then REPAIR_MODE="armed"
  else log "WARNING: AUTO_REPAIR_ENABLED=true but SLACK_WEBHOOK is unset — refusing to arm (a silent prod network mutation); staying in DRY-RUN."; fi
fi
[ "$MAX_CLAMPED" = 1 ] && log "WARNING: MAX_REPAIRS_PER_HOUR was above the hard ceiling of 3 — clamped to 3."
log "auto-repair mode: ${REPAIR_MODE} (cap ${MAX_REPAIRS_PER_HOUR}/h fleet-wide, no auto-retry of a failed repair for ${REPAIR_BLOCK_HOURS}h)"
if [ "$REPAIR_MODE" = "armed" ]; then
  MODE_NOTE="Auto-repair is ARMED: gaps it can repair safely (unambiguous owner, verified from a real caller container, at most ${MAX_REPAIRS_PER_HOUR}/h) are fixed and announced in their own message; the gaps below are the ones it did NOT repair, each with the reason."
else
  MODE_NOTE="Auto-repair is in DRY-RUN (the default): NOTHING was changed; the notes under each gap say what it would do."
fi

# App overlay subnet prefix (e.g. 10.0.1.) — auto-derived from dokploy-network so a
# renumber doesn't silently disable the check; overridable via env.
PREFIX="${APP_SUBNET_PREFIX:-}"
if [ -z "$PREFIX" ]; then
  PREFIX="$(docker network inspect dokploy-network -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null \
            | sed -nE 's#^([0-9]+\.[0-9]+\.[0-9]+)\..*#\1.#p')"
fi
[ -z "$PREFIX" ] && PREFIX="10.0.1."

# Per-node check, fed to bash via stdin (local or over ssh); $1 = app subnet prefix,
# $2 = the docker netns dir. Single-quoted heredoc => no expansion here; awk field refs
# stay literal remotely. Emits these line kinds (host context; it does its own nsenter for
# the netns part):
#   "MISSING_VTEP ns=<id> mac=<mac> ip=<overlay-ip>"                    — a VTEP gap in a netns
#   "LOCAL_CONTAINER ip=<overlay-ip>/<len> mac=<mac> name=<container>" — a container LOCAL to
#       THIS node (so the manager can map any gap's overlay IP + MAC -> this node = the dst).
#   "NODE_OK" (ran to the end) / "NODE_ERR <why>" (docker unavailable) — see OWNER_CHECK below.
read -r -d '' GAP_CHECK <<'CHK' || true
P="${1:-10.0.1.}"
NS_DIR="${2:-/var/run/docker/netns}"
for ns in "$NS_DIR"/*; do
  nsenter --net="$ns" ip -d link show vxlan0 >/dev/null 2>&1 || continue
  nsenter --net="$ns" ip neigh show dev vxlan0 2>/dev/null | grep -q "^${P}" || continue
  neigh=$(nsenter --net="$ns" ip neigh show dev vxlan0 2>/dev/null | awk '/PERMANENT/{print tolower($3)}' | sort -u)
  fdb=$(nsenter --net="$ns" bridge fdb show dev vxlan0 2>/dev/null | awk '/dst/{print tolower($1)}' | sort -u)
  while read -r mac; do
    [ -z "$mac" ] && continue
    ip=$(nsenter --net="$ns" ip neigh show dev vxlan0 2>/dev/null | awk -v M="$mac" 'tolower($3)==M{print $1; exit}')
    case "$ip" in
      "${P}"*) echo "MISSING_VTEP ns=$(basename "$ns") mac=$mac ip=${ip:-?}" ;;
    esac
  done < <(comm -23 <(printf '%s\n' "$neigh") <(printf '%s\n' "$fdb"))
done
CHK
# This node's local dokploy-network containers (ip + mac + name) -> lets the manager resolve the owning
# node (correct VXLAN dst) for any gap. A container is local to exactly one node, so whichever node
# reports it here owns it. ONE definition, used by the survey (appended to GAP_CHECK below) AND by the
# fresh re-resolution right before a repair, so the two can never drift apart.
#   NODE_OK  = the node answered and ran the whole script. Its ABSENCE means that node's containers are
#              missing from the owner maps, which could hide a conflicting claim — so an incomplete
#              cluster view disables auto-repair for the run (alert-only).
read -r -d '' OWNER_CHECK <<'OWN' || true
docker info >/dev/null 2>&1 || { echo "NODE_ERR docker-unavailable"; exit 0; }
docker network inspect dokploy-network -f '{{range $id, $c := .Containers}}LOCAL_CONTAINER ip={{$c.IPv4Address}} mac={{$c.MacAddress}} name={{$c.Name}}{{println}}{{end}}' 2>/dev/null || true
echo NODE_OK
OWN
NODE_CHECK="${GAP_CHECK}"$'\n'"${OWNER_CHECK}"

# Real-caller probe, run ON the gap node: the container's PID is looked up there and the host's ping runs
# INSIDE the container's own netns (nsenter -t <pid> -n). NEVER the overlay gateway netns — that shows 100%
# loss even when the repair worked (the source is the bridge IP, which the peer has no return VTEP for).
#   PROBE_OK = a reply; PROBE_FAIL = ping ran and got none (exit 1); anything else = could not test.
read -r -d '' PROBE_SCRIPT <<'PRB' || true
name="$1"; ip="$2"
pid="$(docker inspect -f '{{.State.Pid}}' "$name" 2>/dev/null)"
case "$pid" in ''|0|*[!0-9]*) echo "PROBE_UNAVAILABLE:no-pid-for-container"; exit 0 ;; esac
command -v nsenter >/dev/null 2>&1 || { echo "PROBE_UNAVAILABLE:nsenter-missing"; exit 0; }
command -v ping >/dev/null 2>&1 || { echo "PROBE_UNAVAILABLE:ping-missing"; exit 0; }
timeout 25 nsenter -t "$pid" -n ping -c 3 -W 2 "$ip" >/dev/null 2>&1
rc=$?
case "$rc" in 0) echo "PROBE_OK" ;; 1) echo "PROBE_FAIL" ;; *) echo "PROBE_UNAVAILABLE:ping-exit-${rc}" ;; esac
PRB

SELF_ADDR="$(docker info --format '{{.Swarm.NodeAddr}}' 2>/dev/null || true)"

# ---------------------------------------------------------------------------------------------
# #220 repair engine (main flow only — exercised end to end by test-auto-repair.sh)
# ---------------------------------------------------------------------------------------------
INCOMPLETE_NODES=""
BT=$'\x60'

# Run a command ON a swarm node (locally when it is this manager); stdin passes through. Callers with no
# stdin payload MUST add </dev/null — ssh would otherwise swallow the caller's own loop input.
run_on() {  # <node-addr> <command string>
  local addr="$1"; shift
  if [ "$addr" = "$SELF_ADDR" ]; then timeout "$REMOTE_TIMEOUT" bash -c "$*"
  else timeout "$REMOTE_TIMEOUT" ssh $SSH_OPTS "root@${addr}" "$*"; fi
}
slack_post() { printf '%s' "$1" | jq -Rs '{text:.}' | curl -fsS -m 15 -X POST -H 'Content-Type: application/json' -d @- "$SLACK_WEBHOOK" >/dev/null 2>&1; }
kv() { printf '%s' "$1" | tr ' ' '\n' | sed -n "s/^$2=//p" | head -1; }   # field of a "k=v k=v ..." finding line

probe() {  # <node-addr> <container> <target-ip>  ->  PROBE_OK | PROBE_FAIL | PROBE_UNAVAILABLE:<why>
  local r
  r="$(printf '%s' "$PROBE_SCRIPT" | run_on "$1" bash -s -- "$2" "$3" 2>/dev/null | tail -1)" || r=""
  case "$r" in PROBE_OK|PROBE_FAIL|PROBE_UNAVAILABLE:*) echo "$r" ;; *) echo "PROBE_UNAVAILABLE:no-answer-from-node" ;; esac
}
# OPEN = the MAC still has no `dst` line in that node's overlay netns; HEALED = it has one now; UNKNOWN = cannot tell.
gap_state() {  # <gap-node-addr> <ns> <mac>
  local out macs
  if ! out="$(run_on "$1" "nsenter --net=${NETNS_DIR}/$2 bridge fdb show dev vxlan0" </dev/null 2>/dev/null)"; then echo UNKNOWN; return; fi
  macs="$(printf '%s\n' "$out" | awk '/dst/{print tolower($1)}')"
  if grep -qx "$3" <<<"$macs"; then echo HEALED; else echo OPEN; fi
}
# Rebuild the owner maps from scratch — a FRESH `docker network inspect` on EVERY node — right before a write.
# Non-zero (and INCOMPLETE_NODES filled) when any node did not answer: an unseen node could hold the
# conflicting claim, so ownership is then unprovable.
collect_owners() {
  ip2nodes=(); mac2nodes=(); ip2name=(); node_containers=(); INCOMPLETE_NODES=""
  local host addr out l ok
  while read -r host <&4; do
    [ -z "$host" ] && continue
    addr="$(docker node inspect "$host" --format '{{.Status.Addr}}' 2>/dev/null)"
    if [ -z "$addr" ]; then INCOMPLETE_NODES+=" ${host}(no-addr)"; continue; fi
    out="$(printf '%s' "$OWNER_CHECK" | run_on "$addr" bash -s 2>/dev/null)" || out=""
    ok=0
    while IFS= read -r l; do
      case "$l" in
        "LOCAL_CONTAINER "*) ingest_local_line "$l" "$addr" ;;
        "NODE_OK") ok=1 ;;
      esac
    done < <(printf '%s\n' "$out")
    [ "$ok" = 1 ] || INCOMPLETE_NODES+=" ${host}(${addr})"
  done 4< <(docker node ls --format '{{.Hostname}}' 2>/dev/null)
  [ -z "$INCOMPLETE_NODES" ]
}
# Slack body for an executed repair. Reads the enclosing repair_gap's locals (dynamic scope) on purpose.
repair_msg() {  # <headline> <AFTER result text> <closing line(s)>
  local nl=$'\n'
  printf '%s' "${1}${nl}• Gap: node ${gapname} (${gaphost}), overlay netns ${ns}: MAC ${mac} / IP ${ip} (container ${ip2name[$ip]:-unknown}) had a neighbour entry but NO VXLAN ${BT}dst${BT}, so connections to it black-hole.${nl}• Owner: ${owner} — the ONLY node reporting both that IP and that MAC as local (re-resolved from scratch immediately before the write).${nl}• BEFORE (real caller container ${caller} on ${gaphost}, not the gateway netns): ping ${ip} FAILED.${nl}• DID: ${BT}${apply}${BT} on ${gaphost}.${nl}• AFTER (same caller): ${2}${nl}${3}${nl}• Auto-repairs in the last hour: $(ledger_count_last_hour "$NOW")/${MAX_REPAIRS_PER_HOUR}; beyond that this detector only alerts."
}

# repair_gap <finding line> -> sets RG_STATE (repaired | healed | dry-run | alert-only | unverified) and
# RG_NOTE (one line for the alert). Never aborts the run: every refusal is an alert-only note.
repair_gap() {
  local line="$1" ip mac ns gaphost gapname res res2 owner cnt key cands c caller before after apply undo st msg
  RG_STATE="alert-only"; RG_NOTE=""
  ip="$(kv "$line" ip)"; mac="$(kv "$line" mac | tr 'A-F' 'a-f')"; ns="$(kv "$line" ns)"
  gaphost="$(kv "$line" host)"; gapname="$(kv "$line" node)"
  if ! { is_ipv4 "$ip" && is_mac "$mac" && is_ns "$ns" && is_ipv4 "$gaphost"; }; then
    RG_NOTE="AUTO-REPAIR: alert-only — malformed gap record (not acting on unvalidated values)"; return
  fi
  key="${mac}@${gaphost}"
  if [ -n "$INCOMPLETE_NODES" ]; then
    RG_NOTE="AUTO-REPAIR: alert-only — cluster view incomplete (no answer from:${INCOMPLETE_NODES}); ownership cannot be proven"; return
  fi
  res="$(resolve_owner "$ip" "$mac" "$gaphost")"
  case "$res" in
    OK\ *) owner="${res#OK }" ;;
    UNRESOLVED) RG_NOTE="AUTO-REPAIR: alert-only — owner UNRESOLVED (no node reports this IP/MAC as local; the container may be stopped or rescheduled)"; return ;;
    *) RG_NOTE="AUTO-REPAIR: alert-only — ${res}"; return ;;
  esac
  cnt="$(ledger_count_last_hour "$NOW")"
  if [ "$cnt" -ge "$MAX_REPAIRS_PER_HOUR" ]; then
    RG_NOTE="AUTO-REPAIR: alert-only — hourly cap reached (${cnt}/${MAX_REPAIRS_PER_HOUR} auto-repairs in the last hour)"; return
  fi
  if ledger_blocked "$key" "$NOW"; then
    RG_NOTE="AUTO-REPAIR: alert-only — an automatic repair of this gap failed verification (or could not be applied/undone) within the last ${REPAIR_BLOCK_HOURS}h; needs a human"; return
  fi
  # BEFORE: from a REAL caller container on the gap node. The break must be real, from a real caller.
  cands="$(printf '%s' "${node_containers[$gaphost]:-}" | awk 'NF && $1 !~ /-endpoint$/ && $1 !~ /^lb-/ {print $1}' | sort | head -3)"
  if [ -z "$cands" ]; then RG_NOTE="AUTO-REPAIR: alert-only — no real caller container on ${gaphost} to test from"; return; fi
  caller=""; before=""
  for c in $cands; do
    is_cname "$c" || continue
    before="$(probe "$gaphost" "$c" "$ip")"
    case "$before" in PROBE_OK|PROBE_FAIL) caller="$c"; break ;; esac
  done
  case "$before" in
    PROBE_FAIL) ;;
    PROBE_OK) RG_NOTE="AUTO-REPAIR: alert-only — ${ip} is REACHABLE from real caller ${caller} despite the missing entry; not touching a path that works"; return ;;
    *) RG_NOTE="AUTO-REPAIR: alert-only — cannot test from a real caller container (${before:-no result}); will not change what cannot be verified"; return ;;
  esac
  apply="nsenter --net=${NETNS_DIR}/${ns} bridge fdb replace ${mac} dev vxlan0 dst ${owner} self permanent"
  undo="nsenter --net=${NETNS_DIR}/${ns} bridge fdb del ${mac} dev vxlan0 dst ${owner} self permanent"
  if [ "$REPAIR_MODE" != "armed" ]; then
    RG_STATE="dry-run"
    RG_NOTE="AUTO-REPAIR DRY-RUN (nothing changed): would run on ${gaphost}: ${BT}${apply}${BT} — owner ${owner} resolved unambiguously and ${ip} is unreachable from real caller ${caller}. Undo would be: ${BT}ssh root@${gaphost} \"${undo}\"${BT}. Arm with AUTO_REPAIR_ENABLED=true."
    return
  fi
  # ARMED: re-resolve from scratch and re-confirm the gap IMMEDIATELY before the write.
  if ! collect_owners; then RG_NOTE="AUTO-REPAIR: alert-only — fresh re-resolution incomplete (no answer from:${INCOMPLETE_NODES}); not writing"; return; fi
  res2="$(resolve_owner "$ip" "$mac" "$gaphost")"
  if [ "$res2" != "OK ${owner}" ]; then RG_NOTE="AUTO-REPAIR: alert-only — the owner changed or became ambiguous on re-resolution (${res2}); not writing"; return; fi
  st="$(gap_state "$gaphost" "$ns" "$mac")"
  case "$st" in
    HEALED) RG_STATE="healed"; RG_NOTE="gap healed on its own before the write"; return ;;
    OPEN) ;;
    *) RG_NOTE="AUTO-REPAIR: alert-only — could not re-confirm the gap on ${gaphost}; not writing"; return ;;
  esac
  # Fail CLOSED: no ledger record => no mutation (the cap is only as good as its ledger).
  if ! ledger_add "$NOW" "$key" "$owner" attempt; then
    RG_NOTE="AUTO-REPAIR: alert-only — cannot write the repair ledger under ${STATE_DIR}; refusing to change anything without a record"; return
  fi
  if ! run_on "$gaphost" "$apply" </dev/null >/dev/null 2>&1; then
    ledger_add "$NOW" "$key" "$owner" apply-failed
    RG_NOTE="AUTO-REPAIR: alert-only — the bridge fdb replace on ${gaphost} FAILED to apply; nothing verified, no auto-retry for ${REPAIR_BLOCK_HOURS}h"
    slack_post ":warning: *Overlay FDB auto-repair could not APPLY* on ${gapname} (${gaphost}): ${BT}${apply}${BT} failed. Nothing was changed as far as known; needs a human. Gap: MAC ${mac} / IP ${ip}." || log "WARNING: Slack POST (apply failure) failed"
    return
  fi
  after="$(probe "$gaphost" "$caller" "$ip")"
  if [ "$after" = "PROBE_OK" ]; then
    ledger_add "$NOW" "$key" "$owner" verified
    RG_STATE="repaired"; RG_NOTE="auto-repaired and verified from ${caller}"
    msg="$(repair_msg ":wrench: *Overlay FDB auto-repair APPLIED*" "ping ${ip} OK." "• UNDO: ${BT}ssh root@${gaphost} \"${undo}\"${BT}")"
    slack_post "$msg" || { log "WARNING: Slack POST (repair announcement) failed — the repair HAPPENED; body follows"; printf '%s\n' "$msg"; }
    return
  fi
  # Did not verify: put the node back exactly as it was (the gap had NO dst entry, so deleting ours restores it).
  RG_STATE="unverified"
  if run_on "$gaphost" "$undo" </dev/null >/dev/null 2>&1; then
    ledger_add "$NOW" "$key" "$owner" unverified-reverted
    RG_NOTE="AUTO-REPAIR: the repair did NOT verify from ${caller} (${after}) and was REVERTED; no auto-retry for ${REPAIR_BLOCK_HOURS}h; needs a human"
    msg="$(repair_msg ":warning: *Overlay FDB auto-repair did NOT verify — REVERTED*" "${after} — the entry was REMOVED again (node is back to its pre-repair state)." "• Needs a human: the owner mapping looked unambiguous but traffic still does not flow. Not retried for ${REPAIR_BLOCK_HOURS}h.")"
  else
    ledger_add "$NOW" "$key" "$owner" revert-failed
    RG_NOTE="AUTO-REPAIR: the repair did NOT verify from ${caller} (${after}) and the REVERT FAILED — the new entry is STILL in place; undo it by hand"
    msg="$(repair_msg ":rotating_light: *Overlay FDB auto-repair did NOT verify and the REVERT FAILED*" "${after} — the entry is STILL IN PLACE." "• UNDO NOW: ${BT}ssh root@${gaphost} \"${undo}\"${BT}")"
  fi
  slack_post "$msg" || { log "WARNING: Slack POST (repair failure) failed; body follows"; printf '%s\n' "$msg"; }
}

findings=""
while read -r host; do
  [ -z "$host" ] && continue
  addr="$(docker node inspect "$host" --format '{{.Status.Addr}}' 2>/dev/null)"
  [ -z "$addr" ] && { log "WARN: no addr for node $host, skipping"; continue; }
  if [ "$addr" = "$SELF_ADDR" ]; then
    out="$(printf '%s' "$NODE_CHECK" | bash -s "$PREFIX" "$NETNS_DIR" 2>/dev/null)"
  else
    out="$(printf '%s' "$NODE_CHECK" | ssh $SSH_OPTS "root@${addr}" bash -s "$PREFIX" "$NETNS_DIR" 2>/dev/null)"
    [ -z "$out" ] && ssh $SSH_OPTS "root@${addr}" true </dev/null 2>/dev/null || true
  fi
  # Split the line kinds. LOCAL_CONTAINER lines from THIS node => the container's overlay IP/MAC are
  # owned by THIS node (addr), so that addr is the correct dst. NODE_OK = the node ran the whole script.
  node_ok=0
  while IFS= read -r l; do
    case "$l" in
      "LOCAL_CONTAINER "*) ingest_local_line "$l" "$addr" ;;
      "MISSING_VTEP "*)
        findings+="node=${host} host=${addr} ${l}"$'\n' ;;
      "NODE_OK") node_ok=1 ;;
      "NODE_ERR "*) log "WARN: node ${host} (${addr}) reported: ${l}" ;;
    esac
  done < <(printf '%s\n' "$out")
  if [ "$node_ok" != 1 ]; then
    INCOMPLETE_NODES+=" ${host}(${addr})"
    log "WARN: node ${host} (${addr}) did not complete the survey — the cluster view is INCOMPLETE (auto-repair is off for this run)"
  fi
done < <(docker node ls --format '{{.Hostname}}' 2>/dev/null)

findings="$(printf '%s' "$findings" | sed '/^[[:space:]]*$/d')"

if [ -z "$findings" ]; then
  log "nominal — no missing VTEP entries on the app overlay (prefix ${PREFIX}) across the fleet. (resolver saw ${#ip2nodes[@]} local container IPs)"
  # A previously alerted gap set has cleared: say so once, then reset (a recurrence alerts at once).
  if [ -f "$FP_FILE" ] && [ "$TEST_ALERT" != "true" ]; then
    RESOLVED=":white_check_mark: *Overlay FDB-gap detector* — the previously reported VTEP gap(s) are RESOLVED: no missing entries on the app overlay across the fleet."
    if [ -n "$SLACK_WEBHOOK" ]; then
      printf '%s' "$RESOLVED" | jq -Rs '{text:.}' | curl -fsS -X POST -H 'Content-Type: application/json' -d @- "$SLACK_WEBHOOK" >/dev/null 2>&1 \
        && { log "Slack resolved notice sent."; clear_alert_state; } \
        || log "WARNING: Slack POST (resolved) failed (non-fatal; will retry next run)."
    else
      clear_alert_state
    fi
  fi
  if [ "$TEST_ALERT" = "true" ]; then
    MSG=":white_check_mark: *Overlay FDB-gap detector* test run — no gaps, path OK (app prefix ${PREFIX}, ${#ip2nodes[@]} container IPs resolvable, auto-repair mode: ${REPAIR_MODE}, TEST_ALERT=true)."
    if [ -n "$SLACK_WEBHOOK" ]; then
      printf '%s' "$MSG" | jq -Rs '{text:.}' | curl -fsS -X POST -H 'Content-Type: application/json' -d @- "$SLACK_WEBHOOK" >/dev/null 2>&1 \
        && log "Slack test alert sent." || log "WARNING: Slack POST failed (non-fatal)."
    else
      log "SLACK_WEBHOOK unset — test message logged only: $MSG"
    fi
  fi
  exit 0
fi

log "MISSING VTEP ENTRIES DETECTED:"
printf '%s\n' "$findings"

# #220 repair pass. Every gap goes through the guards in repair_gap; what is repaired + verified (or healed
# on its own) drops out of the alert, everything else stays with the reason it was NOT repaired. The loop
# reads on fd 3 so nothing it runs (ssh, docker) can swallow the remaining findings from stdin.
NOW="$(now_epoch)"
declare -A gap_note
remaining=""
while IFS= read -r line <&3; do
  [ -z "$line" ] && continue
  repair_gap "$line"
  # Every decision is journaled each run (the Slack alert is deduped, the reason must not be).
  [ -n "$RG_NOTE" ] && log "$(kv "$line" mac)@$(kv "$line" host) [${RG_STATE}]: ${RG_NOTE}"
  case "$RG_STATE" in
    repaired|healed) log "gap resolved this run (${RG_STATE}): ${line}" ;;
    *) remaining+="${line}"$'\n'; gap_note["$line"]="$RG_NOTE" ;;
  esac
done 3< <(printf '%s\n' "$findings")
findings="$(printf '%s' "$remaining" | sed '/^[[:space:]]*$/d')"
if [ -z "$findings" ]; then
  log "every detected gap was repaired + verified (or healed on its own) this run — nothing left to alert on."
  exit 0
fi

# Build the per-gap repair detail with a RESOLVED dst + a ready-to-paste command.
detail=""
unresolved=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  ip="$(printf '%s' "$line" | grep -oE 'ip=[0-9.]+' | cut -d= -f2)"
  mac="$(printf '%s' "$line" | grep -oE 'mac=[0-9a-fA-F:]+' | cut -d= -f2)"
  ns="$(printf '%s' "$line" | grep -oE 'ns=[^ ]+' | cut -d= -f2)"
  gaphost="$(printf '%s' "$line" | grep -oE 'host=[0-9.]+' | cut -d= -f2)"
  nm="${ip2name[$ip]:-unknown}"
  res="$(resolve_owner "$ip" "$(printf '%s' "$mac" | tr 'A-F' 'a-f')" "$gaphost")"
  case "$res" in
    OK\ *)
      dst="${res#OK }"
      cmd="ssh root@${gaphost} \"nsenter --net=${NETNS_DIR}/${ns} bridge fdb replace ${mac} dev vxlan0 dst ${dst} self permanent\""
      detail+="• ${line} (container: ${nm}, owner-node: ${dst})"$'\n'"    FIX (review, then paste on the manager): ${cmd}"$'\n' ;;
    *)
      unresolved=$((unresolved + 1))
      why="$res"
      [ "$res" = "UNRESOLVED" ] && why="UNRESOLVED — no node reports this overlay IP as local; the container may be stopped/rescheduled, so verify it still runs before repairing"
      cmd="ssh root@${gaphost} \"nsenter --net=${NETNS_DIR}/${ns} bridge fdb replace ${mac} dev vxlan0 dst <peer-host-ip> self permanent\""
      detail+="• ${line} (container: ${nm}, owner-node: ${why})"$'\n'"    FIX: ${cmd}"$'\n' ;;
  esac
  [ -n "${gap_note[$line]:-}" ] && detail+="    ${gap_note[$line]}"$'\n'
done < <(printf '%s\n' "$findings")

now="$NOW"
fp="$(gap_fingerprint "$findings")"
decision="$(alert_decision "$fp" "$now")"
if [ "$TEST_ALERT" != "true" ] && [ "$decision" = "suppress" ]; then
  log "breach UNCHANGED since the last alert (set ${fp}) — next reminder after ${REMIND_HOURS}h; not re-paging."
  exit 0
fi

if [ "$decision" = "remind" ]; then
  first="$(cat "$FIRST_FILE" 2>/dev/null || echo "$now")"
  HEAD=":rotating_light: *Overlay FDB-gap detector* — REMINDER: the same gap(s) are STILL OPEN (unchanged since $(date -u -d "@${first}" '+%Y-%m-%d %H:%MZ' 2>/dev/null || echo "?"); reminders every ${REMIND_HOURS}h until the set changes or clears)."
else
  HEAD=":rotating_light: *Overlay FDB-gap detector* — NEW/CHANGED gap set:"
fi
MSG="${HEAD}
Missing VXLAN VTEP entries on the app overlay (cross-node partition; the 2026-09-03 outage signature). The listed node cannot reach these container overlay IPs until the \`dst\` entry is restored. Each gap has a RESOLVED, ready-to-paste repair command (dst = the node that owns the target container). Review each, then paste on the manager (it SSHes to the affected node). ${MODE_NOTE}
${detail}
\`bridge fdb replace\` is idempotent (creates-or-updates). After repairing, verify from the REAL caller container (not the netns gateway). Runbook: memory \`reference_overlay_users_service_partition.md\`."
[ "$unresolved" -gt 0 ] && MSG="${MSG}
:warning: ${unresolved} gap(s) had an UNRESOLVED or AMBIGUOUS owner (not exactly one node reports that overlay IP+MAC as local) — see the note; do not blind-fill."
[ -n "$INCOMPLETE_NODES" ] && MSG="${MSG}
:warning: no answer from node(s):${INCOMPLETE_NODES} — this survey is INCOMPLETE and auto-repair was off for the run."

if [ -n "$SLACK_WEBHOOK" ]; then
  printf '%s' "$MSG" | jq -Rs '{text:.}' | curl -fsS -X POST -H 'Content-Type: application/json' -d @- "$SLACK_WEBHOOK" >/dev/null 2>&1 \
    && { log "Slack alert sent (${decision}, set ${fp})."; record_alert "$fp" "$now" "$decision"; } \
    || log "WARNING: Slack POST failed (non-fatal)."
else
  log "SLACK_WEBHOOK unset — alert logged only. Alert body:"
  printf '%s\n' "$MSG"
fi
exit 0
