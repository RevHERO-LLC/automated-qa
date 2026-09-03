#!/usr/bin/env bash
# install.sh — Install the send-pipeline-monitor on VPS2 (Docker Swarm manager,
# on the WireGuard mesh with psql reach to VPS4 at 10.8.0.4:5432).
# Run as root from the repo dir (or any dir containing the sibling files):
#   sudo bash ops/send-pipeline-monitor/install.sh
#
# After running, populate /etc/revhero/send-pipeline-monitor.env with the real
# DB_DSN (send_pipeline_ro role) and SLACK_WEBHOOK. Secrets are NOT in this repo.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "[install] Starting send-pipeline-monitor installation..."

# ── Dependencies: python3 + psql (postgresql-client). No psycopg2/pip needed. ─
command -v python3 >/dev/null || { echo "[install] ERROR: python3 not found." >&2; exit 1; }
command -v psql >/dev/null || {
  echo "[install] ERROR: psql (postgresql-client) not found. Install it, e.g.:" >&2
  echo "         sudo apt-get install -y postgresql-client" >&2
  exit 1
}
echo "[install] Deps OK: $(python3 --version 2>&1), $(psql --version)"

# ── Copy the monitor script ──────────────────────────────────────────────────
cp "${SCRIPT_DIR}/monitor.py" /usr/local/bin/send-pipeline-monitor.py
chmod 0755 /usr/local/bin/send-pipeline-monitor.py
echo "[install] Script installed -> /usr/local/bin/send-pipeline-monitor.py"

# ── Copy systemd units ────────────────────────────────────────────────────────
cp "${SCRIPT_DIR}/send-pipeline-monitor.service" /etc/systemd/system/send-pipeline-monitor.service
cp "${SCRIPT_DIR}/send-pipeline-monitor.timer"   /etc/systemd/system/send-pipeline-monitor.timer
chmod 0644 /etc/systemd/system/send-pipeline-monitor.service /etc/systemd/system/send-pipeline-monitor.timer
echo "[install] Units installed."

# ── Env file (skeleton only — no secrets in repo) ─────────────────────────────
mkdir -p /etc/revhero
ENV_FILE="/etc/revhero/send-pipeline-monitor.env"
if [[ -f "${ENV_FILE}" ]]; then
  echo "[install] ${ENV_FILE} already exists — leaving it untouched."
else
  printf '%s\n' \
    '# Fill in both values, then: chmod 0600 /etc/revhero/send-pipeline-monitor.env' \
    'DB_DSN=postgresql://send_pipeline_ro:REPLACE_ME@10.8.0.4:5432/revhero_prod_email_ingress' \
    'SLACK_WEBHOOK=REPLACE_ME' \
    > "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
  echo "[install] Wrote ${ENV_FILE} skeleton — fill in real values before the timer fires."
fi

# ── Debounce state dir ───────────────────────────────────────────────────────
mkdir -p /var/lib/send-pipeline-monitor
echo "[install] Debounce state dir: /var/lib/send-pipeline-monitor"

# ── Enable + start the timer ─────────────────────────────────────────────────
systemctl daemon-reload
systemctl enable --now send-pipeline-monitor.timer
echo "[install] Installation complete."
echo ""
systemctl list-timers send-pipeline-monitor.timer --no-pager || true
echo ""
echo "[install] Manual test (validates DB + Slack path via TEST_ALERT):"
echo "  set -a; . /etc/revhero/send-pipeline-monitor.env; set +a; TEST_ALERT=true python3 /usr/local/bin/send-pipeline-monitor.py"
echo "[install] Timer run logs:"
echo "  journalctl -u send-pipeline-monitor.service --no-pager -n 50"
