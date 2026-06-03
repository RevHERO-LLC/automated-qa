# Opens staging->main PRs for the remaining 12 service repos that activate
# the automated-qa gate. Run after the canary (Activity-service PR #4) merges
# and the gate fires cleanly end-to-end.

$body = @"
## Summary

Activates the automated-qa prod-deploy gate on this repo. Follows the canary merge of [Activity-service PR #4](https://github.com/RevHERO-LLC/RevHero-Activity-service/pull/4).

## What this changes

``.github/workflows/deploy-prod.yml`` gets two new jobs:
- ``qa-gate`` (runs first, blocks build): fetches ``https://qa-reports.test.revhero.io/latest.json``, cross-references each FAIL with ``registry.json``'s severity field, exits 1 on any ``severity: critical`` fail. Non-CRITICAL fails surface a warning but don't block.
- ``notify`` (``if: always()`` after deploy): calls the centralised reusable workflow at ``RevHERO-LLC/automated-qa/.github/workflows/notify-prod-deploy.yml@main`` which polls Dokploy ``application.status`` for up to 5min then posts ONE Slack message in the success / failure / timeout format catalogue.

Existing ``build-and-deploy`` job gets ``needs: qa-gate`` so the deploy waits for the gate.

## Test plan

- [ ] Merge fires the new ``deploy-prod.yml``
- [ ] ``qa-gate`` job fetches the latest QA report, cross-refs registry, exits 0 (no CRITICAL fails currently)
- [ ] ``build-and-deploy`` builds + pushes to GHCR + triggers Dokploy redeploy
- [ ] ``notify`` job polls Dokploy until healthy and posts a ``:white_check_mark:`` message to ``#deploys`` Slack
- [ ] Service URL responds 200 after deploy

## Reference

Canonical pattern lives at ``automated-qa/.github/workflows/notify-prod-deploy.yml@main``. Future updates to the message format or polling logic land there once and fan out to all 13 service repos automatically.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
"@

$repos = @(
  "RevHero-users-service",
  "RevHero-user-fe-backend",
  "RevHero-FE-New",
  "RevHERO-Super-Admin-Portal",
  "RevHero-campaign-service",
  "RevHero-deals-actions-service",
  "RevHero-dealmover-v3",
  "Revhero-Generic-Ai-Agent",
  "RevHero-cloud-documents-service",
  "RevHero-pipedrive-v3",
  "RevHero-email-ingress",
  "RevHero-sms-service"
)

foreach ($r in $repos) {
  $existing = gh pr list --repo "RevHERO-LLC/$r" --base main --head staging --state open --json number 2>$null | ConvertFrom-Json
  if ($existing -and $existing.Count -gt 0) {
    Write-Output ("$r already has open PR #" + $existing[0].number)
    continue
  }
  $url = gh pr create --repo "RevHERO-LLC/$r" --base main --head staging --title "ci(deploy-prod): activate automated-qa gate + notify" --body $body 2>&1 | Out-String
  Write-Output ("$r -> " + $url.Trim())
}
