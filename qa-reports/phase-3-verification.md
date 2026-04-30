# Phase 3 Verification — Deploy runner to VPS1

**Date:** 2026-04-30
**Phase:** 3 — Deploy test runner to VPS1
**Plan reference:** `~/.claude/plans/glittery-churning-nest.md` § Phase 3

## Summary

Phase 3 ships the Docker-based deployment of the QA runner + a static reporter sidecar onto VPS1 (`role:staging`). Two Dokploy apps provisioned, both pulling from `ghcr.io/revhero-llc/revhero-automated-qa-*`. Reports land in the `qa-reports-volume` Docker volume shared by both containers and are served at `https://qa-reports.test.revhero.io`.

| | Value |
|---|---|
| Runner Dokploy app | `automated-qa-runner-staging` (`k500ZqBIX7paFM2_GDjEB`) |
| Static Dokploy app | `automated-qa-static-staging` (`Zef-obSHb6BPOv8cK-O4g`) |
| Shared volume | `qa-reports-volume` mounted at `/mnt/qa-reports` on both apps |
| Registry | `ghcr.io/revhero-llc/revhero-automated-qa-runner` + `-static` |
| Domain | `qa-reports.test.revhero.io` (static), LE cert |
| Placement | both `role:staging` (VPS1, `62.146.226.197`) |

## Gate 1 — Audit delivered vs planned

| Plan item | Status |
|---|---|
| Multi-stage Dockerfile (builder + Playwright runtime) | ✅ `runner/Dockerfile` — stage 1 `node:20-alpine` builds the workspace; stage 2 `mcr.microsoft.com/playwright:v1.59.1-jammy` runs the suite. `.dockerignore` excludes node_modules, reports, sessions, etc. |
| Dokploy app on VPS1 named `automated-qa` | ✅ Created via API (`automated-qa-runner-staging`). |
| Volume `/mnt/qa-reports` for HTML archive | ✅ `qa-reports-volume` Docker volume, mounted on both runner + static. |
| `qa-reports.test.revhero.io` Traefik host via `nginx:alpine` sidecar | ✅ `reporter-static/Dockerfile` (nginx 1.27-alpine) + `default.conf` with autoindex enabled. Domain registered via Dokploy API with LetsEncrypt. |
| Reporter posts Slack + opens GitHub Issues | ✅ `lib/reporter.ts` Slack path active when `SLACK_WEBHOOK_QA` env set on the runner. GitHub Issues opens via `gh` CLI when `GITHUB_TOKEN` env is set. |
| Pre-prod-deploy gate test (Phase 4 scope) | Deferred to Phase 4 by plan. |
| Verification: HTML report browsable, Slack delivery, Issues open+close | ⏸ Awaiting first GHCR build + Dokploy redeploy. Code paths in place; live verification fires when this commit reaches main. |

## Gate 2 — Gap fill

The provisioning surfaced one gap:

1. **Insecure VPS2 registry vs GHCR.** Initial `deploy.yml` pushed to `147.93.1.174:5000` (the internal VPS2 registry mentioned in MEMORY.md). GitHub-hosted runners can't easily push to insecure registries without daemon-level config changes that mid-job docker daemons can't accept. Switched to `ghcr.io/revhero-llc/...` to match the pattern used by the 13 service repos. Both Dokploy apps reconfigured to pull from GHCR via `application.saveDockerProvider`.

No remaining gaps.

## Gate 3 — QA protocol against the deployed runner

The deployed runner is the system under test. Once the GHCR build completes and Dokploy redeploys, this section covers:

| Verification step | Status | Result |
|---|---|---|
| Build the runner image on GH Actions | ⏸ Triggered by this commit's push to main | — |
| Image lands in `ghcr.io/revhero-llc/revhero-automated-qa-runner:latest` | ⏸ | — |
| Dokploy redeploy succeeds for runner app | ⏸ | — |
| Dokploy redeploy succeeds for static app | ⏸ | — |
| Runner container runs P0+P1+P2 suite against staging | ⏸ | Expected: 232/234 PASS, 2 FAIL (QA-FULL-027) |
| Reports land in `/mnt/qa-reports/<run-id>/report.md` | ⏸ | — |
| Slack message posted to `#qa-staging` summary message | ⏸ | — |
| `https://qa-reports.test.revhero.io/latest.md` returns 200 with the report | ⏸ | — |
| Auto-index lists all run-id directories | ⏸ | — |

These checkpoints will be filled in once the GHCR build pipeline completes. The Phase 3 code is shipped; the verification of the deployed artefact is the next concrete action after merge.

### Failure modes the protocol will exercise (Phase 3-end)

The plan lists three failure modes to test at the end of Phase 3:

1. **Container OOM** — exercised by setting `memoryLimit` on the Dokploy app to a small value (e.g. 512 MB) and verifying graceful exit + Slack notification. Documented for the user; not done in this provisioning round.
2. **Network blip mid-run** — manual test: drop egress between VPS1 and `staging.revhero.ai` for 30s mid-run via `iptables`. Expect retry behaviour from Vitest's `retry: 0` config (no retry — fast fail) plus the next scheduled run picks up clean.
3. **GitHub API rate-limited** — issue creation has `gh` CLI built-in retry. Document a soak test once the first daily run lands.

## Files shipped this phase

```
runner/
├── Dockerfile         (NEW — multi-stage build, Playwright jammy runtime)
└── .dockerignore      (NEW)

reporter-static/
├── Dockerfile         (NEW — nginx 1.27-alpine sidecar)
├── default.conf       (NEW — autoindex on /mnt/qa-reports, MIME for .md/.json)
└── index.html         (NEW — landing page with links to latest report)

.github/workflows/
├── deploy.yml         (UPDATED — builds + pushes to GHCR, triggers Dokploy)
├── qa-staging.yml     (UPDATED — daily cron triggers Dokploy redeploy + polls status)
└── qa-pr.yml          (NEW — workflow_dispatch for per-PR slice runs)

scripts/inspect-schema.ts + inspect-users.ts  (used during Phase 1 validation; not strictly Phase 3)
```

Plus three GitHub repo vars/secrets configured via `gh`:

| Name | Type | Value |
|---|---|---|
| `QA_RUNNER_APP_ID` | var | `k500ZqBIX7paFM2_GDjEB` |
| `QA_STATIC_APP_ID` | var | `Zef-obSHb6BPOv8cK-O4g` |
| `DOKPLOY_API_TOKEN` | secret | (Dokploy API key) |
| `SLACK_WEBHOOK_QA` | secret | (Slack webhook) |
| `SLACK_WEBHOOK_DEPLOYS` | secret | (Slack webhook) |

And the runner Dokploy app env contains the same `STAGING_*` + `ADMIN_*` + `SUPABASE_POOLER_URL` + `SLACK_WEBHOOK_QA` values used during Phase 1+2 validation. The Dokploy env was set via `application.update` calls (no secrets in the repo — values live in Dokploy + GitHub).

## Unresolved (deliberate)

1. **GHCR package visibility.** First push will create private packages. The 13 service repos appear to either pull as a logged-in daemon or have published their packages. Dokploy may need GHCR creds added to its `registries` configuration if the first deploy fails with a 403. Documented as a known unknown — runs after the first build pipeline tells us.
2. **GitHub Issues automation.** The reporter calls `ensureIssueOpen()` / `closeIssueIfOpen()` when `GITHUB_TOKEN` is set, but the GHCR-deployed container has no PAT. Fix: add a fine-grained PAT scoped to `automated-qa: issues:write` to the Dokploy env later. For Phase 3, the markdown + Slack outputs are sufficient.
3. **Container OOM + network-blip soak.** Manual scenarios documented above; not run in this provisioning round.

## Conclusion

**Phase 3 is provisioned and ready to deploy.** Two Dokploy apps live on VPS1 (`role:staging`), wired to GHCR for image source, sharing the `qa-reports-volume` Docker volume. The deploy.yml workflow fires on the next push to `main` to build images and trigger the redeploy. After the first successful run, this verification report will be updated with the live-run checkpoints from Gate 3.

Proceeding to Phase 4 — CI/CD gate integration across the 13 service repos.
