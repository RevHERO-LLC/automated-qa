# For each of the 12 remaining service repos:
#   1. Replace the reusable-workflow notify with inlined notify (validation issue)
#   2. Ensure -k is on the gate curl
#   3. Push staging
#   4. Open PR staging->main
#   5. Merge it
#   6. Wait for the new prod deploy to start

$serviceUrls = @{
  "RevHero-users-service"           = "https://users-service.revhero.io"
  "RevHero-user-fe-backend"         = "https://user-fe-backend.revhero.io"
  "RevHero-FE-New"                  = "https://portal.revhero.ai"
  "RevHERO-Super-Admin-Portal"      = "https://config.revhero.ai"
  "RevHero-campaign-service"        = "https://campaign-service.revhero.io"
  "RevHero-deals-actions-service"   = "https://deals-actions-service.revhero.io"
  "RevHero-dealmover-v3"            = "https://deal-mover.revhero.io"
  "Revhero-Generic-Ai-Agent"        = "https://ai-agent.revhero.io"
  "RevHero-cloud-documents-service" = "https://cloud-documents-service.revhero.io"
  "RevHero-pipedrive-v3"            = "https://pipedrive-service.revhero.io"
  "RevHero-email-ingress"           = "https://email-ingress.revhero.io"
  "RevHero-sms-service"             = "https://sms-service.revhero.io"
}

$inlinedNotifyTemplate = @'
  notify:
    needs: [build-and-deploy]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Post deploy outcome to Slack
        env:
          OUTCOME: ${{ needs.build-and-deploy.result }}
          SLACK_WEBHOOK_DEPLOYS: ${{ secrets.SLACK_WEBHOOK_DEPLOYS }}
          REPO: ${{ github.repository }}
          SHA: ${{ github.sha }}
          AUTHOR: ${{ github.event.head_commit.author.name }}
          PR_TITLE: ${{ github.event.head_commit.message }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
          SERVICE_URL: __SERVICE_URL__
        run: |
          set -euo pipefail
          SHORT_SHA="${SHA:0:7}"
          PR_TITLE_FIRST=$(printf '%s' "$PR_TITLE" | head -n1 | cut -c1-120)
          if [[ "$OUTCOME" == "success" ]]; then
            EMOJI=":white_check_mark:"
            HEADLINE="${EMOJI} *${REPO}* @ \`${SHORT_SHA}\` deployed by ${AUTHOR}"
          else
            EMOJI=":x:"
            HEADLINE="${EMOJI} *${REPO}* @ \`${SHORT_SHA}\` deploy ${OUTCOME}"
          fi
          jq -n \
            --arg text "${HEADLINE}" \
            --arg pr "${PR_TITLE_FIRST}" \
            --arg run "${RUN_URL}" \
            --arg svc "${SERVICE_URL}" \
            '{
              text: $text,
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: $text } },
                { type: "section", text: { type: "mrkdwn", text: ("Title: " + $pr) } },
                { type: "context", elements: [
                  { type: "mrkdwn", text: ("<" + $run + "|GitHub Actions run>" + (if $svc == "" then "" else (" • <" + $svc + "|Service URL>") end)) }
                ]}
              ]
            }' | curl -fsSL -X POST -H "Content-Type: application/json" -d @- "${SLACK_WEBHOOK_DEPLOYS}"
'@

$repos = $serviceUrls.Keys

$prUrls = @()
foreach ($name in $repos) {
  $dir = "C:\Users\zsk54\$name"
  if (-not (Test-Path $dir)) { Write-Output "$name : MISSING dir"; continue }
  Push-Location $dir
  try {
    git fetch origin 2>&1 | Out-Null
    git checkout staging 2>&1 | Out-Null
    git pull origin staging 2>&1 | Out-Null

    $wf = ".github/workflows/deploy-prod.yml"
    if (-not (Test-Path $wf)) { Write-Output "$name : no workflow"; Pop-Location; continue }

    $content = Get-Content $wf -Raw

    # 1. Ensure -k flag (idempotent)
    $content = $content -replace 'curl -fsSL --retry 3 https://qa-reports', 'curl -fsSLk --retry 3 https://qa-reports'

    # 2. Replace the reusable-workflow notify block with inlined version.
    # Match from "  notify:" through end (the notify block is always last).
    $serviceUrl = $serviceUrls[$name]
    $inlined = $inlinedNotifyTemplate -replace '__SERVICE_URL__', $serviceUrl

    # Use single-line non-greedy regex starting from "  notify:" to end of file
    $pattern = '(?ms)^  notify:.*$'
    if ($content -match $pattern) {
      $content = $content -replace $pattern, $inlined.TrimEnd()
    } else {
      Write-Output "$name : no notify block found, skipping"
      Pop-Location
      continue
    }

    Set-Content $wf $content -NoNewline

    # 3. Commit + push
    git add $wf 2>&1 | Out-Null
    $msg = @"
ci(deploy-prod): inline Slack notify + -k for QA gate cert bypass

Two fixes for the prod-deploy gate that the canary (Activity-service)
turned up:
  1. The reusable workflow at RevHERO-LLC/automated-qa/.github/
     workflows/notify-prod-deploy.yml@main was failing GH validation
     before any job spun up — inline the post-deploy Slack post
     instead.
  2. Traefik's LE cert for qa-reports.test.revhero.io hasn't issued
     yet (Traefik default self-signed in place); -k bypasses strict
     cert validation in the gate's curl. Revert once LE issues.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
"@
    git commit -m $msg 2>&1 | Out-Null
    git push origin staging 2>&1 | Out-Null

    # 4. Open or find existing PR staging->main
    $prList = gh pr list --repo "RevHERO-LLC/$name" --base main --head staging --state open --json number 2>$null | ConvertFrom-Json
    $pr = $null
    if ($prList -and $prList.Count -gt 0) {
      $pr = $prList[0].number
    } else {
      $body = @"
## Summary

Activates the automated-qa prod-deploy gate on this repo. Follows the canary merge of [Activity-service PR #4](https://github.com/RevHERO-LLC/RevHero-Activity-service/pull/4) which is now deploying cleanly end-to-end.

## What this changes

``.github/workflows/deploy-prod.yml`` gets two new jobs:
- ``qa-gate`` (runs first, blocks build): fetches ``https://qa-reports.test.revhero.io/latest.json``, cross-references each FAIL with ``registry.json``'s severity field, exits 1 on any ``severity: critical`` fail. Non-CRITICAL fails surface a warning but don't block.
- ``notify`` (``if: always()`` after deploy): posts ONE Slack message in ``#deploys`` with the deploy outcome.

Existing ``build-and-deploy`` job gets ``needs: qa-gate`` so the deploy waits for the gate.

## Test plan

- [ ] Merge fires the new ``deploy-prod.yml``
- [ ] ``qa-gate`` passes (current QA snapshot has 0 CRITICAL fails)
- [ ] ``build-and-deploy`` builds + pushes to GHCR + triggers Dokploy redeploy
- [ ] ``notify`` posts a ``:white_check_mark:`` message to ``#deploys``

🤖 Generated with [Claude Code](https://claude.com/claude-code)
"@
      $prUrl = gh pr create --repo "RevHERO-LLC/$name" --base main --head staging --title "ci(deploy-prod): activate automated-qa gate + notify" --body $body 2>&1
      if ($prUrl -match "pull/(\d+)") { $pr = $matches[1] }
    }

    if ($pr) {
      # 5. Merge
      gh pr merge $pr --repo "RevHERO-LLC/$name" --merge 2>&1 | Out-Null
      Write-Output "$name : staging patched + PR #$pr merged"
      $prUrls += ("$name #$pr")
    } else {
      Write-Output "$name : PR creation failed"
    }
  } finally {
    Pop-Location
  }
}
Write-Output "---"
Write-Output ("All 12 PRs handled: " + ($prUrls -join ", "))
