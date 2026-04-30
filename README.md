# RevHero Automated QA

Playwright + Vitest test suite, scheduled QA runner, and Claude Code audit agent for the RevHero platform.

## Layout

```
automated-qa/
├── runner/      Playwright suite — converts the manual test registry into automation
├── audit/       Claude Code agent on VPS2 — opens issues for missing or stale tests
├── shared/      Cross-cutting helpers (Slack, GitHub Issues, registry schema, env loader)
├── registry.json  Canonical mapping: ~448 active test cases (LinkedIn cases descoped)
└── scripts/     One-off maintenance scripts (e.g. parse the markdown registry)
```

## Local setup

```sh
# Install (top-level installs all workspaces via pnpm)
pnpm install

# Install Playwright browsers (once)
pnpm -C runner exec playwright install --with-deps chromium

# Copy env template
cp .env.example .env
# fill in staging creds + Supabase pooler URL + internal-services secret

# Run the P0 slice
pnpm test:p0

# Run the full suite
pnpm test
```

Reports drop to `runner/reports/<run-id>/`. Failure screenshots go to `runner/reports/<run-id>/screenshots/`.

## Phase status

- [x] Phase 1 — Foundation: ~50 P0 tests, fixtures, reporter
- [ ] Phase 2 — Bulk conversion P1–P3 (~210 tests)
- [ ] Phase 3 — Deploy runner to VPS1
- [ ] Phase 4 — CI/CD gate integration (13 service repos)
- [ ] Phase 5 — Bulk conversion P4–P7 (~240 tests)
- [ ] Phase 6 — Claude Code audit agent on VPS2
- [ ] Phase 7 — Documentation + handoff

See `C:\Users\zsk54\.claude\plans\glittery-churning-nest.md` for the full plan.

## Environment

All QA targets staging — never production. The runner refuses to start if `STAGING_BASE_URL` resolves to a `revhero.ai` host without `staging.` or `.test.` in the hostname.
