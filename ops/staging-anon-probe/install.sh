#!/usr/bin/env bash
# install.sh — Install the staging anonymous-access probe (plan P5-D6).
#   sudo bash ops/staging-anon-probe/install.sh
# Then fill /etc/revhero/staging-anon-probe.env (SLACK_WEBHOOK). Secrets are not in this repo.
# NOT run by CI or by merging this repo — installing is a deliberate, separate step.
#
# READ README.md "Where to run it" FIRST: from a host that is on the edge allowlist (VPS2 is) the probe describes the
# application layer, not the public edge.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "[install] staging-anon-probe installation..."

for cmd in curl jq date sha256sum mktemp; do
  command -v "$cmd" >/dev/null || { echo "[install] ERROR: '$cmd' not found." >&2; exit 1; }
done
echo "[install] deps OK (curl jq date sha256sum mktemp)."

cp "${SCRIPT_DIR}/probe-staging-anon.sh" /usr/local/bin/probe-staging-anon.sh
chmod 0755 /usr/local/bin/probe-staging-anon.sh
echo "[install] script -> /usr/local/bin/probe-staging-anon.sh"

cp "${SCRIPT_DIR}/staging-anon-probe.service" /etc/systemd/system/staging-anon-probe.service
cp "${SCRIPT_DIR}/staging-anon-probe.timer"   /etc/systemd/system/staging-anon-probe.timer
chmod 0644 /etc/systemd/system/staging-anon-probe.service /etc/systemd/system/staging-anon-probe.timer
echo "[install] units installed."

mkdir -p /etc/revhero
ENV_FILE="/etc/revhero/staging-anon-probe.env"
if [[ -f "${ENV_FILE}" ]]; then
  echo "[install] ${ENV_FILE} exists — leaving it untouched."
else
  cp "${SCRIPT_DIR}/staging-anon-probe.env.example" "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
  echo "[install] wrote ${ENV_FILE} skeleton — set SLACK_WEBHOOK before the timer fires."
fi

TARGETS="/etc/revhero/staging-anon-probe.targets"
if [[ -f "${TARGETS}" ]]; then
  echo "[install] ${TARGETS} exists — leaving it untouched. Compare with the repo copy:"
  echo "          diff ${TARGETS} ${SCRIPT_DIR}/staging-anon-probe.targets"
else
  cp "${SCRIPT_DIR}/staging-anon-probe.targets" "${TARGETS}"
  chmod 0644 "${TARGETS}"
  echo "[install] targets -> ${TARGETS} (edit it to add or remove routes; staging hosts only)."
fi

mkdir -p /var/lib/staging-anon-probe
systemctl daemon-reload
systemctl enable --now staging-anon-probe.timer
echo "[install] done."
echo ""
systemctl list-timers staging-anon-probe.timer --no-pager || true
echo ""
echo "[install] FIRST (proves the body classifier against THIS host's jq):  bash ${SCRIPT_DIR}/test-probe.sh"
echo "[install] The first scheduled run alerts for every route that is open today, and repeats until each is fixed or removed from ${TARGETS}."
echo ""
echo "[install] Manual tests (none of them touches the Slack state):"
echo "  # 1. print the table, post nothing:"
echo "  PROBE_NO_SLACK=1 /usr/local/bin/probe-staging-anon.sh       # exit 0 clean | 3 a route answered 2xx | 4 could not evaluate | 2 config"
echo "  # 2. validate the Slack path:"
echo "  set -a; . ${ENV_FILE}; set +a; TEST_ALERT=true /usr/local/bin/probe-staging-anon.sh"
echo "  journalctl -u staging-anon-probe.service --no-pager -n 80"
echo "  systemctl --failed        # a FAILED unit here = the probe itself is broken (no webhook / Slack down / no curl or jq / bad targets)"
echo ""
echo "[install] WHERE THIS RUNS MATTERS. If this host's public IP is on the edge allowlist, the probe sees the application"
echo "          layer only. See README.md, 'Where to run it'."
