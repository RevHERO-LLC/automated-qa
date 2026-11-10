# Brief: fill scaffolded QA cases with REAL values read from source code (BFF route slices)

You are filling scaffolded QA test cases for a FULL QA run of the RevHero product. This is a CODE-READING and WRITING task:
no browsing, no API calls, no database access. Do NOT edit any source file, registry or fragment. You write exactly ONE output file (named in your prompt).

## Source code (a snapshot of what is deployed)
Root: `C:\Users\zsk54\qa-staging-snapshot\`
- `RevHero-user-fe-backend` = the BFF (Go/Gin). Routes: `internal/routes/routes.go`. Handlers: `internal/resources/<name>_resource/`. Response helpers: `internal/helpers/httpResponse.go`.
- Downstream services the BFF proxies to: `RevHero-campaign-service`, `RevHero-deals-actions-service`, `RevHero-email-ingress`, `RevHero-sms-service`, `RevHero-users-service`, `RevHero-pipedrive-v3`, `RevHero-swarm-service`, `RevHero-calendar-service`, `RevHero-analytics-service` ... (each has `internal/routes/routing.go` + `internal/resources/...`).
- BFF client packages that call the downstream: `RevHero-user-fe-backend/pkg/revhero_*_client/`.
- `RevHero-FE-New` = the frontend (Next.js) - only needed to see how the FE consumes a route (e.g. which JSON field it renders).
- Product intent where code is ambiguous: spec `C:\Users\zsk54\Downloads\RevHero_Unified_Inbox_Functional_Implementation_Spec_v1.docx.md`, plan `C:\Users\zsk54\.claude-reqruited\plans\synthetic-scribbling-waffle.md` (decisions D1-D19; U6 covers deal actions such as Assign Outcome and Stop Sequence).

## What a case is
Your cases file (path in your prompt) lists cases: `### <id> surface=<S###> kinds=<...>` followed by the scaffold line. Each scaffold line has generated placeholders such as
`<the real filter>`, `<the EXACT empty-state copy from the code>`, `<field>`, `<real value>`, `<the exact rendered string>`, `<the real fallback>`, `<the exact field-level error text>`, `<the real sort order>`, `<the real tiebreak>`, `<the real zero copy from the code>`, `<the real formula>`, `<UNKNOWN ...>`.
The protocol rule: replace EVERY placeholder with the REAL value read from the code (exact strings, real field names, real status enums, real sort order and tiebreak). A case left holding a generic placeholder is worthless.
Where a template genuinely does not apply to that surface, the case becomes `none — <reason of AT MOST 8 words>` (status `none`). A stated gap passes; an unexplained one fails.

The surfaces in your slice are BFF API ROUTES (JSON endpoints, no HTML). The scaffold text was generated for pages, so ADAPT the words while keeping the assertion SHAPE:
- "renders exactly N <item element>" -> the response's list (name the JSON path, e.g. `data.items`) contains exactly N entries;
- "displays <exact rendered string>" -> the response body (status code + the exact `message` string + the exact `data.<field>` value) or the persisted state the route writes;
- "invalid submission writes NO row and shows <exact field-level error text>" -> the HTTP status + the exact `message` (and `data.error` if non-generic) returned, AND that nothing was persisted.
Keep the assertion shape of the per-kind questions below, but fill in values:
- COLLECTION: seed N rows -> returns exactly N · zero rows -> the exact empty-state copy/shape (e.g. `[]` vs `null`, `pagination.total=0`, message string) · an excluded row appears nowhere · the real sort order AND tiebreak (say explicitly if there is NO tiebreak in the code).
- SCALAR: seed N -> the figure reads exactly N · zero -> the real zero copy · the formula's expected value derived INDEPENDENTLY from the spec/intent (compute by hand from the business meaning, e.g. "conversion rate = replied / sent", state rounding) - never by echoing the code's formula; if the code deviates from the intent, that is a finding.
- RECORD: a real field value -> the exact rendered string · null/0/empty -> the real fallback.
- INPUT: every creation path -> the resulting status field (they must agree) · invalid write -> no row + the exact field-level error · same write twice -> one row, and NAME the guard that prevents the second (file:line: unique index, idempotency key, dedupe query, `already exists` check ...). If NO guard exists, say so explicitly and mark the case `finding` (do not write "two rows" as the expected result - state the expected correct behavior and that the code lacks the guard).
- GENERATED (referential integrity / cache-freshness): every name the output references must exist in the vocabulary extracted from this snapshot (say WHERE you extracted it - which router file/schema/enum - and give the set or its size); after a source record changes from X to Y the NEXT output reflects Y, not a cached X (say whether any cache exists: Redis/in-memory/TTL, with file:line, or that none exists).
- MIRRORED / TRANSITION kinds: follow the same idea (which side wins; previously rendered content stays while loading) if they appear.

## BFF facts you will need (verified)
- Success envelope: `{"data": ..., "message": "<string>"}` (`helpers.RespondOk` / `RespondCreated` -> 200/201); list endpoints also carry `"pagination"` (`RespondOkPaginated`).
- Error envelope: `{"message": "<string>", "data": {"error": "<string>"}?, "reference": "<8 hex>"?}` (`helpers.RespondError`, httpResponse.go:340). IMPORTANT genericization (httpResponse.go:186-275 (genericClientError :186, dbDriverSignatures :190, clientSafePhrases :211, shouldGenericize :261)): if the message/error contains a DB/driver signature, or the status is >= 500 and it contains none of the `clientSafePhrases`, the message becomes EXACTLY `An unexpected error occurred. Please try again or contact support.` plus a `reference`. So a real 500 NEVER shows the downstream text - state the generic string. `RespondUpstreamError` (httpResponse.go:138) relays a downstream 4xx (not 401/403) with the downstream's own message; a 5xx/401/403/transport error becomes the 500 fallback message passed by the caller. `RespondTrusted` sends composed text as-is. `SanitizeBindError` (httpResponse.go:294-340) turns validator errors into `<json_field> is required` / `... must be a valid email address` / `... is too short|too long` / `... must be greater than N` / `... must be one of: ...` / `... is invalid`, joined by `; `; non-validator bind failures become `Request payload is invalid or malformed.`
- Route guards: `middleware_auth.RequireCampaignParam("id")`, `RequireDealParam`, `RequireStageParam`, `RequireStageActionParam`, ... do a seat/tenant ownership check BEFORE the handler (read `internal/middleware/auth/` + `internal/seatguard` for the status + message they return when the id belongs to another tenant or does not exist - cite it).
- Tenant/identity comes from the JWT (`middleware_auth.GetUserFromContext`), never from the client.
- BFF -> downstream clients live in `pkg/revhero_*_client/`; downstream services answer with their own `helpers.RespondError(...)` strings. Quote the downstream string only where the BFF actually relays it (4xx) - otherwise quote what the BFF returns.

## OUTPUT FORMAT (one block per case; this is read by a merge script)
Write blocks to your output file (path in your prompt) in EXACTLY this shape. Plain text, no JSON escaping needed:

```
=== FE-SURF-1510 | filled
EV: RevHero-user-fe-backend/internal/routes/routes.go:1346; RevHero-user-fe-backend/internal/resources/campaign_resource/campaign.handler.go:1747-1792; RevHero-campaign-service/internal/resources/campaign_resource/campaign.service.go:4031-4048
TX: <the middle of the bullet: replace the scaffold sentence with the filled sentence(s), one paragraph, no blank lines, may run several lines>
```
- `status` is one of `filled` | `none` | `finding`.
- `EV:` = real `file:line` references (relative to the snapshot root, e.g. `RevHero-user-fe-backend/internal/...:123`) for every value you quote. They must be lines you actually read.
- `TX:` = ONLY the middle of the bullet. DO NOT include the leading `- **FE-SURF-xxxx** — [S### path]` tag and DO NOT include the trailing `_type: ..._` marker - the merge script re-attaches both verbatim. Start TX directly with the sentence (e.g. `For campaign 7 ...`).
- For `none`: TX must be exactly `none — ` followed by at most 8 words of reason. Use `none` ONLY when the template really cannot apply to the surface (e.g. COLLECTION cases on a single-record action route); do not use it to skip work. Prefer adapting the template to the real behavior when ANY real analogue exists (e.g. the response `data` array, the persisted rows an action writes).
- For `finding`: TX states the expected-result defect to file: what a correct system must do vs what the code actually does, with the exact strings.
- NO angle-bracket placeholder tokens anywhere in TX (no `<the ...>`, `<field>`, `<N>` ...). Write real values, real seeds (e.g. N=3, N=0, N=11 for a limit of 10), real strings in backticks. Use `->` for arrows, `<=`/`>=` for comparisons only.
- Make each TX self-sufficient for a tester who has never seen the code: the seed (exact rows/fields), the call (method + full path as served, e.g. `PUT /v1/campaigns/{id}/suppress-cross-campaign/enable`), and the expected result (status, exact message, exact field values), plus the guard/ordering/exclusion rule named from the code. Typically 60-200 words.
- Expected results come from product INTENT and real values, never from "whatever the code returns": when code and intent disagree, write the intended result as the expectation and mark `finding`.
- Write the file progressively: after every ~6 cases, append to the file (create it first, then append with a shell heredoc or rewrite). Partial progress must survive.
- Do NOT write a block for a case you cannot fill after real effort; list it (id + reason) in your final reply instead.

## Final reply (short, <= 25 lines)
Counts by status; every `finding` as `id - one-line defect - evidence file:line`; any case you did not fill and why. Do not paste the blocks into the reply.

## Worked example (shape only - do not copy values)
```
=== FE-SURF-9999 | filled
EV: RevHero-user-fe-backend/internal/resources/foo_resource/foo.handler.go:88-112; RevHero-foo-service/internal/resources/foo/foo.service.go:301
TX: Invalid write: `POST /v1/foo` with body `{"name":""}` returns 400 with `message` = `name is required` (SanitizeBindError, httpResponse.go:299) and persists NO foo row (assert `SELECT count(*) FROM foos WHERE parent_user_id = <seed tenant>` unchanged); `{"name":"x"}` sent twice creates ONE row because `foos` has UNIQUE(parent_user_id, name) (foo.model.go:41) and the second call returns 409 `Foo already exists`.
```
