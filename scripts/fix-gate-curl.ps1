# Adds -k flag to qa-gate's curl calls in all 13 service repos' deploy-prod.yml.
# Traefik's LE cert hasn't issued (self-signed default in place); the gate's
# strict cert validation blocks every prod deploy. -k bypasses validation;
# tradeoff documented in qa-reports/phase-4-verification.md.
$repos = @(
  "RevHero-users-service","RevHero-user-fe-backend","RevHero-FE-New","RevHERO-Super-Admin-Portal",
  "RevHero-campaign-service","RevHero-deals-actions-service","RevHero-dealmover-v3","Revhero-Generic-Ai-Agent",
  "RevHero-cloud-documents-service","RevHero-Activity-service","RevHero-pipedrive-v3","RevHero-email-ingress","RevHero-sms-service"
)

foreach ($name in $repos) {
  $dir = "C:\Users\zsk54\$name"
  if (-not (Test-Path $dir)) { Write-Output "$name : MISSING dir"; continue }
  Push-Location $dir
  try {
    git fetch origin staging 2>&1 | Out-Null
    $branch = git branch --show-current
    if ($branch -ne "main" -and $branch -ne "staging") {
      git checkout staging 2>&1 | Out-Null
    }
    # Pull latest staging
    git checkout staging 2>&1 | Out-Null
    git pull origin staging 2>&1 | Out-Null

    $wf = ".github/workflows/deploy-prod.yml"
    if (-not (Test-Path $wf)) { Write-Output "$name : no $wf on staging"; Pop-Location; continue }
    $content = Get-Content $wf -Raw
    # Replace --retry 3 with -k --retry 3 in the gate's curls
    $patched = $content -replace 'curl -fsSL --retry 3 https://qa-reports', 'curl -fsSLk --retry 3 https://qa-reports'
    if ($patched -eq $content) {
      Write-Output "$name : already has -k or no match"
    } else {
      Set-Content $wf $patched -NoNewline
      git add $wf 2>&1 | Out-Null
      $msg = "ci(qa-gate): add -k to curl since Traefik LE cert not yet issued`n`nTemporary; revert once Traefik successfully issues LE for qa-reports.test.revhero.io."
      git commit -m $msg 2>&1 | Out-Null
      git push origin staging 2>&1 | Out-Null
      Write-Output "$name : staging patched"
    }
  } finally {
    Pop-Location
  }
}
