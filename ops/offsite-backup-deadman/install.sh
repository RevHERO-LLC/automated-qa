#!/usr/bin/env bash
# install.sh — Install the offsite-backup dead-man on VPS2 (a different host from the backup itself, on purpose).
#   sudo bash ops/offsite-backup-deadman/install.sh
# Then fill /etc/revhero/offsite-backup-deadman.env (SLACK_WEBHOOK + the read-only AWS_PROFILE). Secrets are not in this repo.
# NOT run by CI or by merging this repo — installing on VPS2 is a deliberate, separate step (runbook R2).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "[install] offsite-backup-deadman installation..."

for cmd in aws jq curl date; do
  command -v "$cmd" >/dev/null || { echo "[install] ERROR: '$cmd' not found." >&2; exit 1; }
done
echo "[install] deps OK (aws jq curl date)."

cp "${SCRIPT_DIR}/check-offsite-backup.sh" /usr/local/bin/check-offsite-backup.sh
chmod 0755 /usr/local/bin/check-offsite-backup.sh
echo "[install] script -> /usr/local/bin/check-offsite-backup.sh"

cp "${SCRIPT_DIR}/offsite-backup-deadman.service" /etc/systemd/system/offsite-backup-deadman.service
cp "${SCRIPT_DIR}/offsite-backup-deadman.timer"   /etc/systemd/system/offsite-backup-deadman.timer
chmod 0644 /etc/systemd/system/offsite-backup-deadman.service /etc/systemd/system/offsite-backup-deadman.timer
echo "[install] units installed."

mkdir -p /etc/revhero
ENV_FILE="/etc/revhero/offsite-backup-deadman.env"
if [[ -f "${ENV_FILE}" ]]; then
  echo "[install] ${ENV_FILE} exists — leaving it untouched."
else
  cp "${SCRIPT_DIR}/offsite-backup-deadman.env.example" "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
  echo "[install] wrote ${ENV_FILE} skeleton — set SLACK_WEBHOOK and AWS_PROFILE before the timer fires."
fi

mkdir -p /var/lib/offsite-backup-deadman
systemctl daemon-reload
systemctl enable --now offsite-backup-deadman.timer
echo "[install] done."
echo ""
systemctl list-timers offsite-backup-deadman.timer --no-pager || true
echo ""
echo "[install] Manual test (validates the S3 read + Slack path):"
echo "  set -a; . /etc/revhero/offsite-backup-deadman.env; set +a; TEST_ALERT=true /usr/local/bin/check-offsite-backup.sh"
echo "  journalctl -u offsite-backup-deadman.service --no-pager -n 50"
echo "  systemctl --failed        # a FAILED unit here = the dead-man itself is broken (no webhook / Slack down / no aws)"
