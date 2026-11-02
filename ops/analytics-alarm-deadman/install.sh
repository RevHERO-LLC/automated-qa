#!/usr/bin/env bash
# install.sh — Install the analytics alarm-loop dead-man check on VPS2 (the Swarm manager: it reads the analytics
# service spec for the internal secret at run time and reaches analytics over its public HTTPS route).
#   sudo bash ops/analytics-alarm-deadman/install.sh
# Then fill /etc/revhero/analytics-alarm-deadman.env (SLACK_WEBHOOK). Secrets are not in this repo.
# NOT run by CI or by merging this repo — installing on VPS2 is a deliberate, separate step.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "[install] analytics-alarm-deadman installation..."

for cmd in docker jq curl date; do
  command -v "$cmd" >/dev/null || { echo "[install] ERROR: '$cmd' not found." >&2; exit 1; }
done
echo "[install] deps OK (docker jq curl date)."

cp "${SCRIPT_DIR}/check-alarm-heartbeat.sh" /usr/local/bin/check-alarm-heartbeat.sh
chmod 0755 /usr/local/bin/check-alarm-heartbeat.sh
echo "[install] script -> /usr/local/bin/check-alarm-heartbeat.sh"

cp "${SCRIPT_DIR}/analytics-alarm-deadman.service" /etc/systemd/system/analytics-alarm-deadman.service
cp "${SCRIPT_DIR}/analytics-alarm-deadman.timer"   /etc/systemd/system/analytics-alarm-deadman.timer
chmod 0644 /etc/systemd/system/analytics-alarm-deadman.service /etc/systemd/system/analytics-alarm-deadman.timer
echo "[install] units installed."

mkdir -p /etc/revhero
ENV_FILE="/etc/revhero/analytics-alarm-deadman.env"
if [[ -f "${ENV_FILE}" ]]; then
  echo "[install] ${ENV_FILE} exists — leaving it untouched."
else
  cp "${SCRIPT_DIR}/analytics-alarm-deadman.env.example" "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
  echo "[install] wrote ${ENV_FILE} skeleton — set SLACK_WEBHOOK before the timer fires (the check exits 2 without it)."
fi

mkdir -p /var/lib/analytics-alarm-deadman
systemctl daemon-reload
systemctl enable --now analytics-alarm-deadman.timer
echo "[install] done."
echo ""
systemctl list-timers analytics-alarm-deadman.timer --no-pager || true
echo ""
echo "[install] Manual test (validates the heartbeat call + Slack path):"
echo "  set -a; . /etc/revhero/analytics-alarm-deadman.env; set +a; TEST_ALERT=true /usr/local/bin/check-alarm-heartbeat.sh"
echo "  journalctl -u analytics-alarm-deadman.service --no-pager -n 50"
echo "  systemctl --failed        # a FAILED unit here = the dead-man itself is broken (no webhook / Slack down / no secret)"
