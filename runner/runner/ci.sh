#!/usr/bin/env bash
# CI mode — collect every result, exit non-zero only on CRITICAL failures.
# Phase 4 wires this into each service repo's deploy-prod.yml.
set -uo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]] && [[ ! -f ../.env ]]; then
  echo "::warning::no .env file present — relying on injected GitHub Actions env"
fi

QA_RUN_ID="${QA_RUN_ID:-ci-$(date +%Y%m%dT%H%M%S)}"
export QA_RUN_ID

pnpm exec vitest run --reporter=./lib/reporter.ts
test_exit=$?

# Phase 4 will switch this to grep registry.json for severity=critical entries
# and exit non-zero only when one of those FAILed. Phase 1 keeps it simple.
if [[ -f reports/latest.json ]]; then
  failed=$(grep -c '"status": "FAIL"' reports/latest.json || true)
  echo "Failures: $failed"
fi

exit $test_exit
