# Fill-agent brief: fill the RESIDUAL of a QA registry regeneration with REAL values read from source code

<!-- Generalized from the two 2026-11-07 briefs (legacy-2026-11-07/BRIEF.md for BFF route slices, and the run's
     ga-brief.md for mixed page + route slices). The per-slice route-mapping tables those briefs carried by hand are
     replaced by the per-case addressing hints that carry-forward.mjs computes. Read it fully before starting. -->

## Your job
You fill scaffolded QA test cases for the RevHero product with REAL values read from source code. This is a
code-reading and writing task:
- NO browsing, NO API calls, NO database access, NO git writes.
- Do NOT edit any source file, registry, fragment or slice file. You write exactly ONE part file (path in your prompt).
- Source: the code snapshot named in your prompt (the carry report's `paths.snapshot`; normally
  `C:\Users\zsk54\qa-staging-snapshot\`). It is exactly what the scaffold was generated from. Main repos:
  `RevHero-FE-New` (frontend, Next.js: pages under `app/`, feature code under `features/`), `RevHero-user-fe-backend`
  (the BFF, Go/Gin: routes in `internal/routes/routes.go`, handlers in `internal/resources/<name>_resource/`, clients for
  the downstream services in `pkg/revhero_*_client/`), and the downstream services (`RevHero-campaign-service`,
  `RevHero-deals-actions-service`, `RevHero-email-ingress`, `RevHero-sms-service`, `RevHero-users-service`,
  `RevHero-calendar-service` = the booking service, `RevHero-analytics-service`, `RevHero-swarm-service`, ... each with
  `internal/routes/routing.go` + `internal/resources/...`), plus `RevHERO-Super-Admin-Portal`.
- Product intent where the code is ambiguous: any spec or plan named in your prompt.

## Your input: one slice of the residual
Your slice JSON (path in your prompt) is `{slice, part, count, cases:[...]}`. Every case is one the deterministic
carry-forward could NOT reuse from the previous fill, so it needs fresh reading. Each case has:
- `id`, `surface` (S###), `path` (the surface: a page such as `/(dashboard)/deals/[id]`, or a BFF route such as
  `routes:/:id/insights`), `kinds`, `sources` (the files the surface was found in), `rendering`;
- `text`: the generated template line, with placeholders such as `<the real filter>`, `<the EXACT empty-state copy
  from the code>`, `<field>=<real value>`, `<the exact field-level error text>`, `<the real sort order>`,
  `<the real tiebreak>`, `<UNKNOWN ...>`;
- `reason`: why it was not carried. `source-changed` / `surface-touched` = the code behind a previous answer changed,
  so re-read it; `plumbing-changed` = the BFF's shared request code (middleware, response helpers, config, startup)
  changed, which every BFF route goes through, so re-read the route end to end; `no-match` = a new case; `template-changed` = the template wording changed; `per-entity` = the
  write-consistency sweep, always re-derived because a new write path can appear anywhere; `no-evidence` /
  `evidence-unresolved` = the previous answer cited no readable code;
- `hint`: the ADDRESSING HINT (next section), or null.

## Addressing hints (read this before resolving any route)
BFF route surfaces are named by their path RELATIVE to a Gin route group (`routes:/:id/insights`), which is ambiguous:
the same relative path can be registered under several groups. `hint` was computed mechanically from the snapshot's
`routes.go` by following the `Group()` nesting:
- `hint.resolved` = the full served method + path (e.g. `GET /v1/deals/:id/insights`) when exactly one registration
  matches. Use it, but still open the handler it names and confirm it is the one the case is about.
- `hint.resolved` = null with several `hint.candidates` = the relative path is registered under more than one group.
  Pick the candidate whose handler matches the case (verb, kinds, sources), and say which one in `EV:`.
- For a page surface, the hint is the served URL (Next.js route groups such as `/(dashboard)` stripped).
- A hint is a starting point, never a value to copy blindly: every address you write in `TX` must be one you confirmed
  in the code. The hints are never written into the registry for you; your `TX` is.

## The protocol rule
Replace EVERY placeholder with the REAL value read from the code (the exact empty-state string, the real field name,
the real status enum, the real sort order AND tiebreak). A case left holding a generic placeholder is worthless. Where a
template genuinely does not apply to that surface, the case becomes `none — <reason of at most 8 words>` (status
`none`): a stated gap passes, an unexplained one fails. Do not use `none` to skip work; prefer adapting the template to
the real behavior whenever any real analogue exists. Expected results come from product intent plus real values read
from the code, never from "whatever the code returns" when that is plainly a defect.

For a BFF route (JSON, no HTML) the scaffold's page wording is ADAPTED while keeping the assertion SHAPE:
"renders exactly N <item element>" -> the response list (name the JSON path, e.g. `data.items`) holds exactly N
entries; "displays <exact rendered string>" -> the status code + the exact `message` + the exact `data.<field>` value,
or the persisted state the route writes; "invalid submission writes NO row and shows <error>" -> the HTTP status + the
exact `message` (and `data.error`) AND that nothing was persisted.

## The per-kind questions (keep the assertion SHAPE; only fill values)
- COLLECTION: seed N rows -> exactly N (the REAL item element/selector, or the JSON array path) | zero rows -> the
  exact empty-state copy or payload (`[]` vs `null`, `pagination.total=0`) | an excluded row appears nowhere (state the
  REAL exclusion rule: tenant/seat scoping, status filter, deleted flag) | the real sort order AND tiebreak (if the code
  orders by one column only, say there is NO tiebreak; no ORDER BY at all = undefined order, a finding).
- SCALAR: seed N underlying rows -> the figure reads exactly N | zero -> the real zero copy | the formula's expected
  value derived INDEPENDENTLY from the intent with a worked numeric example and the required rounding, never by echoing
  the code's formula; if the code deviates from the intent, that is a finding.
- RECORD: a real field value -> the exact rendered/returned string (a concrete example value and the exact output) |
  null/0/empty -> the real fallback (never "null", "undefined", "NaN").
- INPUT: every creation path -> the resulting status field (they must agree) | invalid write -> no row + the exact
  error the CLIENT receives | the same write twice -> one row, and NAME the guard (file:line: unique index, idempotency
  key, dedupe query, `already exists` check). If NO guard exists, mark `finding` and state the correct expected
  behavior; never write "two rows" as the expected result.
- GENERATED: referential integrity (every name the output references exists in the vocabulary; say WHERE you
  extracted it and give the set or its size) and cache freshness (after a source record changes X -> Y the next output
  shows Y; name any cache with its TTL, or state that none exists).
- TRANSITION / ARTIFACT / MIRRORED: follow the same idea if a case carries them.
- Per-entity "Enumerate EVERY path that writes ..." cases: list every INSERT/UPDATE/DELETE path of that entity across
  ALL services with file:line, the state field each one lands, and the assertion that they agree.

## Verified shared facts (as of 2026-11-07; confirm line numbers in YOUR snapshot before citing them)
### BFF response envelope (`RevHero-user-fe-backend/internal/helpers/httpResponse.go`)
- `RespondOk` / `RespondCreated` -> `{"data": ..., "message": "<string>"}` (200/201); `RespondOkPaginated` adds `pagination`.
- `RespondError(msg, &gin.H{"error": x}, code)` -> `{"message": msg, "data": {"error": x}, "reference"?}`. It
  GENERICIZES: text with a DB/driver/validator/json signature, or any 5xx text without a client-safe phrase (`not
  found`, `already exists`, `expired`, ...), becomes EXACTLY `An unexpected error occurred. Please try again or contact
  support.` plus an 8-hex `reference`. A real 500 never shows the downstream text; 4xx text without a signature passes.
- `helpers.SanitizeBindError(err)`: `{json_key} is required`, `... must be a valid email address`, `... is too short`,
  `... is too long`, `... must be greater than N`, `... must be one of: a b c`, `... is invalid`, joined by `; `;
  malformed JSON -> `Request payload is invalid or malformed.`
- `RespondUpstreamError` relays a downstream 4xx (not 401/403) with the downstream message; anything else becomes the
  caller's 500 fallback. `RespondTrusted` is not genericized. `_ = c.ShouldBindJSON(&x)` DISCARDS bind errors.
- Route guards (`middleware_auth.RequireCampaignParam("id")`, `RequireDealParam`, `RequireStageParam`, ...) check
  seat/tenant ownership BEFORE the handler; cite the status + message they return. Tenant and identity come from the JWT
  (`middleware_auth.GetUserFromContext`), never from the client.
### Frontend (`RevHero-FE-New`)
- Shared table `components/ui/DataTable.tsx`: item element `tbody tr`; zero rows render ONE `tbody tr` whose single
  `td[colspan]` holds the `placeholder` prop (default `No Data available`); client-side pagination, 10 rows per page by
  default; NO sorting handler (rows keep the API order); loading = skeleton bars; error = `Error loading: {message}` + `Retry`.
- `utils/errorHandler.ts handleError` toast priority: `data.data.error` -> `data.data.message` -> `data.error` ->
  `data.message` -> status fallback (`A server error occurred. Please try again later.` for 5xx, `The requested resource
  was not found.` 404, `You are not authorized. Please log in.` 401, `Bad request. Please check your input.` 400).
  Name the string the USER sees, not only the HTTP body.
- Pages gated by a feature flag may redirect; state the gate when it changes what a tester sees.

## Output format (one block per case, in case order; WRITE PROGRESSIVELY)
Rewrite or append your part file after every ~6 cases so partial progress survives. Plain text, no JSON escaping:

```
=== FE-SURF-1510 | filled
EV: RevHero-user-fe-backend/internal/routes/routes.go:1346; RevHero-campaign-service/internal/resources/campaign_resource/campaign.service.go:4031-4048
TX: the middle of the bullet: one concrete, testable paragraph (may continue over several lines until the next "=== ")
```
- Header `=== <case id> | <status>`, status `filled`, `none` or `finding`.
- `EV:` = real `file:line` references relative to the snapshot root, repo-qualified, for every value you quote; lines
  you actually read. Without a code citation the next regeneration cannot reuse your answer.
- `TX:` = ONLY the middle of the bullet. Do NOT write the leading `- **FE-SURF-xxxx** — [S### path]` tag and do NOT
  write the trailing `_type: ..._` marker: the merge script re-attaches both verbatim.
- `finding` = filling revealed a real, verified gap (no duplicate-write guard, a field the FE reads but the backend
  never sends, no ORDER BY / no tiebreak, a label that contradicts the data, a raw error leaking to the client). TX
  states the correct expected result AND the defect to file ("DEFECT to file: ..."). Do not manufacture findings.
- NO angle-bracket tokens anywhere in EV/TX (no `<the ...>`, `<field>`, `<N>`, `<id>`, `<a href>`): the validator
  rejects them. Write path params as `:id` or `{id}`, selectors as CSS (`tbody tr`), real seeds (N=3, N=0, N=11 for a
  limit of 10), exact strings in backticks; use `->`, `<=`, `>=` only as operators. Never start a line with `=== `.
- Make each TX self-sufficient for a tester who has never seen the code: the seed (exact rows and fields), the call or
  page (full served path), the expected result (status, exact message, exact field values), and the guard / ordering /
  exclusion rule named from the code. Typically 60-200 words.
- Do NOT write a block for a case you cannot fill after real effort; list it in your final reply instead.

## How to work
1. Read your slice JSON; group the cases by surface. For each surface open the page/component or the BFF handler
   (use the hint), then follow the call down (BFF client -> downstream handler/service/model) until you can state the
   filter, the exclusion rule, the ORDER BY and tiebreak, the response fields, the exact empty/zero copy, the validation
   tags and the exact errors.
2. Prefer targeted Grep and ranged Read; never read whole huge files. Use forward slashes in Bash.
3. Be critical and calibrated: if the code deviates from sensible intent, mark `finding`; if it is sound, fill it.
4. Final reply, at most 25 lines: counts by status; every `finding` as `id - one-line defect - file:line`; any case you
  did not fill and why. Do not paste the blocks.

## Depth example (from an accepted 2026-11-07 fill; shape only, do not copy values)
```
=== FE-SURF-2086 | finding
EV: RevHero-sms-service/internal/resources/message/draft.service.go:55-70
TX: Drafts are returned newest first by `created_at DESC` and for a tie on `created_at` NO tiebreak exists (no `id DESC`), so two drafts created in the same instant have an undefined relative order. DEFECT to file (low): add `, id DESC`. Assert the primary order with 3 seeded drafts at distinct times (newest first).
```
