#!/usr/bin/env bash
# install.sh — Install the swarm node-drop alert on VPS2 (the Swarm manager: `docker node ls` only works there, and it
# has the trusted root SSH to every worker that the wave check uses).
#   sudo bash ops/swarm-node-watch/install.sh
# Then fill /etc/revhero/swarm-node-watch.env (SLACK_WEBHOOK). Secrets are not in this repo.
# NOT run by CI or by merging this repo — installing on VPS2 is a deliberate, separate step.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "[install] swarm-node-watch installation..."

for cmd in docker jq curl ssh timeout date sort paste; do
  command -v "$cmd" >/dev/null || { echo "[install] ERROR: '$cmd' not found." >&2; exit 1; }
done
echo "[install] deps OK (docker jq curl ssh timeout date sort paste)."
command -v flock >/dev/null || echo "[install] WARN: 'flock' not found — a manual run could overlap the timer's run."
docker node ls >/dev/null 2>&1 || echo "[install] WARN: 'docker node ls' fails here — this host must be the swarm MANAGER, or the check will report itself blind."

cp "${SCRIPT_DIR}/check-swarm-nodes.sh" /usr/local/bin/check-swarm-nodes.sh
chmod 0755 /usr/local/bin/check-swarm-nodes.sh
echo "[install] script -> /usr/local/bin/check-swarm-nodes.sh"

cp "${SCRIPT_DIR}/swarm-node-watch.service" /etc/systemd/system/swarm-node-watch.service
cp "${SCRIPT_DIR}/swarm-node-watch.timer"   /etc/systemd/system/swarm-node-watch.timer
chmod 0644 /etc/systemd/system/swarm-node-watch.service /etc/systemd/system/swarm-node-watch.timer
echo "[install] units installed."

mkdir -p /etc/revhero
ENV_FILE="/etc/revhero/swarm-node-watch.env"
if [[ -f "${ENV_FILE}" ]]; then
  echo "[install] ${ENV_FILE} exists — leaving it untouched."
else
  cp "${SCRIPT_DIR}/swarm-node-watch.env.example" "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
  echo "[install] wrote ${ENV_FILE} skeleton."
fi

mkdir -p /var/lib/swarm-node-watch
systemctl daemon-reload

# Do not start a timer whose first run can only fail: with the placeholder webhook the check cannot deliver anything.
if grep -q '^SLACK_WEBHOOK=\(REPLACE_ME\)\?$' "${ENV_FILE}"; then
  echo "[install] SLACK_WEBHOOK is not set in ${ENV_FILE} — the timer is NOT enabled yet."
  echo "[install] Next: edit it, run the manual test below, then:  systemctl enable --now swarm-node-watch.timer"
else
  systemctl enable --now swarm-node-watch.timer
  echo "[install] timer enabled."
  systemctl list-timers swarm-node-watch.timer --no-pager || true
fi
echo "[install] done."
echo ""
echo "[install] Manual test (validates docker node ls + the SSH journal read on every worker + the Slack path; changes nothing):"
echo "  set -a; . /etc/revhero/swarm-node-watch.env; set +a; TEST_ALERT=true /usr/local/bin/check-swarm-nodes.sh"
echo "  journalctl -u swarm-node-watch.service --no-pager -n 50"
echo "  systemctl --failed        # a FAILED unit here = the watcher itself is broken (no webhook / Slack down / not the manager)"
