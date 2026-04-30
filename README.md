# RevHero Automated QA

Playwright + Vitest test suite, scheduled QA runner deployed on VPS1, and a Claude Code audit agent on VPS2 that watches for missing or outdated test coverage every 14 days.

## What this repo ships

| Component | Where | What it does |
|---|---|---|
| **Runner** | `runner/` | 449 Playwright + Vitest tests covering ~448 active registry IDs across the FE + 12 backend services. Runs in a container deployed by Dokploy on VPS1 (`role:staging`). |
| **Audit agent** | `audit/` | Claude Code agent on VPS2 that scans all 13 service repos every 14 days, opens `[QA-AUDIT-MISSING]` / `[QA-AUDIT-STALE]` issues for coverage gaps and drift. |
| **Shared helpers** | `shared/` | Slack message catalogs, GitHub-Issues helpers, registry schema (`zod`), env-var loader. Used by both runner and audit. |
| **CI workflows** | `.github/workflows/` | `qa-staging.yml` (cron daily + workflow_dispatch), `qa-pr.yml` (per-PR slice), `deploy.yml` (build + push to GHCR + Dokploy redeploy), `notify-prod-deploy.yml` (reusable workflow called by all 13 service repos' `deploy-prod.yml`), `ci.yml` (PR typecheck). |
| **Registry** | `registry.json` | Canonical map of every test case: id, description, area, role, severity, tags, deps, last_audited_at. Generated from `RevHero-FE-New/qa-test-cases/test-registry.md` via `scripts/build-registry.ts`. |

## Quick start (local dev)

```sh
# Clone + install (workspace pulls runner + shared + audit deps)
git clone https://github.com/RevHERO-LLC/automated-qa.git
cd automated-qa
pnpm install --frozen-lockfile
pnpm -C runner exec playwright install --with-deps chromium

# Configure env (creds live here only — never commit .env)
cp .env.example .env
# Fill in:
#   STAGING_BASE_URL=https://staging.revhero.ai
#   STAGING_BFF_URL=https://user-fe-backend.test.revhero.io
#   ADMIN_EMAIL=test@yopmail.com
#   ADMIN_PASSWORD=...
#   SUPABASE_POOLER_URL=postgresql://... (must be the revhero_users-service DB on port 5432)

# Run the P0 slice (51 tests, ~3 min)
pnpm test:p0

# Run the full suite (449 tests, ~10 min)
pnpm test
```

Reports drop to `runner/reports/<run-id>/`. Failure screenshots go to `runner/reports/<run-id>/screenshots/`. The deployed runner shares the same writes to `qa-reports.test.revhero.io`.

## How the CI/CD gate works

```
                    ┌────────────────────────────────────────┐
                    │  GitHub Actions cron (2 AM ET)          │
                    │  qa-staging.yml                         │
                    └────────────┬───────────────────────────┘
                                 │ workflow_dispatch
                                 ▼
              ┌──────────────────────────────────────────────┐
              │ Dokploy application.deploy                    │
              │ runs ghcr.io/revhero-llc/automated-qa-runner  │
              │ on VPS1 (role:staging) → writes report.md +   │
              │ report.json into the shared qa-reports-volume │
              └──────────────────────────────────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                                     ▼
  qa-reports.test.revhero.io               qa-staging.yml continues:
  (nginx sidecar, autoindex)               • fetch latest.json
                                            • cross-ref severity from registry
                                            • open / reopen / close issues via
                                              auto-scoped GITHUB_TOKEN
                                            • exit 1 if any CRITICAL fails

           ┌────────────────────────────────────────────────────┐
           │  13 service repos' deploy-prod.yml                 │
           │  qa-gate job (runs first):                         │
           │    • curl https://qa-reports.test.revhero.io/      │
           │      latest.json                                   │
           │    • cross-ref registry severity                   │
           │    • exit 1 on any CRITICAL FAIL → deploy blocks   │
           └────────────────────────────────────────────────────┘
```

| Severity → status mapping | Behavior |
|---|---|
| `severity: critical` failing | Prod deploy **blocked** — qa-gate exits 1 |
| `severity: high` / `medium` / `low` failing | Deploy proceeds, GitHub Issue stays open until fixed |

## Fixture catalog (runner/fixtures/)

| Fixture | Purpose |
|---|---|
| `auth.ts` | `loginAs(role)` returns a logged-in `BrowserContext`. Authenticates via the BFF API (`/v1/auth/login`) instead of the React form (avoids hydration race + GET-form-submit credential leak). Sets `token` + `refresh_token` cookies on `staging.revhero.ai` (FE reads them) AND mirrors the JWT into `localStorage`. Has a 429-aware retry-with-wait so accumulated rate-limit pollution from prior runs doesn't fail the first BFF login. Sessions cached at `runner/.sessions/<role>.json` (gitignored). |
| `api.ts` | Axios clients for BFF, sms-service, deal-mover, email-ingress. Multi-cookie Set-Cookie parser handles backends that comma-join cookies into one header. Login / register / forgot-password / reset-password / refresh-token helpers. `internalServicesAuthHeader()` for the `INTERNAL_SERVICES_WEBHOOK_SECRET` shared-secret middleware. |
| `db.ts` | Supabase pooled-mode client (port 5432, NEVER 6543 — breaks GORM prepared statements). `findUserByEmail` joins `users` with `accounts_users`. Helpers for campaigns, deals, messages. |
| `cleanup.ts` | LIFO callback registry. `withCleanup(async c => { c.add(...); ... })` wrapper guarantees teardown runs even on test failure. |
| `seed.ts` | Idempotent baseline assertions for the seeded test admin (Maggie). |
| `dom.ts` | `expectVisible`, `expectCount`, `expectMinCount`. Vitest doesn't ship Playwright's locator matchers, so we wrap `waitFor()` calls. |
| `toky.ts` | Toky inbound webhook replay. Decrypts `basic_auth_password` from `carrier_credentials` via AES-256-GCM (12-byte nonce + 16-byte tag, key from `ENCRYPTION_KEY` hex), POSTs synthetic Toky payloads to `/v1/messages/webhook/toky/incoming`. |
| `deal-mover.ts` | `triggerSweep()` POSTs to `/v1/sweeper/run` with `INTERNAL_SERVICES_WEBHOOK_SECRET`. `waitForDealMoved()` polls until a deal advances stage. |
| `sentiment.ts` | `waitForMessageSentiment` / `waitForEmailSentiment` — async wait helpers (max 90s with backoff) for the AI scorer to mutate the `sentiment` column. |

## How to add a new test

1. **Find the test case in `registry.json`** by its ID. If it doesn't exist yet, the audit agent will surface it as a `[QA-AUDIT-MISSING]` issue on its next 14-day cycle, OR you can add the entry manually:
   ```json
   {
     "id": "FE-CAMP-021",
     "description": "Saving stage with empty title fails validation",
     "area": "Campaign Builder",
     "role": "ADMIN",
     "type": "functional",
     "severity": "high",
     "destructive": false,
     "deps": [],
     "tags": ["p1"],
     "file": null,
     "last_audited_at": null
   }
   ```

2. **Write the test** in the right `runner/tests/<area>/` file. Test names MUST start with the registry ID so the reporter matches:
   ```ts
   test("FE-CAMP-021 — Saving stage with empty title fails validation", async () => {
     const { page, context } = await loginAs("ADMIN");
     try {
       await page.goto("/automation-campaign/4", { waitUntil: "networkidle" });
       // ...
     } finally {
       await context.close();
     }
   });
   ```

3. **Update `registry.json` `file:` field** to point at the test file once the test exists. The audit agent's `stale-detect` cycle uses this to know which tests have implementations.

4. **Test locally:**
   ```sh
   pnpm exec vitest run --reporter=./lib/reporter.ts tests/campaign/fe-camp.test.ts
   ```

5. **Push to a PR** — `qa-pr.yml` will dispatch the runner against your branch (workflow_dispatch with `ref` input).

## Test conventions

- **Severity → CI behavior.** `severity: critical` blocks prod deploys. `high` / `medium` / `low` open issues but don't block. Set thoughtfully — `critical` is for anti-enumeration, login rate-limit, IDOR, SQL injection, payment integrity, multi-tenant isolation. Functional bugs are usually `high`.
- **Tags.** `@paid` tests run only when `QA_RUN_PAID=1` (avoids touching real payment processors). `@needs-toky`, `@needs-pipedrive`, `@needs-google-oauth` mark fixtures that need external creds. The CI gate skips tagged tests cleanly.
- **Avoid the FE login form for fixture purposes.** Use `loginAs(role)` (which hits the BFF API). Tests that explicitly verify the FORM (e.g., FE-AUTH-019 spinner, FE-AUTH-020 rate limit) interact with the form directly and use deliberately-wrong credentials so they don't burn rate-limit budget on the real test admin.
- **Cleanup is mandatory.** Use `withCleanup` or pass a cleanup registry into your test. Per-test cleanup registers in LIFO order — tests that create rows clean them up on exit.
- **No data assumptions.** Maggie has 2 seeded campaigns (id 4 active + id 5 inactive), 3 deals, 1 phone number, 3 SMS messages, a connected Gmail mailbox. Anything beyond those fixtures gets created and cleaned up per-test.

## Common operations

| Action | Command |
|---|---|
| Re-trigger today's QA run from scratch | `gh workflow run qa-staging.yml -R RevHERO-LLC/automated-qa` |
| View latest report | `https://qa-reports.test.revhero.io/latest.md` |
| Browse all run histories | `https://qa-reports.test.revhero.io/` (autoindex) |
| Open issues for current failures | `gh issue list -R RevHERO-LLC/automated-qa --label qa-fail` |
| Manually trigger the audit agent | `ssh root@147.93.1.174 'sudo systemctl start revhero-audit.service'` |
| Re-deploy the runner image after a code change | Push to main → `deploy.yml` builds + pushes to GHCR + Dokploy redeploys |
| Pre-pull a new image on VPS1 worker (if Swarm rejects with "No such image") | `ssh root@62.146.226.197 'docker pull ghcr.io/revhero-llc/...'` then `docker service update --with-registry-auth <swarm-name>` from VPS2 |

## Repository layout

```
automated-qa/
├── runner/              # Playwright + Vitest suite + Dockerfile
│   ├── fixtures/        # auth, api, db, cleanup, seed, dom, toky, deal-mover, sentiment
│   ├── lib/             # context, retry, reporter
│   ├── tests/           # 21 test files, 449 tests
│   ├── runner/          # ci.sh + scheduled.sh
│   ├── Dockerfile       # multi-stage: node:20 builder + Playwright jammy runtime
│   └── package.json
├── audit/               # Phase 6 — VPS2 audit agent
│   ├── audit.sh
│   ├── scripts/run-audit.ts
│   ├── prompts/{coverage-audit,stale-detect}.md
│   ├── systemd/{revhero-audit.service,revhero-audit.timer}
│   ├── repos.json       # all 13 service repos to clone
│   └── README.md        # 10-step setup runbook + re-signin runbook
├── shared/              # cross-cutting helpers
│   └── src/{registry-schema,env,slack,github-issues,index}.ts
├── reporter-static/     # nginx sidecar that serves /mnt/qa-reports
│   ├── Dockerfile
│   ├── default.conf
│   └── index.html
├── .github/workflows/
│   ├── ci.yml                    # PR typecheck
│   ├── deploy.yml                # build + GHCR push + Dokploy redeploy
│   ├── qa-staging.yml            # cron + workflow_dispatch (issue-management lives here)
│   ├── qa-pr.yml                 # per-PR slice
│   └── notify-prod-deploy.yml    # reusable workflow called by 13 service repos
├── scripts/
│   ├── build-registry.ts         # parses test-registry.md → registry.json
│   ├── apply-deploy-gate.py      # one-shot patch for 13 service repos' deploy-prod.yml
│   ├── sync-qa-issues.sh         # called by qa-staging.yml after each run
│   └── setup-vps2-audit.sh       # one-shot bootstrap for the claude-audit user
├── qa-reports/                   # phase verification reports (1-7)
├── docs/
│   └── failure-triage.md         # SOP for triaging a [QA-FAIL] issue
└── registry.json                 # 442 active + 23 descoped (LinkedIn)
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| qa-gate fails-blocks all deploys | DNS not resolving `qa-reports.test.revhero.io` OR the static container is down | Check `dig qa-reports.test.revhero.io +short` returns `147.93.1.174`. If not, fix StackDNS. If DNS is fine, `ssh root@62.146.226.197 'docker service ls \| grep automated-qa-static'` — should show 1/1. |
| Runner exits with 429 from BFF on first login | Rate-limit pollution from prior runs (`LoginMaxAttemptsPerEmail = 10` per 6m) | The fixture's 429-retry-with-wait absorbs this — but if it persists, switch tests to use a fresh fake email or wait the full window. |
| Issues not auto-closing on PASS | Title-match miss (the test description changed) | Manually close the old issue. The next run reopens with the new description. |
| Swarm task `Rejected: No such image` | Worker node hasn't pulled the latest GHCR image | `ssh root@62.146.226.197 'docker pull <image>'`, then `docker service update --with-registry-auth <swarm-name>` from VPS2. |
| `qa-staging.yml` exits 1 with `CRITICAL fail count: N` | Real CRITICAL test failures | Check `https://qa-reports.test.revhero.io/latest.md` for which IDs failed. Triage with `docs/failure-triage.md`. |

## Phase verification reports

`qa-reports/phase-{1..7}-verification.md` document each phase's plan-vs-delivered audit + QA-protocol verification.

## License

Internal — RevHERO-LLC / Anthropic Claude Code Agent.
