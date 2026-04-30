# Failure Triage SOP

When a `[QA-FAIL]` or `[QA-AUDIT-MISSING]` / `[QA-AUDIT-STALE]` issue appears in `RevHERO-LLC/automated-qa`, here's how to figure out what's actually wrong and route it to a fix.

## Triaging a `[QA-FAIL]` issue

These are auto-opened by `qa-staging.yml` whenever a test FAILs. The body has the test ID, severity, area, run ID, and the captured error.

### Step 1 — Reproduce locally first

Don't trust a single CI run. Re-run the same test against staging from your dev machine:

```sh
cd ~/automated-qa
QA_RUN_ID=triage-$(date +%s) pnpm exec vitest run --reporter=./lib/reporter.ts \
  tests/<area>/<file>.test.ts -t "<test-id>"
```

If it passes locally, it's likely flake. The issue auto-closes on the next run that flips it to PASS — leave it open and watch.

### Step 2 — Categorise

Look at the error message in the issue body:

| Error contains | Most likely cause | Where to look |
|---|---|---|
| `429 too many login attempts; scope: email` | Rate-limit pollution from prior runs | `runner/fixtures/auth.ts` — the 429-retry-with-wait absorbs most cases. If a CI run hit 10+ logins in 6m, the rate limiter is doing its job. Move on. |
| `429 ... scope: ip` | IP-level rate limit (30/window) | Same as above but at the network level. The deployed runner is on VPS1 — if multiple services share the IP, this can pile up. Spread test runs across more time. |
| `expected 5xx to be 200` / `expected 4xx to be 200` | Real backend bug (the test is doing its job) | The error body usually has the response payload. Cross-check the BFF endpoint code in the relevant service repo. |
| `Timeout 30000ms exceeded` waiting for navigation | Either a slow staging page (see QA-FULL-029) OR a selector that no longer matches | Open the live page and look for the element. If staging is slow, the test's threshold should be relaxed; if the element is gone, the test needs an update. |
| `locator.click: ... waiting for ...` | Selector drift | Look at the FE component the test references. The element may have been renamed / restructured. Update the selector OR file a `[QA-AUDIT-STALE]` issue (the audit agent does this automatically every 14 days). |
| `expected ... to include 500` | The BFF returned 500 where a 4xx is expected | This is a real BFF bug. Check the handler — likely missing `MapServiceErrorStatus` (round-7 pattern). Examples: QA-FULL-027 was the auth handler; if a new one shows up, file a separate finding. |

### Step 3 — Fix the right thing

| The test is wrong (selector drift, threshold too tight) | Update the test, push to staging, the next run auto-closes the issue. |
| The product code is wrong | File a normal bug ticket in the relevant service repo's issue tracker. Reference the `[QA-FAIL]` issue. Branch off the service's `staging`, fix, PR. Once the fix lands, the next QA run auto-closes the issue. |
| The test is genuinely stale (registry out of sync with reality) | Update `registry.json`. Push. Next audit cycle stamps `last_audited_at`. |
| The failure is a known-blocked external (e.g., Google OAuth redirect URI) | Add the appropriate `@external-blocked` / `@needs-...` tag to the registry entry. Test moves to `NOT_EXEC` instead of `FAIL`. |

### Step 4 — Don't suppress without evidence

`expect(true).toBe(true)` is fine for smoke markers, but if you find yourself loosening a real assertion to make a CI run pass, you're masking a real bug. Talk to the dev team first.

## Triaging a `[QA-AUDIT-MISSING]` issue

These are auto-opened by the Phase 6 agent every 14 days. Body contains:
- A draft registry entry
- A scaffolded Playwright test file body
- The path where it should live (e.g., `runner/tests/campaign/fe-camp.test.ts`)
- A one-line rationale citing the source change

### Workflow

1. **Read the source change.** Open the commit cited in the rationale. If it's a new endpoint / component / column, the audit's draft is usually correct.
2. **Decide if the test is worth writing.** Some changes (refactors, comments, doc-only) won't have new behaviour to test — close the issue with a `wontfix` label if so.
3. **If yes:** copy the scaffold into `registry.json` + the suggested test file, tighten the assertions, push to a PR. The audit agent's scaffolds are starting points, not finished tests.
4. **If no:** close the issue with a one-line rationale.

The agent caps at 50 issues per cycle. If you see `[QA-AUDIT-OVERFLOW]`, that's the rest. Triage the priority items first.

## Triaging a `[QA-AUDIT-STALE]` issue

The agent thinks an existing test references code that has moved. Body contains:
- The current test snippet (with line numbers)
- A redlined diff (`-` old → `+` suggested)
- The source change that caused the drift (commit + file + line numbers)

### Workflow

1. **Verify the drift is real.** Read the source commit. If the agent is right (URL renamed, button label changed, etc.), apply the suggested diff manually.
2. **If the suggested diff is wrong** (rare but happens), close the issue with a comment explaining why. The agent's `last_audited_at` stamp lets it skip on the next cycle within the window.
3. **If the test should be deleted entirely** (the underlying feature was removed), delete the test + the registry entry, close the issue.

## Re-running a single failing test against staging

```sh
cd ~/automated-qa
pnpm exec vitest run \
  --reporter=verbose \
  --reporter=./lib/reporter.ts \
  tests/<area>/<file>.test.ts -t "<test-id>"
```

`--reporter=verbose` shows the live test output; `--reporter=./lib/reporter.ts` writes the markdown + JSON report.

## Re-running with a fresh browser session (no cached login)

```sh
rm -rf runner/.sessions/
QA_RUN_ID=fresh-$(date +%s) pnpm test:p0
```

Useful when you suspect the cached session is stale or polluted.

## Force a re-build of registry.json from the markdown source

```sh
pnpm build:registry
# Reviews the diff, commits if intentional
git diff registry.json
```

The build-registry script lives at `scripts/build-registry.ts` and parses `RevHero-FE-New/qa-test-cases/test-registry.md` (passed as the first arg). Drops LinkedIn-related cases per scope decision.

## Working with the deployed runner

| Task | Command |
|---|---|
| Trigger a fresh run remotely | `gh workflow run qa-staging.yml -R RevHERO-LLC/automated-qa` |
| Watch the run | `gh run watch -R RevHERO-LLC/automated-qa` |
| Read the deployed runner's last report | `curl -fsSLk https://qa-reports.test.revhero.io/latest.md` |
| List all run histories | Browse to https://qa-reports.test.revhero.io/ (autoindex) |
| Stop a runaway runner | `ssh root@147.93.1.174 'docker service update --replicas 0 automated-qa-runner-staging-3kteos'` |
| Restart it | `gh workflow run qa-staging.yml` (Dokploy scales 0→1 on next deploy) |

## Working with the audit agent

| Task | Command |
|---|---|
| Manual trigger | `ssh root@147.93.1.174 'sudo systemctl start revhero-audit.service'` |
| Watch logs | `ssh root@147.93.1.174 'journalctl -u revhero-audit -f'` |
| Read latest audit log | `ssh root@147.93.1.174 'sudo -iu claude-audit ls -lt /home/claude-audit/automated-qa/audit/reports/ \| head -5'` |
| When was the last run | `ssh root@147.93.1.174 'systemctl list-timers revhero-audit --all'` |
| Re-do OAuth signin (token expired) | `ssh root@147.93.1.174 'sudo -iu claude-audit claude /login'` (interactive — open the URL in your local browser) |
| Disable temporarily | `ssh root@147.93.1.174 'systemctl stop revhero-audit.timer'` |

## Escalation

If a failure persists across 3 consecutive runs and you can't fix it:
1. Tag the test with `@flaky` in `registry.json` so it's separated from the rest.
2. Open a normal issue in the relevant service repo with `bug` + `qa-flagged`.
3. Loop in the service owner.

A persistent CRITICAL failure that genuinely shouldn't block deploys (e.g., a known-blocked external service) gets a `severity` downgrade in `registry.json`. Don't loosen the test — change the metadata instead.
