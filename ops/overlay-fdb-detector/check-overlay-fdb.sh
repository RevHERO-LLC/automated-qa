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
# This DETECTS + alerts Slack ONLY — it performs NO mutation (no `bridge fdb`
# write). #939 upgrade (2026-09-24): it now RESOLVES each gap's overlay-IP to the
# node that OWNS the target container (the correct VXLAN `dst`) and puts a
# READY-TO-PASTE `bridge fdb replace ... dst <resolved-ip> ...` repair command in
# the alert — so the human no longer has to hand-derive the peer-host-ip. It is
# still NOT auto-applied on a timer: a wrong MAC->node mapping would silently send
# traffic to the wrong host (worse than the gap), so a human reviews the resolved
# command and pastes it. (Auto-apply is deliberately a separate, later-reviewed
# decision.) The `dst` is resolved from each node's OWN local-container view (a
# container runs on exactly one node), which is authoritative.
#
# Runs on the Swarm manager (VPS2); reaches worker nodes over SSH (root key already
# trusted node->node). Read-only everywhere.
#
# Env: SLACK_WEBHOOK (unset => log-only), STATE_DIR (default /var/lib/overlay-fdb-detector),
#      DEBOUNCE_HOURS (default 2), TEST_ALERT ("true" => post one Slack msg to validate path),
#      APP_SUBNET_PREFIX (override the auto-derived app subnet prefix, e.g. "10.0.1.").

set -uo pipefail
SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"
STATE_DIR="${STATE_DIR:-/var/lib/overlay-fdb-detector}"
MARKER="${STATE_DIR}/last-alert"
DEBOUNCE_HOURS="${DEBOUNCE_HOURS:-2}"
TEST_ALERT="${TEST_ALERT:-false}"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=no"

log() { echo "[overlay-fdb $(date -u +%H:%M:%SZ)] $*"; }

# App overlay subnet prefix (e.g. 10.0.1.) — auto-derived from dokploy-network so a
# renumber doesn't silently disable the check; overridable via env.
PREFIX="${APP_SUBNET_PREFIX:-}"
if [ -z "$PREFIX" ]; then
  PREFIX="$(docker network inspect dokploy-network -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null \
            | sed -nE 's#^([0-9]+\.[0-9]+\.[0-9]+)\..*#\1.#p')"
fi
[ -z "$PREFIX" ] && PREFIX="10.0.1."

# Per-node check, fed to bash via stdin (local or over ssh); $1 = app subnet prefix.
# Single-quoted heredoc => no expansion here; awk field refs stay literal remotely.
# Emits two line kinds (host context; it does its own nsenter for the netns part):
#   "MISSING_VTEP ns=<id> mac=<mac> ip=<overlay-ip>"   — a VTEP gap in a netns
#   "LOCAL_CONTAINER ip=<overlay-ip> name=<container>" — a container LOCAL to THIS
#       node (so the manager can map any gap's overlay-IP -> this node = the dst).
read -r -d '' NODE_CHECK <<'CHK' || true
P="${1:-10.0.1.}"
for ns in /var/run/docker/netns/*; do
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
# This node's local dokploy-network containers -> lets the manager resolve the
# owning node (correct VXLAN dst) for any gap's overlay-IP. A container is local
# to exactly one node, so whichever node reports it here owns it.
docker network inspect dokploy-network -f '{{range .Containers}}LOCAL_CONTAINER ip={{.IPv4Address}} name={{.Name}}{{println}}{{end}}' 2>/dev/null || true
CHK

SELF_ADDR="$(docker info --format '{{.Swarm.NodeAddr}}' 2>/dev/null || true)"

declare -A ip2node ip2name
findings=""
while read -r host; do
  [ -z "$host" ] && continue
  addr="$(docker node inspect "$host" --format '{{.Status.Addr}}' 2>/dev/null)"
  [ -z "$addr" ] && { log "WARN: no addr for node $host, skipping"; continue; }
  if [ "$addr" = "$SELF_ADDR" ]; then
    out="$(printf '%s' "$NODE_CHECK" | bash -s "$PREFIX" 2>/dev/null)"
  else
    out="$(printf '%s' "$NODE_CHECK" | ssh $SSH_OPTS "root@${addr}" bash -s "$PREFIX" 2>/dev/null)"
    [ -z "$out" ] && ssh $SSH_OPTS "root@${addr}" true 2>/dev/null || true
  fi
  # Split the two line kinds. LOCAL_CONTAINER lines from THIS node => the container's
  # overlay IP is owned by THIS node (addr), so that addr is the correct dst.
  while IFS= read -r l; do
    case "$l" in
      "LOCAL_CONTAINER "*)
        cip="$(printf '%s' "$l" | grep -oE 'ip=[0-9.]+' | cut -d= -f2)"
        cnm="$(printf '%s' "$l" | sed -nE 's/.* name=(.*)$/\1/p')"
        [ -n "$cip" ] && { ip2node["$cip"]="$addr"; ip2name["$cip"]="${cnm:-unknown}"; } ;;
      "MISSING_VTEP "*)
        findings+="node=${host} host=${addr} ${l}"$'\n' ;;
    esac
  done < <(printf '%s\n' "$out")
done < <(docker node ls --format '{{.Hostname}}' 2>/dev/null)

findings="$(printf '%s' "$findings" | sed '/^[[:space:]]*$/d')"

if [ -z "$findings" ]; then
  log "nominal — no missing VTEP entries on the app overlay (prefix ${PREFIX}) across the fleet. (resolver saw ${#ip2node[@]} local container IPs)"
  if [ "$TEST_ALERT" = "true" ]; then
    MSG=":white_check_mark: *Overlay FDB-gap detector* test run — no gaps, path OK (app prefix ${PREFIX}, ${#ip2node[@]} container IPs resolvable, TEST_ALERT=true)."
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
  dst="${ip2node[$ip]:-}"
  if [ -n "$dst" ]; then
    cmd="ssh root@${gaphost} \"nsenter --net=/var/run/docker/netns/${ns} bridge fdb replace ${mac} dev vxlan0 dst ${dst} self permanent\""
    detail+="• ${line} (container: ${nm}, owner-node: ${dst})"$'\n'"    FIX (review, then paste on the manager): ${cmd}"$'\n'
  else
    unresolved=$((unresolved + 1))
    cmd="ssh root@${gaphost} \"nsenter --net=/var/run/docker/netns/${ns} bridge fdb replace ${mac} dev vxlan0 dst <peer-host-ip> self permanent\""
    detail+="• ${line} (container: ${nm}, owner-node: UNRESOLVED — no node reports this overlay IP as local; the container may be stopped/rescheduled, so verify it still runs before repairing)"$'\n'"    FIX: ${cmd}"$'\n'
  fi
done < <(printf '%s\n' "$findings")

now="$(date +%s)"
if [ "$TEST_ALERT" != "true" ] && [ -f "$MARKER" ]; then
  last="$(cat "$MARKER" 2>/dev/null || echo 0)"
  if [ $(( now - last )) -lt $(( ${DEBOUNCE_HOURS%.*} * 3600 )) ]; then
    log "breach but debounced (alerted within ${DEBOUNCE_HOURS}h) — not re-paging."
    exit 0
  fi
fi

MSG=":rotating_light: *Overlay FDB-gap detector* — missing VXLAN VTEP entries on the app overlay (cross-node partition; the 2026-09-03 outage signature). The listed node cannot reach these container overlay IPs until the \`dst\` entry is restored. Each gap has a RESOLVED, ready-to-paste repair command (dst = the node that owns the target container). Review each, then paste on the manager (it SSHes to the affected node). This detector does NOT auto-apply.
${detail}
\`bridge fdb replace\` is idempotent (creates-or-updates). After repairing, verify from the REAL caller container (not the netns gateway). Runbook: memory \`reference_overlay_users_service_partition.md\`."
[ "$unresolved" -gt 0 ] && MSG="${MSG}
:warning: ${unresolved} gap(s) had an UNRESOLVED dst (overlay IP not local to any node) — see the note; do not blind-fill."

if [ -n "$SLACK_WEBHOOK" ]; then
  printf '%s' "$MSG" | jq -Rs '{text:.}' | curl -fsS -X POST -H 'Content-Type: application/json' -d @- "$SLACK_WEBHOOK" >/dev/null 2>&1 \
    && { log "Slack alert sent."; mkdir -p "$STATE_DIR"; echo "$now" > "$MARKER"; } \
    || log "WARNING: Slack POST failed (non-fatal)."
else
  log "SLACK_WEBHOOK unset — alert logged only. Alert body:"
  printf '%s\n' "$MSG"
fi
exit 0
