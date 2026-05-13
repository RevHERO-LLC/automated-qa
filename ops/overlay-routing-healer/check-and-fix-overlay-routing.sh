#!/usr/bin/env bash
# check-and-fix-overlay-routing.sh
# Detects stale Docker Swarm overlay IPVS routing (public URL returns 504/timeout
# but container itself responds on dokploy-network) and heals with:
#   docker service update --force --detach=false <name>
# Posts a Slack alert on each fix (debounced per-service to once per hour).
#
# Requires: bash, curl, jq, docker
# Env vars (from /etc/revhero/overlay-routing-healer.env):
#   DOKPLOY_API_KEY   - Dokploy API key
#   SLACK_WEBHOOK     - Slack incoming webhook URL

set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────────────
DOKPLOY_URL="http://127.0.0.1:3000"
DEBOUNCE_DIR="/var/lib/overlay-routing-healer"
CURL_IMAGE="curlimages/curl:8.10.1"
PROBE_TIMEOUT=6       # seconds for public probe
OVERLAY_TIMEOUT=4     # seconds for overlay probe
CONVERGE_TIMEOUT=90   # seconds to wait for convergence after force-update
DEBOUNCE_SECS=3600    # 1 hour

mkdir -p "${DEBOUNCE_DIR}"

log() {
  echo "[overlay-check $(date +%H:%M:%S)] $*"
}

# ── Fetch application list from Dokploy ─────────────────────────────────────
log "Fetching application list from Dokploy..."

apps_json="$(curl -sf \
  --max-time 15 \
  -H "x-api-key: ${DOKPLOY_API_KEY}" \
  "${DOKPLOY_URL}/api/application.all" 2>&1)" || {
  log "ERROR: Failed to reach Dokploy API — aborting run"
  exit 1
}

# Extract (appName, host) pairs for apps with status==done and at least one domain
mapfile -t pairs < <(echo "${apps_json}" | jq -r '
  .[] |
  select(.applicationStatus == "done") |
  select(.domains != null and (.domains | length) > 0) |
  select(.domains[0].host != null and .domains[0].host != "") |
  "\(.appName)\t\(.domains[0].host)"
')

if [[ "${#pairs[@]}" -eq 0 ]]; then
  log "No active applications with domains found. Nothing to check."
  exit 0
fi

log "Found ${#pairs[@]} application(s) to check."

# ── Main check loop ──────────────────────────────────────────────────────────
for pair in "${pairs[@]}"; do
  svc="${pair%%$'\t'*}"
  host="${pair##*$'\t'}"

  # ── Step 1: Probe public URL ───────────────────────────────────────────────
  pub_code="$(curl -sk \
    -o /dev/null \
    -w "%{http_code}" \
    --max-time "${PROBE_TIMEOUT}" \
    "https://${host}/" 2>/dev/null || echo "000")"

  if [[ "${pub_code}" != "000" && "${pub_code}" != "504" ]]; then
    log "${svc}: code=${pub_code} host=${host} — routing healthy, skip"
    continue
  fi

  log "${svc}: code=${pub_code} host=${host} — SUSPECT stale routing, probing overlay..."

  # ── Step 2: Probe via dokploy-network overlay ──────────────────────────────
  # Use port 3000 first (most common), fall back to 80 if 000
  overlay_code="$(docker run --rm \
    --network dokploy-network \
    "${CURL_IMAGE}" \
    -sS -o /dev/null -w "%{http_code}" \
    --max-time "${OVERLAY_TIMEOUT}" \
    "http://${svc}/" 2>/dev/null || echo "000")"

  if [[ "${overlay_code}" == "000" ]]; then
    log "${svc}: overlay also 000 — real outage (container not responding), skipping force-update"
    continue
  fi

  log "${svc}: overlay=${overlay_code} — container is alive. Stale IPVS routing CONFIRMED."

  # ── Step 3: Check swarm UpdateStatus — don't interrupt an in-progress deploy ─
  update_state="$(docker service inspect "${svc}" \
    --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}none{{end}}' \
    2>/dev/null || echo "not-found")"

  if [[ "${update_state}" == "updating" || "${update_state}" == "rollback_started" ]]; then
    log "${svc}: swarm UpdateStatus=${update_state} — service is mid-deploy, skipping"
    continue
  fi

  log "${svc}: UpdateStatus=${update_state} — safe to force-update"

  # ── Step 4: Force-update ───────────────────────────────────────────────────
  fix_start="$(date +%s)"
  log "${svc}: running 'docker service update --force --detach=false ${svc}' ..."

  update_output="$(docker service update --force --detach=false "${svc}" 2>&1)" || {
    log "${svc}: WARNING — force-update command returned non-zero. Output: ${update_output}"
  }
  log "${svc}: force-update complete. Output tail: $(echo "${update_output}" | tail -3)"

  # ── Step 5: Re-probe public URL (up to CONVERGE_TIMEOUT seconds) ──────────
  log "${svc}: waiting for public route to converge (max ${CONVERGE_TIMEOUT}s)..."
  converged=false
  deadline=$(( fix_start + CONVERGE_TIMEOUT ))
  elapsed=0

  while [[ "$(date +%s)" -lt "${deadline}" ]]; do
    post_code="$(curl -sk \
      -o /dev/null \
      -w "%{http_code}" \
      --max-time "${PROBE_TIMEOUT}" \
      "https://${host}/" 2>/dev/null || echo "000")"

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
    log "${svc}: WARNING — public route did NOT converge within ${CONVERGE_TIMEOUT}s (last code=${post_code:-000}). Manual investigation needed."
  fi

  # ── Step 6: Slack alert (debounced per-service) ────────────────────────────
  debounce_file="${DEBOUNCE_DIR}/last-fixed-${svc}"
  now_epoch="$(date +%s)"
  skip_slack=false

  if [[ -f "${debounce_file}" ]]; then
    last_fixed="$(cat "${debounce_file}" 2>/dev/null || echo 0)"
    age=$(( now_epoch - last_fixed ))
    if [[ "${age}" -lt "${DEBOUNCE_SECS}" ]]; then
      log "${svc}: Slack alert suppressed (debounce — last fix was ${age}s ago, threshold ${DEBOUNCE_SECS}s)"
      skip_slack=true
    fi
  fi

  # Always update the debounce timestamp (even if we skip Slack)
  echo "${now_epoch}" > "${debounce_file}"

  if [[ "${skip_slack}" != "true" && -n "${SLACK_WEBHOOK:-}" ]]; then
    if [[ "${converged}" == "true" ]]; then
      slack_msg=":wrench: *Overlay routing healed* — \`${svc}\`\n• Host: \`${host}\`\n• Before: HTTP \`${pub_code}\` (stale IPVS)\n• Overlay check: HTTP \`${overlay_code}\` (container healthy)\n• Converged in ${elapsed}s after \`docker service update --force\`"
    else
      slack_msg=":warning: *Overlay routing fix attempted but did NOT converge* — \`${svc}\`\n• Host: \`${host}\`\n• Before: HTTP \`${pub_code}\`\n• Overlay: HTTP \`${overlay_code}\`\n• Force-update ran but public URL still returning \`${post_code:-000}\` after ${CONVERGE_TIMEOUT}s"
    fi

    payload="$(printf '{"text": "%s"}' "$(echo "${slack_msg}" | sed 's/"/\\"/g')")"

    curl -fsS \
      -X POST \
      -H 'Content-Type: application/json' \
      -d "${payload}" \
      "${SLACK_WEBHOOK}" > /dev/null 2>&1 || \
      log "${svc}: WARNING — Slack POST failed (non-fatal)"

    log "${svc}: Slack alert sent"
  fi
done

log "Overlay routing check complete."
