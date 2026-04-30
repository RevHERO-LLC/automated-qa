#!/usr/bin/env bash
# Scheduled mode — runs the full suite, posts Slack, opens GitHub Issues.
# Used by Phase 3's daily 2 AM ET cron and the workflow_dispatch trigger.
set -uo pipefail

cd "$(dirname "$0")/.."

QA_RUN_ID="${QA_RUN_ID:-scheduled-$(date +%Y%m%dT%H%M%S)}"
export QA_RUN_ID

pnpm exec vitest run --reporter=./lib/reporter.ts
exit $?
