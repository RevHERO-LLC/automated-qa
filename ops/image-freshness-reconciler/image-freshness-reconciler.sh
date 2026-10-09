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
# Detection (per ghcr.io/revhero-llc/* or registry.revhero.io/revhero-llc/* service):
#   tier 1 (all nodes):  registry image Created > running task CreatedAt
#                        + GRACE  → the task predates the current image → stale.
#   tier 2 (this node):  running container's image ID != pulled tag image ID
#                        → exact digest mismatch (catches crash-restarts that
#                        came back on a stale node cache).
#   tier 3 (DETECT-ONLY, #940): tiers 1/2 only check the running image against
#                        the tag Swarm is ALREADY pinned to — they are BLIND to
#                        the tag itself being stale, e.g. Dokploy's dockerImage
#                        never advanced past an old :env-<sha> (the spec was
#                        simply never told about a newer commit — see
#                        reference_prod_deploy_never_told_dokploy_the_image).
#                        Tier 3 resolves the branch (staging->staging,
#                        prod->main) HEAD commit via the GitHub API, rebuilds
#                        the tag that commit WOULD have produced, and compares
#                        its pulled image ID against the currently-pinned tag's
#                        image ID. A mismatch, once the HEAD commit is older
#                        than SHA_GRACE_SECS (so a normal deploy would have
#                        finished), is logged + Slack-alerted — NEVER healed.
#                        Comparing image IDs (not the tag string) also covers
#                        a still-floating tag for free: a floating :prod whose
#                        content already matches HEAD reads as fine; one that
#                        doesn't is flagged exactly like a stale pin.
# `docker pull <tag>` is a manifest HEAD when unchanged — cheap at 5-min cadence.
#
# Skips: images outside revhero-llc on ghcr.io / registry.revhero.io
# (nats/redis/traefik/etc), services with an update already in progress,
# services with no running task, and any tag whose pull fails (WARN + skip,
# never a heal).
#
# Posts a Slack alert on each heal (debounced per-service) and backs off
# services that stay stale after a heal (persistent problem ≠ missed deploy).
#
# Env vars (from /etc/revhero/image-freshness-reconciler.env):
#   SLACK_WEBHOOK — Slack incoming webhook URL (optional; log-only if unset)
#   REGISTRY_DOCKER_CONFIG — DOCKER_CONFIG dir holding a READ-ONLY login for
#       registry.revhero.io (the `dokploy-pull` robot; P6 #84). Used only to
#       pull registry.revhero.io tags, so root's ~/.docker/config.json keeps
#       no persisted registry login. Unset → those pulls use root's config.
#   DRY_RUN=1 — detect and log "would heal", but never force-update or alert.
#   GITHUB_READ_TOKEN — read-only PAT, Contents:Read across the RevHERO-LLC
#       fleet repos (the same scope as the FLEET_READ_TOKEN GitHub Actions
#       secret used by .github/workflows/staging-prod-drift-check.yml — it can
#       be the identical token). Powers tier 3's branch-HEAD lookup via the
#       GitHub REST API. Unset → tier 3 is skipped entirely (logged once at
#       startup); tiers 1/2 are completely unaffected.
#   STATE_DIR — override the state-file directory (default below). Only
#       meant for tests; production always uses the default.

set -uo pipefail

STATE_DIR="${STATE_DIR:-/var/lib/image-freshness-reconciler}"
GRACE_SECS=120         # image must be this much newer than the task to count as stale
                       # (absorbs the normal build→Dokploy-roll window)
CONVERGE_TIMEOUT=300   # seconds to wait for service update convergence
ALERT_DEBOUNCE=3600    # 1h between Slack alerts per service
HEAL_BACKOFF=1800      # 30min: don't re-heal the same service more often than this
SHA_GRACE_SECS=600     # tier 3: branch HEAD must be at least this old before an
                       # unadvanced/mismatched tag counts as stuck (absorbs the
                       # normal build+push+Dokploy-roll pipeline duration)
# Both registries during and after the P6 cut-over: lane-2 still pulls from
# ghcr.io until it is migrated; everything else pulls from registry.revhero.io.
IMAGE_FILTER_RE='^(ghcr\.io|registry\.revhero\.io)/revhero-llc/'
DRY_RUN="${DRY_RUN:-0}"
GITHUB_API="https://api.github.com"
FLEET_ORG="RevHERO-LLC"
# GitHub's git/API routing is case-insensitive on the owner/repo path, so the
# lowercased image name (set by every workflow as
# `IMAGE_NAME=$(echo github.repository | tr upper lower)`) resolves straight
# to the real repo without a separate name map.

mkdir -p "${STATE_DIR}"

log() { echo "[image-freshness $(date +%H:%M:%S)] $*"; }

# Pull a tag with the credentials for its registry (read-only robot config for
# registry.revhero.io when REGISTRY_DOCKER_CONFIG is set).
pull_tag() {
  if [[ "$1" == registry.revhero.io/* && -n "${REGISTRY_DOCKER_CONFIG:-}" ]]; then
    DOCKER_CONFIG="${REGISTRY_DOCKER_CONFIG}" docker pull -q "$1"
  else
    docker pull -q "$1"
  fi
}

slack() {
  local text="$1"
  [[ -z "${SLACK_WEBHOOK:-}" ]] && { log "SLACK (unset): ${text}"; return 0; }
  curl -fsSL -m 10 -X POST -H "Content-Type: application/json" \
    -d "$(jq -n --arg t "${text}" '{text: $t}')" \
    "${SLACK_WEBHOOK}" >/dev/null || log "WARN: Slack post failed"
}

# epoch from a docker RFC3339 timestamp (handles the nanosecond suffix)
epoch() { date -d "$1" +%s 2>/dev/null || echo 0; }

# tier 3: the HEAD commit of a repo's branch via the GitHub REST API.
# Prints "<sha>|<committer-epoch>" on success, or nothing at all on ANY
# failure (bad/missing token, repo renamed/not found, network, rate limit,
# unparseable date, ...). Callers must treat an empty result as "unknown",
# never as "not stale" — this function never signals staleness either way.
github_branch_head() {
  local repo="$1" branch="$2" resp sha date
  resp="$(curl -fsSL -m 10 \
    -H "Authorization: Bearer ${GITHUB_READ_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "${GITHUB_API}/repos/${FLEET_ORG}/${repo}/commits/${branch}" 2>/dev/null)" || return 0
  sha="$(echo "${resp}" | jq -r '.sha // empty' 2>/dev/null)"
  [[ -z "${sha}" ]] && return 0
  date="$(echo "${resp}" | jq -r '.commit.committer.date // empty' 2>/dev/null)"
  echo "${sha}|$(epoch "${date}")"
}

healed=0
stale_found=0
checked=0
sha_stuck=0
sha_unknown=0

SHA_CHECK_ENABLED=0
if [[ -n "${GITHUB_READ_TOKEN:-}" ]]; then
  SHA_CHECK_ENABLED=1
else
  log "tier 3 (per-SHA stuck-roll, #940) DISABLED — GITHUB_READ_TOKEN not set; tiers 1/2 unaffected"
fi

for line in $(docker service ls --format '{{.Name}}|{{.Image}}'); do
  svc="${line%%|*}"
  image="${line#*|}"
  tag="${image%%@*}"   # strip any digest pin

  [[ ! "${tag}" =~ ${IMAGE_FILTER_RE} ]] && continue
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
  if ! pull_tag "${tag}" >/dev/null 2>&1; then
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

  if [[ -z "${stale}" ]]; then
    # tiers 1/2 say the running image matches the tag Swarm is PINNED to —
    # that says nothing about whether the pin itself is current (#940). tier
    # 3 checks the pin against the branch it's supposed to track. DETECT-ONLY:
    # never touches `stale`, never heals, always `continue`s out below.
    if (( ! SHA_CHECK_ENABLED )); then
      continue
    fi
    tag_suffix="${tag##*:}"
    case "${tag_suffix}" in
      staging*) branch="staging" ;;
      prod*)    branch="main" ;;
      *)        branch="" ;;
    esac
    if [[ -z "${branch}" ]]; then
      log "${svc}: SHA-check unknown — tag '${tag_suffix}' is neither staging* nor prod*"
      sha_unknown=$((sha_unknown + 1))
      continue
    fi
    repo="${tag#*revhero-llc/}"
    repo="${repo%%:*}"
    head_info="$(github_branch_head "${repo}" "${branch}")"
    if [[ -z "${head_info}" ]]; then
      log "${svc}: SHA-check unknown — GitHub lookup failed for ${FLEET_ORG}/${repo}@${branch}"
      sha_unknown=$((sha_unknown + 1))
      continue
    fi
    expected_sha="${head_info%%|*}"
    expected_epoch="${head_info#*|}"
    now_chk=$(date +%s)
    if (( expected_epoch > 0 && now_chk - expected_epoch < SHA_GRACE_SECS )); then
      log "${svc}: SHA-check skipped — ${branch}@${expected_sha:0:12} is < ${SHA_GRACE_SECS}s old (deploy likely still in flight)"
      continue
    fi
    # Preserve any non-sha prefix (env, optional -worker infix) and swap in
    # the expected SHA — works whether the running tag was pinned or still
    # floating (no trailing 40-hex run to strip).
    if [[ "${tag_suffix}" =~ ^(.+)-[0-9a-f]{40}$ ]]; then
      prefix="${BASH_REMATCH[1]}"
    else
      prefix="${tag_suffix}"
    fi
    expected_tag="${tag%:*}:${prefix}-${expected_sha}"
    if ! pull_tag "${expected_tag}" >/dev/null 2>&1; then
      log "${svc}: SHA-check unknown — could not pull expected ${expected_tag} (not pushed yet?)"
      sha_unknown=$((sha_unknown + 1))
      continue
    fi
    expected_img_id="$(docker image inspect "${expected_tag}" --format '{{.Id}}' 2>/dev/null || true)"
    if [[ -z "${expected_img_id}" || -z "${img_id}" ]]; then
      log "${svc}: SHA-check unknown — could not resolve an image ID to compare"
      sha_unknown=$((sha_unknown + 1))
      continue
    fi
    if [[ "${img_id}" != "${expected_img_id}" ]]; then
      sha_stuck=$((sha_stuck + 1))
      detail="running '${tag_suffix}' (${img_id:7:12}) != ${branch}@${expected_sha:0:12} (${expected_img_id:7:12})"
      log "${svc}: SHA-STUCK — ${detail}"
      sha_marker="${STATE_DIR}/${svc}.lastshaalert"
      now_a=$(date +%s)
      if [[ ! -f "${sha_marker}" ]] || (( now_a - $(cat "${sha_marker}") >= ALERT_DEBOUNCE )); then
        slack ":mag: image-freshness per-SHA check (#940, detect-only): \`${svc}\` is pinned to a tag that never advanced to ${branch} HEAD — ${detail}. NOT auto-rolled. Verify the target image, then \`docker service update --force --with-registry-auth ${svc}\` or re-trigger the Dokploy deploy."
        echo "${now_a}" > "${sha_marker}"
      fi
    fi
    continue
  fi
  stale_found=$((stale_found + 1))
  log "${svc}: STALE — ${stale}"
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "${svc}: DRY_RUN — would heal (no update, no alert)"
    continue
  fi

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

log "done: checked=${checked} stale=${stale_found} healed=${healed} sha_stuck=${sha_stuck} sha_unknown=${sha_unknown}"
