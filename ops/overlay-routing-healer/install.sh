#!/usr/bin/env bash
# install.sh — Install the overlay-routing-healer on the Docker Swarm manager (VPS2).
# Run as root from the repo directory or any directory containing the sibling files.
# Usage: sudo bash ops/overlay-routing-healer/install.sh
#
# After running this script, populate /etc/revhero/overlay-routing-healer.env
# with real values for DOKPLOY_API_KEY and SLACK_WEBHOOK if not already present.
# Secrets are NOT stored in this repository.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[install] Starting overlay-routing-healer installation..."

# ── Verify we have the tools we need ─────────────────────────────────────────
for cmd in docker curl jq systemctl; do
  if ! command -v "${cmd}" &>/dev/null; then
    echo "[install] ERROR: '${cmd}' not found. Please install it first." >&2
    exit 1
  fi
done
echo "[install] Tool check passed: docker, curl, jq, systemctl all present."

# ── Verify jq works ──────────────────────────────────────────────────────────
jq_version="$(jq --version 2>/dev/null || echo 'unknown')"
echo "[install] jq version: ${jq_version}"

# ── Copy the checker script ───────────────────────────────────────────────────
echo "[install] Installing check-and-fix-overlay-routing.sh -> /usr/local/bin/ ..."
cp "${SCRIPT_DIR}/check-and-fix-overlay-routing.sh" /usr/local/bin/check-and-fix-overlay-routing.sh
chmod 0755 /usr/local/bin/check-and-fix-overlay-routing.sh
echo "[install] Script installed."

# ── Copy systemd units ────────────────────────────────────────────────────────
echo "[install] Installing systemd service + timer units..."
cp "${SCRIPT_DIR}/overlay-routing-healer.service" /etc/systemd/system/overlay-routing-healer.service
cp "${SCRIPT_DIR}/overlay-routing-healer.timer"   /etc/systemd/system/overlay-routing-healer.timer
chmod 0644 /etc/systemd/system/overlay-routing-healer.service
chmod 0644 /etc/systemd/system/overlay-routing-healer.timer
echo "[install] Units installed."

# ── Write environment file (skeleton only — no secrets in repo) ───────────────
# Secrets are NOT stored in this repository. If the env file already exists
# (e.g. from a prior install with real values), leave it untouched.
mkdir -p /etc/revhero
ENV_FILE="/etc/revhero/overlay-routing-healer.env"

if [[ -f "${ENV_FILE}" ]]; then
  echo "[install] ${ENV_FILE} already exists — leaving it untouched."
else
  echo "[install] Writing ${ENV_FILE} skeleton — fill in the values before the timer fires."
  printf '%s\n' \
    '# Fill in both values, then: chmod 0600 /etc/revhero/overlay-routing-healer.env' \
    'DOKPLOY_API_KEY=REPLACE_ME' \
    'SLACK_WEBHOOK=REPLACE_ME' \
    > "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
  echo "[install] Skeleton written. Edit ${ENV_FILE} with real values, then run:"
  echo "  sudo systemctl start overlay-routing-healer.service"
fi

# ── Create debounce state directory ──────────────────────────────────────────
mkdir -p /var/lib/overlay-routing-healer
echo "[install] Debounce state dir: /var/lib/overlay-routing-healer"

# ── Reload systemd + enable/start timer ──────────────────────────────────────
echo "[install] Reloading systemd daemon..."
systemctl daemon-reload

echo "[install] Enabling + starting overlay-routing-healer.timer..."
systemctl enable --now overlay-routing-healer.timer

echo "[install] Installation complete."
echo ""
systemctl status overlay-routing-healer.timer --no-pager || true
echo ""
echo "[install] To view next scheduled run:"
echo "  systemctl list-timers overlay-routing-healer.timer --no-pager"
echo ""
echo "[install] To trigger a manual run now:"
echo "  sudo systemctl start overlay-routing-healer.service"
echo "  journalctl -u overlay-routing-healer.service --no-pager -n 100"
