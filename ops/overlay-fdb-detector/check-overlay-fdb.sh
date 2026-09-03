#!/usr/bin/env bash
# check-overlay-fdb.sh — LOG-ONLY Docker Swarm overlay VTEP/FDB-gap detector.
#
# On EVERY swarm node, for the APP overlay (dokploy-network) netns, find MACs that
# have a PERMANENT ARP/neigh entry but NO `bridge fdb ... dst` (VTEP) line. That
# asymmetry is the signature of the cross-node partition that silently killed all
# outbound email for ~6 days (2026-08-31 and 2026-09-03): the node knows the peer
# MAC but has nowhere to tunnel its frames, so every connection to that container
# black-holes until `bridge fdb add <mac> dev vxlan0 dst <peer-host-ip> self
# permanent` is re-added.
#
# SCOPING: only the app overlay is checked (subnet derived from dokploy-network,
# default 10.0.1.). The Swarm ingress network (10.0.0.0/24) is intentionally
# EXCLUDED — a neigh-without-dst is normal there (node endpoints without ingress
# tasks) and would false-positive constantly.
#
# This DETECTS + alerts Slack ONLY — NO mutation (no `bridge fdb add`). Auto-repair
# across every node's root netns on a timer is deliberately out of scope (a wrong
# MAC->node mapping would silently send traffic to the wrong host — worse than the
# gap). A human (or a future, separately-reviewed tool) acts on the alert.
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
# Only inspects the netns whose neigh table carries the app subnet, and only emits
# gaps for app-subnet IPs. Line: "MISSING_VTEP ns=<id> mac=<mac> ip=<overlay-ip>".
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
CHK

SELF_ADDR="$(docker info --format '{{.Swarm.NodeAddr}}' 2>/dev/null || true)"

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
  [ -n "$out" ] && findings+="$(printf '%s\n' "$out" | sed "s/^/node=${host} host=${addr} /")"$'\n'
done < <(docker node ls --format '{{.Hostname}}' 2>/dev/null)

findings="$(printf '%s' "$findings" | sed '/^[[:space:]]*$/d')"

if [ -z "$findings" ]; then
  log "nominal — no missing VTEP entries on the app overlay (prefix ${PREFIX}) across the fleet."
  if [ "$TEST_ALERT" = "true" ]; then
    MSG=":white_check_mark: *Overlay FDB-gap detector* test run — no gaps, path OK (app prefix ${PREFIX}, TEST_ALERT=true)."
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

declare -A ip2name
while IFS='|' read -r cname cip _cmac; do
  [ -z "$cip" ] && continue
  ip2name["${cip%%/*}"]="$cname"
done < <(docker network inspect dokploy-network -f '{{range .Containers}}{{.Name}}|{{.IPv4Address}}|{{.MacAddress}}{{println}}{{end}}' 2>/dev/null)

detail=""
while read -r line; do
  [ -z "$line" ] && continue
  ip="$(echo "$line" | grep -oE 'ip=[0-9.]+' | cut -d= -f2)"
  nm="${ip2name[$ip]:-unknown}"
  detail+="• ${line}  (container: ${nm})"$'\n'
done < <(printf '%s\n' "$findings")

now="$(date +%s)"
if [ "$TEST_ALERT" != "true" ] && [ -f "$MARKER" ]; then
  last="$(cat "$MARKER" 2>/dev/null || echo 0)"
  if [ $(( now - last )) -lt $(( ${DEBOUNCE_HOURS%.*} * 3600 )) ]; then
    log "breach but debounced (alerted within ${DEBOUNCE_HOURS}h) — not re-paging."
    exit 0
  fi
fi

MSG=":rotating_light: *Overlay FDB-gap detector* — missing VXLAN VTEP entries on the app overlay (cross-node partition risk; the 2026-09-03 outage signature). The listed node cannot reach these container overlay IPs until the \`dst\` entry is restored:
${detail}
Fix (per gap): on the listed node's overlay netns, \`bridge fdb add <mac> dev vxlan0 dst <peer-host-ip> self permanent\` (peer-host-ip = the host running that container). Verify from the real caller container, not the netns gateway. Runbook: memory \`reference_overlay_users_service_partition.md\`."

if [ -n "$SLACK_WEBHOOK" ]; then
  printf '%s' "$MSG" | jq -Rs '{text:.}' | curl -fsS -X POST -H 'Content-Type: application/json' -d @- "$SLACK_WEBHOOK" >/dev/null 2>&1 \
    && { log "Slack alert sent."; mkdir -p "$STATE_DIR"; echo "$now" > "$MARKER"; } \
    || log "WARNING: Slack POST failed (non-fatal)."
else
  log "SLACK_WEBHOOK unset — alert logged only."
fi
exit 0
