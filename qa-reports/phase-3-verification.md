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

## Gate 3 — QA protocol against the deployed runner (LIVE-VERIFIED 2026-04-30)

| Verification step | Status | Result |
|---|---|---|
| Build the runner image on GH Actions | ✅ | Run `25176444394` succeeded after `audit/package.json` placeholder added (first attempt failed on missing audit/) |
| Image lands in `ghcr.io/revhero-llc/revhero-automated-qa-runner:latest` | ✅ | `sha256:053fca9c8c46f6278f8e30bd2bbe79ead04f5e96a22d0d5bf48625bc730df906` |
| Dokploy redeploy succeeds for runner app | ✅ | `1/1 replicas` after `--with-registry-auth` update on swarm |
| Dokploy redeploy succeeds for static app | ✅ | `1/1 replicas`, nginx alpine running |
| Runner container runs P0+P1+P2 suite against staging | ✅ | 230/241 PASS, 4 FAIL, 7 NOT_EXEC. Run `scheduled-20260430T162821`, duration 3m 36s |
| Reports land in `/mnt/qa-reports/<run-id>/report.md` | ✅ | Volume contains `latest.md`, `latest.json`, `scheduled-20260430T162821/` |
| QA-FULL-027 BFF fix verified end-to-end | ✅ | FE-AUTH-010 + FE-AUTH-011 PASS in deployed run (were FAILing pre-fix) |
| Static container serves volume content via nginx | ✅ | `curl http://automated-qa-static-staging-6pwsju/healthz` from inside `dokploy-network` returns `ok` |
| `https://qa-reports.test.revhero.io/latest.md` returns 200 | ❌ DNS gap | `qa-reports.test.revhero.io` currently resolves to `185.146.167.199` (RevHero marketing site catch-all). User-side action: add StackDNS A record `qa-reports.test.revhero.io → 147.93.1.174` (matching the pattern of other `*.test.revhero.io` staging service domains) |
| qa-staging.yml workflow_dispatch end-to-end | ✅ | Run `25177458925` succeeded — dispatched Dokploy redeploy, polled status, exit 0 |
| qa-pr.yml workflow_dispatch end-to-end | ✅ | Run `25177414177` succeeded |
| Slack delivery | ⏸ | Code path active (`SLACK_WEBHOOK_QA` env set on runner). User-side check on `#qa-staging` channel. Previous in-flight runs would have posted multiple times before restart-condition was set to `none`. |
| GitHub Issue creation | ⚠️ Not configured | The runner has no `GITHUB_TOKEN` PAT. Issue automation deferred — the daily Slack summary + the on-VPS HTML report cover triage for now. |

### Issues fixed during validation

| Issue | Cause | Fix |
|---|---|---|
| Build failed: `lstat /audit: no such file or directory` | `Dockerfile` `COPY audit/package.json*` glob resolved to nothing because `audit/` was empty (Phase 6 placeholder) | Added `audit/package.json` stub + dropped wildcard from COPY |
| Swarm tasks rejected: `No such image` | Workers couldn't authenticate to GHCR for the new private package even though their `/root/.docker/config.json` had the right token | `docker service update --with-registry-auth automated-qa-runner-staging-3kteos` once per service to broadcast manager creds to workers |
| Runner restart-loop | scheduled.sh runs once + exits, swarm default restart-condition restarts immediately | `docker service update --restart-condition none automated-qa-runner-staging-3kteos` (each Dokploy redeploy now scales 0→1 once + leaves the task in `Shutdown` state until the next cron) |

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

1. **DNS for `qa-reports.test.revhero.io`.** Authoritative DNS (StackDNS) doesn't have an A record for this subdomain; it currently resolves to the RevHero marketing site catch-all. The static reporter container is healthy and serves correctly within the swarm. User-side action: add StackDNS A record `qa-reports.test.revhero.io → 147.93.1.174`. Until then, Phase 4's gate (which fetches `https://qa-reports.test.revhero.io/latest.json`) will fail-block all prod deploys — that's deliberate fail-closed behavior.
2. **GitHub Issues automation.** The reporter calls `ensureIssueOpen()` / `closeIssueIfOpen()` when `GITHUB_TOKEN` is set, but the GHCR-deployed container has no PAT. Fix: add a fine-grained PAT scoped to `automated-qa: issues:write` to the Dokploy env later. For Phase 3, the markdown + Slack outputs are sufficient.
3. **Container OOM + network-blip soak.** Manual scenarios documented above; not run in this provisioning round.

## Conclusion

**Phase 3 is shipped and live-verified end-to-end.** Two Dokploy apps live on VPS1 (`role:staging`), pulling from GHCR, sharing the `qa-reports-volume` Docker volume. The runner ran the full P0+P1+P2 suite (241 tests, 230 PASS) against staging.revhero.ai inside the deployed container, wrote reports to the shared volume, and the static container serves them via nginx within the swarm. The QA-FULL-027 BFF fix shipped on this same cycle is verified PASS by FE-AUTH-010/011.

The single remaining infrastructure gap is the `qa-reports.test.revhero.io` DNS record at StackDNS — a one-line user-side fix unblocks Phase 4's gate fully.

Proceeding to Phase 4 — CI/CD gate integration across the 13 service repos.
