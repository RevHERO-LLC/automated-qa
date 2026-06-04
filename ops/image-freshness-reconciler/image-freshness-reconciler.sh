#!/usr/bin/env bash
# image-freshness-reconciler.sh
#
# Detects swarm services whose running task predates the registry's current
# image for their tag (the "Dokploy missed the redeploy" failure: GHA builds
# and pushes ghcr.io/...:prod, application.deploy is fire-and-forget, and the
# container never rolls — observed 5x on 2026-06-03 across 4 services) and
# heals them with: docker service update --force --detach=false <svc>.
#
# Runs on the swarm MANAGER (VPS2) so one instance covers prod (VPS2+VPS3)
# AND staging (VPS1) — workers can't run `service update`.
#
# Detection (per ghcr.io/revhero-llc/* service):
#   tier 1 (all nodes):  registry image Created > running task CreatedAt
#                        + GRACE  → the task predates the current image → stale.
#   tier 2 (this node):  running container's image ID != pulled tag image ID
#                        → exact digest mismatch (catches crash-restarts that
#                        came back on a stale node cache).
# `docker pull <tag>` is a manifest HEAD when unchanged — cheap at 5-min cadence.
#
# Skips: non-ghcr/revhero-llc images (nats/redis/traefik/etc), services with
# an update already in progress, services with no running task.
#
# Posts a Slack alert on each heal (debounced per-service) and backs off
# services that stay stale after a heal (persistent problem ≠ missed deploy).
#
# Env vars (from /etc/revhero/image-freshness-reconciler.env):
#   SLACK_WEBHOOK — Slack incoming webhook URL (optional; log-only if unset)

set -uo pipefail

STATE_DIR="/var/lib/image-freshness-reconciler"
GRACE_SECS=120         # image must be this much newer than the task to count as stale
                       # (absorbs the normal build→Dokploy-roll window)
CONVERGE_TIMEOUT=300   # seconds to wait for service update convergence
ALERT_DEBOUNCE=3600    # 1h between Slack alerts per service
HEAL_BACKOFF=1800      # 30min: don't re-heal the same service more often than this
IMAGE_FILTER="ghcr.io/revhero-llc/"

mkdir -p "${STATE_DIR}"

log() { echo "[image-freshness $(date +%H:%M:%S)] $*"; }

slack() {
  local text="$1"
  [[ -z "${SLACK_WEBHOOK:-}" ]] && { log "SLACK (unset): ${text}"; return 0; }
  curl -fsSL -m 10 -X POST -H "Content-Type: application/json" \
    -d "$(jq -n --arg t "${text}" '{text: $t}')" \
    "${SLACK_WEBHOOK}" >/dev/null || log "WARN: Slack post failed"
}

# epoch from a docker RFC3339 timestamp (handles the nanosecond suffix)
epoch() { date -d "$1" +%s 2>/dev/null || echo 0; }

healed=0
stale_found=0
checked=0

for line in $(docker service ls --format '{{.Name}}|{{.Image}}'); do
  svc="${line%%|*}"
  image="${line#*|}"
  tag="${image%%@*}"   # strip any digest pin

  [[ "${tag}" != ${IMAGE_FILTER}* ]] && continue
  checked=$((checked + 1))

  # Skip if an update is already in flight (a real deploy is rolling — don't race it)
  upd_state="$(docker service inspect "${svc}" --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' 2>/dev/null || true)"
  if [[ "${upd_state}" == "updating" || "${upd_state}" == "paused" ]]; then
    log "${svc}: update in progress (${upd_state}) — skipping this cycle"
    continue
  fi

  # Current running task (newest)
  task_id="$(docker service ps "${svc}" -q --filter desired-state=running 2>/dev/null | head -1)"
  if [[ -z "${task_id}" ]]; then
    log "${svc}: no running task — skipping (not an image-freshness problem)"
    continue
  fi
  # NB: the --format template renders Go time ("... +0000 UTC") which GNU date
  # can't parse — read the raw RFC3339 field via jq instead (caught in the
  # 2026-06-04 staging staleness drill: task_epoch=0 made tier 1 blind).
  task_created="$(docker inspect "${task_id}" 2>/dev/null | jq -r '.[0].CreatedAt // empty')"
  task_epoch="$(epoch "${task_created}")"

  # Refresh the local copy of the tag (manifest check when unchanged)
  if ! docker pull -q "${tag}" >/dev/null 2>&1; then
    log "${svc}: WARN pull failed for ${tag} — skipping"
    continue
  fi
  img_created="$(docker image inspect "${tag}" --format '{{.Created}}' 2>/dev/null || true)"
  img_epoch="$(epoch "${img_created}")"
  img_id="$(docker image inspect "${tag}" --format '{{.Id}}' 2>/dev/null || true)"

  stale=""
  # tier 1: task predates the registry image
  if (( img_epoch > 0 && task_epoch > 0 && img_epoch > task_epoch + GRACE_SECS )); then
    stale="task created ${task_created} predates registry image ${img_created}"
  fi
  # tier 2: exact image-ID check when the container runs on THIS node
  if [[ -z "${stale}" ]]; then
    cid="$(docker ps -q --filter "label=com.docker.swarm.service.name=${svc}" | head -1)"
    if [[ -n "${cid}" ]]; then
      running_img="$(docker inspect "${cid}" --format '{{.Image}}' 2>/dev/null || true)"
      if [[ -n "${running_img}" && -n "${img_id}" && "${running_img}" != "${img_id}" ]]; then
        stale="local container image ${running_img:7:12} != registry image ${img_id:7:12}"
      fi
    fi
  fi

  [[ -z "${stale}" ]] && continue
  stale_found=$((stale_found + 1))
  log "${svc}: STALE — ${stale}"

  # Heal back-off: if we already healed this service recently and it is stale
  # AGAIN, something else is wrong — alert (debounced) but don't churn it.
  heal_marker="${STATE_DIR}/${svc}.lastheal"
  now=$(date +%s)
  if [[ -f "${heal_marker}" ]] && (( now - $(cat "${heal_marker}") < HEAL_BACKOFF )); then
    alert_marker="${STATE_DIR}/${svc}.lastalert"
    if [[ ! -f "${alert_marker}" ]] || (( now - $(cat "${alert_marker}") >= ALERT_DEBOUNCE )); then
      slack ":rotating_light: image-freshness: \`${svc}\` is STALE AGAIN within ${HEAL_BACKOFF}s of a heal (${stale}). NOT re-healing — needs a human look."
      echo "${now}" > "${alert_marker}"
    fi
    continue
  fi

  log "${svc}: healing via docker service update --force"
  echo "${now}" > "${heal_marker}"
  if timeout "${CONVERGE_TIMEOUT}" docker service update --force --detach=false --quiet "${svc}" >/dev/null 2>&1; then
    healed=$((healed + 1))
    log "${svc}: healed (converged)"
    slack ":adhesive_bandage: image-freshness: \`${svc}\` was running a stale image (${stale}) — force-rolled to the current registry image. Likely a missed Dokploy redeploy."
  else
    log "${svc}: ERROR — force update did not converge in ${CONVERGE_TIMEOUT}s"
    slack ":x: image-freshness: \`${svc}\` stale (${stale}) and the force update did NOT converge in ${CONVERGE_TIMEOUT}s — check \`docker service ps ${svc}\` on the manager."
  fi
done

# Clean up dangling layers left behind by refreshed tags (tagged images are kept)
docker image prune -f >/dev/null 2>&1 || true

log "done: checked=${checked} stale=${stale_found} healed=${healed}"
