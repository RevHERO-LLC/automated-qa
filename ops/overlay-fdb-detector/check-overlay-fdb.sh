#!/usr/bin/env bash
# check-overlay-fdb.sh — LOG-ONLY Docker Swarm overlay VTEP/FDB-gap detector.
#
# On EVERY swarm node, for each overlay netns, find MACs that have a PERMANENT
# ARP/neigh entry but NO `bridge fdb ... dst` (VTEP) line. That exact asymmetry
# is the signature of the cross-node partition that silently killed all outbound
# email for ~6 days (2026-08-31 and 2026-09-03): the node knows the peer MAC but
# has nowhere to tunnel its frames, so every connection to that container
# black-holes until `bridge fdb add <mac> dev vxlan0 dst <peer-host-ip> self
# permanent` is re-added.
#
# This DETECTS + alerts Slack ONLY. It performs NO mutation (no `bridge fdb add`)
# — auto-repair across every node's root netns on a timer is deliberately NOT
# done here (too high a blast radius without a proven MAC->node map). A human
# (or a future, separately-reviewed auto-repair) acts on the alert.
#
# Runs on the Swarm manager (VPS2); reaches the worker nodes over SSH (root key
# already trusted node->node). Read-only everywhere.
#
# Env:
#   SLACK_WEBHOOK   Slack incoming-webhook URL. Unset => log-only (never fatal).
#   STATE_DIR       debounce marker dir (default /var/lib/overlay-fdb-detector).
#   DEBOUNCE_HOURS  min hours between repeat alerts (default 2).
#   TEST_ALERT      "true" => post one Slack message regardless, to validate path.

set -uo pipefail
SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"
STATE_DIR="${STATE_DIR:-/var/lib/overlay-fdb-detector}"
MARKER="${STATE_DIR}/last-alert"
DEBOUNCE_HOURS="${DEBOUNCE_HOURS:-2}"
TEST_ALERT="${TEST_ALERT:-false}"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=no"

log() { echo "[overlay-fdb $(date -u +%H:%M:%SZ)] $*"; }

# Per-node check, fed to bash via stdin (local or over ssh). Single-quoted
# heredoc => no expansion here; awk field refs stay literal on the far side.
# Emits one line per gap: "MISSING_VTEP ns=<id> mac=<mac> ip=<overlay-ip>".
read -r -d '' NODE_CHECK <<'CHK' || true
for ns in /var/run/docker/netns/*; do
  nsenter --net="$ns" ip -d link show vxlan0 >/dev/null 2>&1 || continue
  neigh=$(nsenter --net="$ns" ip neigh show dev vxlan0 2>/dev/null | awk '/PERMANENT/{print tolower($3)}' | sort -u)
  fdb=$(nsenter --net="$ns" bridge fdb show dev vxlan0 2>/dev/null | awk '/dst/{print tolower($1)}' | sort -u)
  while read -r mac; do
    [ -z "$mac" ] && continue
    ip=$(nsenter --net="$ns" ip neigh show dev vxlan0 2>/dev/null | awk -v M="$mac" 'tolower($3)==M{print $1; exit}')
    echo "MISSING_VTEP ns=$(basename "$ns") mac=$mac ip=${ip:-?}"
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
    out="$(printf '%s' "$NODE_CHECK" | bash 2>/dev/null)"
  else
    out="$(printf '%s' "$NODE_CHECK" | ssh $SSH_OPTS "root@${addr}" 'bash -s' 2>/dev/null)"
    if [ $? -ne 0 ] && [ -z "$out" ]; then log "WARN: could not reach node $host ($addr) over SSH"; fi
  fi
  [ -n "$out" ] && findings+="$(printf '%s\n' "$out" | sed "s/^/node=${host} host=${addr} /")"$'\n'
done < <(docker node ls --format '{{.Hostname}}' 2>/dev/null)

findings="$(printf '%s' "$findings" | sed '/^[[:space:]]*$/d')"

if [ -z "$findings" ]; then
  log "nominal — no missing VTEP entries across the fleet."
  if [ "$TEST_ALERT" = "true" ]; then
    MSG=":white_check_mark: *Overlay FDB-gap detector* test run — no gaps, path OK. (TEST_ALERT=true)"
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

# Map overlay IP -> container name for a readable alert (manager has the roster).
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

# Debounce (skip a repeat within DEBOUNCE_HOURS unless TEST_ALERT).
now="$(date +%s)"
if [ "$TEST_ALERT" != "true" ] && [ -f "$MARKER" ]; then
  last="$(cat "$MARKER" 2>/dev/null || echo 0)"
  if [ $(( now - last )) -lt $(( ${DEBOUNCE_HOURS%.*} * 3600 )) ]; then
    log "breach but debounced (alerted within ${DEBOUNCE_HOURS}h) — not re-paging."
    exit 0
  fi
fi

MSG=":rotating_light: *Overlay FDB-gap detector* — missing VXLAN VTEP entries (cross-node partition risk; the 2026-09-03 outage signature). The listed node cannot reach these container overlay IPs until the \`dst\` entry is restored:
${detail}
Fix (per gap): on the listed node's overlay netns, \`bridge fdb add <mac> dev vxlan0 dst <peer-host-ip> self permanent\`. Runbook: memory \`reference_overlay_users_service_partition.md\`."

if [ -n "$SLACK_WEBHOOK" ]; then
  printf '%s' "$MSG" | jq -Rs '{text:.}' | curl -fsS -X POST -H 'Content-Type: application/json' -d @- "$SLACK_WEBHOOK" >/dev/null 2>&1 \
    && { log "Slack alert sent."; mkdir -p "$STATE_DIR"; echo "$now" > "$MARKER"; } \
    || log "WARNING: Slack POST failed (non-fatal)."
else
  log "SLACK_WEBHOOK unset — alert logged only."
fi
exit 0
