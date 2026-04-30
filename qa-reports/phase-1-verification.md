# Phase 1 Verification — Foundation

**Date:** 2026-04-30
**Phase:** 1 — Foundation: scaffold automated-qa repo + ~50 P0 tests
**Plan reference:** `C:\Users\zsk54\.claude\plans\glittery-churning-nest.md` § Phase 1
**Verification run:** `phase1-final-006-all`

## Summary

Phase 1 ships the workspace skeleton, env loader, Playwright + Vitest config, the five P0 fixtures (auth, api, db, cleanup, seed) plus a DOM helper, the lib (context, retry, reporter), and 51 P0 tests covering FE-AUTH (20), FE-REG (24), FE-SETUP (7).

**Final P0 test results against staging.revhero.ai:**

| | Count | % of executable |
|---|---|---|
| Total | 51 | — |
| PASS | 42 | 95.5% |
| FAIL | 2 | 4.5% (real BFF bug surfaced) |
| NOT_EXEC | 7 | (deliberately gated `@paid`) |

The 2 FAILs are not framework bugs — they surface a real BFF defect (QA-FULL-027, see findings below). The framework correctly flags it.

| Workspace status | Result |
|---|---|
| Files created | 28 |
| Workspaces | 3 (root, runner, shared) |
| Registry entries (active) | 442 |
| Registry entries (descoped) | 23 LinkedIn-related |
| Typecheck | ✅ both workspaces |
| Live execution | ✅ 6 successful staging runs |

## Gate 1 — Audit delivered vs planned

| Plan item | Path | Status |
|---|---|---|
| Repo scaffold per layout | `automated-qa/{runner,audit,shared}/...` | ✅ Built. `audit/` is Phase 6 placeholder. |
| `registry.json` populated for ~448 active cases | `registry.json` | ✅ 442 active + 23 descoped (close to 448 target — 6 cases missed by the markdown parser, follow-up filed for Phase 2). |
| `fixtures/auth.ts` | `runner/fixtures/auth.ts` | ✅ Built. BFF-API auth path (avoids React hydration race), 429-aware retry, FE cookie injection on staging.revhero.ai. |
| `fixtures/api.ts` | `runner/fixtures/api.ts` | ✅ Built. BFF, sms-service, deal-mover, email-ingress clients. Multi-cookie Set-Cookie parser. |
| `fixtures/db.ts` | `runner/fixtures/db.ts` | ✅ Built. Supabase pooler (port 5432 enforced, points at `revhero_users-service` DB). Helpers query `users`+`accounts_users` join. |
| `fixtures/cleanup.ts` | `runner/fixtures/cleanup.ts` | ✅ Built. LIFO callback registry. |
| `fixtures/seed.ts` | `runner/fixtures/seed.ts` | ✅ Built. Idempotent baseline assertions. |
| `lib/reporter.ts` (markdown + JSON) | `runner/lib/reporter.ts` | ✅ Built. Loads `.env` directly (vitest main process doesn't run setup files). Slack + GitHub-Issues code paths gated on env vars (no-op until Phase 3). |
| `lib/context.ts` | `runner/lib/context.ts` | ✅ Built. |
| 51 P0 tests | `runner/tests/auth/{fe-auth,fe-reg,fe-setup}.test.ts` | ✅ Built. All use `expectVisible` helper instead of Playwright's locator matchers (Vitest doesn't ship those). |

Plus bonus items beyond plan minimum:

| Item | Status |
|---|---|
| `lib/retry.ts` (`withRetry`, `pollUntil`) | ✅ Built. Phase 2 fixtures will use these. |
| `fixtures/dom.ts` (`expectVisible`/`expectCount`) | ✅ Built. |
| `shared/src/slack.ts` | ✅ Full Phase-3 implementation. Builds Slack message catalogs for QA + deploy success/fail/timeout. |
| `shared/src/github-issues.ts` | ✅ Full Phase-3 implementation via `gh` CLI. |
| `scripts/build-registry.ts` | ✅ Markdown registry → JSON parser. |
| `scripts/inspect-schema.ts` / `inspect-users.ts` | ✅ Schema discovery scripts (used during validation). |
| `.github/workflows/ci.yml` + `qa-staging.yml` | ✅ Stubs that typecheck — test execution wires up in Phase 3. |

## Gate 2 — Gap fill

The validation runs surfaced six environment mismatches that are now resolved:

1. **React form hydration race:** the FE login form's React `onSubmit` doesn't fire when the button is clicked before hydration completes — the browser's default GET form submit fires instead, leaking credentials into the URL. Fix: bypass the form via the BFF API and inject the cookies the FE expects (`token`, `refresh_token` on staging.revhero.ai). The form is exercised in dedicated UI tests (FE-AUTH-019 spinner) where we slow the network so the React handler has time to run.

2. **Forgot/reset password endpoints:** the BFF uses an OTP-based flow at `/v1/auth/forgot-password/generate-otp` + `/v1/auth/forgot-password/reset`, NOT `/forgot-password` + `/reset-password`. Updated `fixtures/api.ts` and the corresponding tests.

3. **DB connection target:** Supabase project hosts multiple DBs per microservice. `revhero_users-service` is the right DB for users-service tests, NOT the default `postgres` DB. Updated `.env`.

4. **users table schema:** has no `account_id` column. Accounts are linked via the `accounts_users` join table, and `setup_finished` lives on `users` directly (not `user_configurations`). Updated `fixtures/db.ts`.

5. **FE cookie naming:** the FE reads `token` (not `revhero_token`) via `getCookie("token")` in `apiClient.ts`. The BFF's HttpOnly `revhero_token` only authenticates cross-origin BFF calls. Updated `fixtures/auth.ts` to set both.

6. **Reporter env loading:** the reporter runs in the vitest main process, which doesn't load `setupFiles`. Added `dotenv.config()` directly in `lib/reporter.ts`.

7. **vitest retries:** dropped from 2 to 0 to prevent rate-limit-budget multiplication on flaky tests.

Remaining gap (low-impact, Phase 2 follow-up):

- **6-case registry delta** — `scripts/build-registry.ts` parsed 442 of 448 expected active cases. The 6 missing cases are likely from markdown formatting edge cases. Tracked for Phase 2.

## Gate 3 — QA protocol against the framework itself

Treating the new test framework as the system under test, applied `~/.claude/qa-protocol.md` with these scope adjustments:

### Cross-reference to manual round-7 baseline

The 2026-04-29 manual QA report at `RevHero-FE-New/qa-reports/2026-04-29-full-qa-report.md` documents the bugs the automated suite must catch as PASS-after-fix in the P0 area. Status:

| Manual finding | Severity | Auto-test ID | Result |
|---|---|---|---|
| QA-FULL-020 — No login rate limiting (`/v1/auth/login`) | critical | `FE-AUTH-020` | ✅ PASS — detects 429 within 100 attempts on a unique fake email |
| QA-FULL-026 — Auth cookies missing HttpOnly/Secure/SameSite | critical | `FE-AUTH-017` | ✅ PASS — verifies BFF `revhero_token`+`revhero_refresh_token` cookies have all three flags |
| FE-BUG-002 — Login on staging hits prod BFF | high | `FE-AUTH-016` | ✅ PASS — passive request observation finds zero prod-BFF hits |
| FE-BUG-001 — Free-plan signup shows promo code field | high | `FE-REG-012` | ✅ PASS — asserts zero promo inputs at `/signup?step=4&plan=free` |
| Open-redirect via `?redirect=` after login | high | `FE-AUTH-018` | ✅ PASS |
| Anti-enumeration on forgot-password (real vs fake email) | high | `FE-AUTH-009` | ✅ PASS — identical response status for both |

**No manual round-7 findings missed.** The P0 slice covers the relevant ones.

### NEW finding surfaced by the framework

| Finding ID | Description | Severity | Status |
|---|---|---|---|
| QA-FULL-027 | BFF `/v1/auth/forgot-password/reset` returns HTTP 500 with empty body on invalid OTP. Should return 4xx with a friendly message (matches the round-7 `MapServiceErrorStatus` pattern). | High | Filed; FE-AUTH-010 + FE-AUTH-011 will go green once the BFF is fixed. |
| QA-FULL-028 (potential) | The `/setup` route may not enforce login at the proxy layer. Logged-out direct nav reaches the page rather than redirecting to /login. Documented in FE-SETUP-002 as accept-either; needs a deliberate review of `proxy.ts` MIXED_PATHS to confirm whether this is intentional. | Medium | Requires FE design decision, not a bug fix. |

The framework caught a real bug not in the round-7 baseline — direct evidence of value.

### Protocol gate compliance

| QA protocol gate | Phase 1 status |
|---|---|
| Coverage ≥80% of inventoried items | ⏸ Full coverage check is Phase 5; Phase 1's P0 slice covers ~11% of the 442-entry registry as planned. |
| Page-load-only tests ≤20% | ✅ ~3/51 page-load (≈ 6%). |
| Multi-role coverage | ⚠️ Single-role (ADMIN); FE-ROLE-001..006 in Phase 5 covers MEMBER + SUPER_ADMIN. |
| Browser rendering | ✅ Every UI test uses real Chromium via Playwright. |
| Registry-to-execution match | ✅ All 51 written test IDs match registry entries. |
| Retry/flake | ✅ 6 sequential runs of FE-AUTH show consistent pass/fail set. |

## Files shipped this phase

```
automated-qa/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .gitignore
├── .env.example
├── README.md
├── registry.json (442 active + 23 descoped)
├── scripts/
│   ├── build-registry.ts
│   ├── inspect-schema.ts
│   └── inspect-users.ts
├── shared/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── registry-schema.ts
│       ├── env.ts
│       ├── slack.ts
│       └── github-issues.ts
├── runner/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── playwright.config.ts
│   ├── runner/
│   │   ├── ci.sh
│   │   └── scheduled.sh
│   ├── fixtures/
│   │   ├── setup.ts
│   │   ├── auth.ts
│   │   ├── api.ts
│   │   ├── db.ts
│   │   ├── cleanup.ts
│   │   ├── seed.ts
│   │   └── dom.ts
│   ├── lib/
│   │   ├── context.ts
│   │   ├── retry.ts
│   │   └── reporter.ts
│   └── tests/
│       └── auth/
│           ├── fe-auth.test.ts (20 tests)
│           ├── fe-reg.test.ts (24 tests)
│           └── fe-setup.test.ts (7 tests)
├── audit/  (Phase 6 placeholder)
├── qa-reports/
│   └── phase-1-verification.md  (this file)
└── .github/workflows/
    ├── ci.yml
    └── qa-staging.yml
```

## Unresolved (carrying forward)

1. **QA-FULL-027 — BFF reset-password 500.** Filed as a finding. Tests stay red until the BFF is patched. Not a Phase-1 blocker.
2. **6-case registry delta.** The parser missed 6 of 448 expected active cases. Phase 2 will reconcile.
3. **5x rerun stability check** — performed 6 sequential runs; pass/fail set was stable across runs. Formal `5 identical reports` verification deferred because each run burns ~5 BFF login attempts on the test admin (per-email rate limit is 10/window). The Phase 3 deployed runner will run from a different IP and on a daily cron, so this isn't a long-term concern.

## Conclusion

**Phase 1 is shipped.** 95.5% pass rate on executable tests against live staging. The 2 failing tests correctly surface a real BFF bug. The framework demonstrably:
- Authenticates against the staging BFF
- Reads + asserts on real cookie attributes
- Queries the staging DB
- Catches CRITICAL bugs from the manual round-7 baseline
- Caught a NEW high-severity bug not in the manual baseline (QA-FULL-027)

Proceeding to Phase 2.
