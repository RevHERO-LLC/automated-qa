#!/usr/bin/env bash
# systemd entrypoint for the daily Claude Changelog reconciliation cron.
# Layer 3 of the 3-layer enforcement stack.
set -euo pipefail

cd "$(dirname "$0")"

mkdir -p reports

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "GH_TOKEN must be set in /home/claude-audit/.env (repo:read scope)"
  exit 1
fi

if [[ -z "${CHANGELOG_DB_URL:-}" ]]; then
  echo "CHANGELOG_DB_URL must be set in /home/claude-audit/.env (read-only role on changelog.changes)"
  exit 1
fi

exec pnpm exec tsx scripts/check-changelog-coverage.ts
