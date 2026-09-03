#!/usr/bin/env bash
# install.sh — Install the overlay-fdb-detector on VPS2 (the Swarm manager, which
# has node->node root SSH to the workers). Read-only detector; no netns mutation.
#   sudo bash ops/overlay-fdb-detector/install.sh
# Then fill /etc/revhero/overlay-fdb-detector.env (SLACK_WEBHOOK). Secrets are not in this repo.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "[install] overlay-fdb-detector installation..."

for cmd in docker jq curl nsenter ssh bridge; do
  command -v "$cmd" >/dev/null || { echo "[install] ERROR: '$cmd' not found." >&2; exit 1; }
done
echo "[install] deps OK (docker jq curl nsenter ssh bridge)."

cp "${SCRIPT_DIR}/check-overlay-fdb.sh" /usr/local/bin/check-overlay-fdb.sh
chmod 0755 /usr/local/bin/check-overlay-fdb.sh
echo "[install] script -> /usr/local/bin/check-overlay-fdb.sh"

cp "${SCRIPT_DIR}/overlay-fdb-detector.service" /etc/systemd/system/overlay-fdb-detector.service
cp "${SCRIPT_DIR}/overlay-fdb-detector.timer"   /etc/systemd/system/overlay-fdb-detector.timer
chmod 0644 /etc/systemd/system/overlay-fdb-detector.service /etc/systemd/system/overlay-fdb-detector.timer
echo "[install] units installed."

mkdir -p /etc/revhero
ENV_FILE="/etc/revhero/overlay-fdb-detector.env"
if [[ -f "${ENV_FILE}" ]]; then
  echo "[install] ${ENV_FILE} exists — leaving it untouched."
else
  printf '%s\n' \
    '# Fill in, then: chmod 0600 /etc/revhero/overlay-fdb-detector.env' \
    'SLACK_WEBHOOK=REPLACE_ME' \
    > "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
  echo "[install] wrote ${ENV_FILE} skeleton."
fi

mkdir -p /var/lib/overlay-fdb-detector
systemctl daemon-reload
systemctl enable --now overlay-fdb-detector.timer
echo "[install] done."
echo ""
systemctl list-timers overlay-fdb-detector.timer --no-pager || true
echo ""
echo "[install] Manual test (validates SSH fan-out + Slack path):"
echo "  set -a; . /etc/revhero/overlay-fdb-detector.env; set +a; TEST_ALERT=true /usr/local/bin/check-overlay-fdb.sh"
echo "  journalctl -u overlay-fdb-detector.service --no-pager -n 50"
