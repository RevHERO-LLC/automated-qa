#!/usr/bin/env bash
# Cross-references the latest QA report against the registry and manages
# GitHub Issues. Called by .github/workflows/qa-staging.yml after each run.
#
#   - opens [QA-FAIL] issue for any FAIL without an existing one
#   - reopens + comments on a closed [QA-FAIL] issue if the failure recurs
#   - comments on an open [QA-FAIL] issue with the latest run id
#   - closes [QA-FAIL] issues for tests that have flipped back to PASS
#
# Auth: relies on $GH_TOKEN being exported (the workflow's GITHUB_TOKEN).

set -euo pipefail

LATEST_JSON="${1:-/tmp/latest.json}"
REGISTRY="${2:-registry.json}"
REPO="${REPO:-RevHERO-LLC/automated-qa}"

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "GH_TOKEN must be set"
  exit 1
fi

run_id=$(jq -r '.summary.run_id' "$LATEST_JSON")

write_body() {
  # Args: id, sev, area, duration, error
  local id="$1" sev="$2" area="$3" duration="$4" err="$5"
  local out
  out=$(mktemp)
  {
    echo "**Test ID:** ${id}"
    echo "**Severity:** ${sev}"
    echo "**Area:** ${area}"
    echo "**Duration:** ${duration}ms"
    echo "**Run:** \`${run_id}\`"
    echo ""
    echo "### Error"
    echo '```'
    echo "${err}"
    echo '```'
    echo ""
    echo "_Auto-managed by automated-qa qa-staging.yml._"
    echo "[Latest report](https://qa-reports.test.revhero.io/latest.md)"
  } > "$out"
  echo "$out"
}

write_followup() {
  # Args: prefix-message, body-file
  local prefix="$1" body_file="$2"
  local out
  out=$(mktemp)
  {
    echo "$prefix"
    echo ""
    cat "$body_file"
  } > "$out"
  echo "$out"
}

jq -c '.summary.results[]' "$LATEST_JSON" | while read -r row; do
  id=$(echo "$row" | jq -r '.id')
  status=$(echo "$row" | jq -r '.status')
  err=$(echo "$row" | jq -r '.error // ""')
  duration=$(echo "$row" | jq -r '.duration_ms')

  entry=$(jq -r --arg id "$id" '.entries[] | select(.id == $id)' "$REGISTRY")
  desc=$(echo "$entry" | jq -r '.description // ""' | head -c 100)
  sev=$(echo "$entry" | jq -r '.severity // "medium"')
  area=$(echo "$entry" | jq -r '.area // "unknown"')
  title="[QA-FAIL] ${id}: ${desc}"

  existing_json=$(gh issue list --repo "$REPO" --state all \
    --search "in:title \"${title}\"" \
    --json number,state,title --limit 5 2>/dev/null || echo "[]")
  existing_number=$(echo "$existing_json" | jq -r --arg t "$title" '[.[] | select(.title == $t)] | .[0].number // ""')
  existing_state=$(echo "$existing_json" | jq -r --arg t "$title" '[.[] | select(.title == $t)] | .[0].state // ""' | tr '[:upper:]' '[:lower:]')

  body_file=$(write_body "$id" "$sev" "$area" "$duration" "$err")

  if [[ "$status" == "FAIL" ]]; then
    if [[ -z "$existing_number" ]]; then
      echo "Opening new issue for $id"
      gh issue create --repo "$REPO" --title "$title" --body-file "$body_file" \
        --label "qa-fail,severity:${sev},area:${area}" 2>/dev/null \
        || gh issue create --repo "$REPO" --title "$title" --body-file "$body_file"
    elif [[ "$existing_state" == "closed" ]]; then
      echo "Reopening issue #${existing_number} for $id"
      gh issue reopen "$existing_number" --repo "$REPO"
      followup_file=$(write_followup "Reopened — failure recurred in run \`${run_id}\`." "$body_file")
      gh issue comment "$existing_number" --repo "$REPO" --body-file "$followup_file"
    else
      echo "Updating open issue #${existing_number} for $id"
      followup_file=$(write_followup "Still failing in run \`${run_id}\`." "$body_file")
      gh issue comment "$existing_number" --repo "$REPO" --body-file "$followup_file"
    fi
  elif [[ "$status" == "PASS" && -n "$existing_number" && "$existing_state" == "open" ]]; then
    echo "Closing issue #${existing_number} for $id (now passing)"
    close_file=$(mktemp)
    echo "Closed — test now passing in run \`${run_id}\`." > "$close_file"
    gh issue comment "$existing_number" --repo "$REPO" --body-file "$close_file"
    gh issue close "$existing_number" --repo "$REPO"
  fi
done
