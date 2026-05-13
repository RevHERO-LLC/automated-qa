#!/usr/bin/env bash
# check-and-fix-overlay-routing.sh
# Detects stale Docker Swarm overlay IPVS routing (public URL via Traefik
# returns 504/timeout but container itself responds on dokploy-network) and
# heals it with: docker service update --force --detach=false <swarm-svc>
# Posts a Slack alert on each fix (debounced per-service to once per hour).
#
# Discovery: reads /etc/dokploy/traefik/dynamic/*.yml — each file is named
# after the swarm service and contains the public Host rule + internal URL.
#
# Requires: bash, curl, grep, sed, docker (all standard on VPS2)
# Env vars (from /etc/revhero/overlay-routing-healer.env):
#   SLACK_WEBHOOK  — Slack incoming webhook URL

set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────────────
TRAEFIK_DYNAMIC_DIR="/etc/dokploy/traefik/dynamic"
DEBOUNCE_DIR="/var/lib/overlay-routing-healer"
CURL_IMAGE="curlimages/curl:8.10.1"
PROBE_TIMEOUT=6       # seconds for public HTTPS probe
OVERLAY_TIMEOUT=8     # seconds for overlay probe (docker run has startup overhead)
CONVERGE_TIMEOUT=90   # seconds to wait for convergence after force-update
DEBOUNCE_SECS=3600    # 1 hour between Slack alerts per service

mkdir -p "${DEBOUNCE_DIR}"

log() {
  echo "[overlay-check $(date +%H:%M:%S)] $*"
}

if [[ ! -d "${TRAEFIK_DYNAMIC_DIR}" ]]; then
  log "ERROR: Traefik dynamic config dir not found: ${TRAEFIK_DYNAMIC_DIR}"
  exit 1
fi

# ── Build (svc, public_host, internal_url) list from dynamic config files ───
# Each file is named <swarm-service-name>.yml and contains lines like:
#   rule: Host(`some.domain.com`)
#   url: http://<swarm-service-name>:<port>
#
# We only want one entry per service (skip duplicates from http/websecure pairs).

declare -A seen_svcs

log "Scanning ${TRAEFIK_DYNAMIC_DIR} for services..."

check_count=0

for config_file in "${TRAEFIK_DYNAMIC_DIR}"/*.yml; do
  [[ -f "${config_file}" ]] || continue

  svc="$(basename "${config_file}" .yml)"

  # Skip non-application configs (e.g. Dokploy internal services)
  # Only process if the swarm service actually exists
  if ! docker service inspect "${svc}" &>/dev/null 2>&1; then
    continue
  fi

  # Skip if already processed (shouldn't happen but be safe)
  [[ -n "${seen_svcs[${svc}]+x}" ]] && continue
  seen_svcs["${svc}"]=1

  # Extract the first Host(`...`) rule
  # Handles: rule: Host(`some.domain.com`) or Host(`a`) || Host(`b`)
  public_host="$(grep -oP "Host\(\`[^\`]+\`\)" "${config_file}" | head -1 | grep -oP "[^\`]+" | grep -v "Host(" | head -1 || true)"

  if [[ -z "${public_host}" ]]; then
    log "${svc}: no Host rule found in config, skipping"
    continue
  fi

  # Extract the internal loadbalancer URL
  internal_url="$(grep -oP "url:\s*\K[^\s]+" "${config_file}" | head -1 || true)"

  if [[ -z "${internal_url}" ]]; then
    log "${svc}: no internal URL in config, skipping"
    continue
  fi

  (( check_count++ )) || true

  # ── Step 1: Probe public URL ─────────────────────────────────────────────
  pub_code="$(curl -sk \
    -o /dev/null \
    -w "%{http_code}" \
    --max-time "${PROBE_TIMEOUT}" \
    "https://${public_host}/" 2>/dev/null || echo "000")"

  if [[ "${pub_code}" != "000" && "${pub_code}" != "504" ]]; then
    log "${svc}: code=${pub_code} host=${public_host} — routing healthy"
    continue
  fi

  log "${svc}: code=${pub_code} host=${public_host} — SUSPECT stale routing, probing overlay..."

  # ── Step 2: Probe via dokploy-network overlay ─────────────────────────────
  overlay_code="$(docker run --rm \
    --network dokploy-network \
    "${CURL_IMAGE}" \
    -sS -o /dev/null -w "%{http_code}" \
    --max-time "${OVERLAY_TIMEOUT}" \
    "${internal_url}/" 2>/dev/null || echo "000")"

  if [[ "${overlay_code}" == "000" ]]; then
    log "${svc}: overlay also 000 — real outage (container not responding), skipping force-update"
    continue
  fi

  log "${svc}: overlay=${overlay_code} url=${internal_url} — container alive. Stale IPVS routing CONFIRMED."

  # ── Step 3: Check swarm UpdateStatus — skip mid-deploy ──────────────────
  update_state="$(docker service inspect "${svc}" \
    --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}none{{end}}' \
    2>/dev/null || echo "not-found")"

  if [[ "${update_state}" == "updating" || "${update_state}" == "rollback_started" ]]; then
    log "${svc}: swarm UpdateStatus=${update_state} — service is mid-deploy, skipping"
    continue
  fi

  log "${svc}: UpdateStatus=${update_state} — safe to force-update"

  # ── Step 4: Force-update ─────────────────────────────────────────────────
  fix_start="$(date +%s)"
  log "${svc}: running 'docker service update --force --detach=false ${svc}' ..."

  update_output="$(docker service update --force --detach=false "${svc}" 2>&1)" || {
    log "${svc}: WARNING — force-update returned non-zero. Output: $(echo "${update_output}" | tail -3)"
  }
  log "${svc}: force-update complete. Output tail: $(echo "${update_output}" | tail -3)"

  # ── Step 5: Re-probe public URL (up to CONVERGE_TIMEOUT) ─────────────────
  log "${svc}: waiting for public route to converge (max ${CONVERGE_TIMEOUT}s)..."
  converged=false
  deadline=$(( fix_start + CONVERGE_TIMEOUT ))
  post_code="000"

  while [[ "$(date +%s)" -lt "${deadline}" ]]; do
    post_code="$(curl -sk \
      -o /dev/null \
      -w "%{http_code}" \
      --max-time "${PROBE_TIMEOUT}" \
      "https://${public_host}/" 2>/dev/null || echo "000")"

    if [[ "${post_code}" != "000" && "${post_code}" != "504" ]]; then
      elapsed=$(( $(date +%s) - fix_start ))
      log "${svc}: public route converged in ${elapsed}s — post-fix code=${post_code}"
      converged=true
      break
    fi

    sleep 5
  done

  if [[ "${converged}" != "true" ]]; then
    elapsed=$(( $(date +%s) - fix_start ))
    log "${svc}: WARNING — public route did NOT converge within ${CONVERGE_TIMEOUT}s (last code=${post_code}). Manual investigation needed."
  fi

  # ── Step 6: Slack alert (debounced per-service) ───────────────────────────
  debounce_file="${DEBOUNCE_DIR}/last-fixed-${svc}"
  now_epoch="$(date +%s)"
  skip_slack=false

  if [[ -f "${debounce_file}" ]]; then
    last_fixed="$(cat "${debounce_file}" 2>/dev/null || echo 0)"
    age=$(( now_epoch - last_fixed ))
    if [[ "${age}" -lt "${DEBOUNCE_SECS}" ]]; then
      log "${svc}: Slack suppressed (last alert ${age}s ago, threshold ${DEBOUNCE_SECS}s)"
      skip_slack=true
    fi
  fi

  echo "${now_epoch}" > "${debounce_file}"

  if [[ "${skip_slack}" != "true" && -n "${SLACK_WEBHOOK:-}" ]]; then
    if [[ "${converged}" == "true" ]]; then
      converge_msg="Converged in ${elapsed}s after force-update."
      emoji=":wrench:"
      title="Overlay routing healed"
    else
      converge_msg="WARNING: route still returning ${post_code} after ${CONVERGE_TIMEOUT}s — manual check needed."
      emoji=":warning:"
      title="Overlay routing fix attempted — NOT yet converged"
    fi

    slack_text="${emoji} *${title}* — \`${svc}\`\n• Public host: \`${public_host}\`\n• Before: HTTP \`${pub_code}\` (stale IPVS/Traefik)\n• Overlay check: HTTP \`${overlay_code}\` (container alive)\n• ${converge_msg}"
    payload="{\"text\": \"$(echo "${slack_text}" | sed 's/"/\\"/g')\"}"

    curl -fsS \
      -X POST \
      -H 'Content-Type: application/json' \
      -d "${payload}" \
      "${SLACK_WEBHOOK}" >/dev/null 2>&1 || \
      log "${svc}: WARNING — Slack POST failed (non-fatal)"

    log "${svc}: Slack alert sent"
  fi

done

log "Overlay routing check complete (checked ${check_count} service(s))."
