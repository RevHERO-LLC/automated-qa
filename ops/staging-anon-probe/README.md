# staging-anon-probe

Daily check that **unauthenticated** requests to the staging public API hosts are refused (plan P5-D6: "an automated probe that anonymous requests to staging hosts are refused"). It sends bare GETs, with no credentials, to representative `/v1` routes (users, campaigns, deals, inbox, admin) on every staging host, and Slacks when one answers `2xx`.

**Why:** the U18 edge lock (Traefik default-deny) covers prod hosts only, so staging hosts rely on code gates. Those gates have gone missing before (users-service holidays, active-hours and api-keys answered anonymous callers on staging until #244), and a gate added once can quietly disappear in a refactor, or sit in log-only mode (`INTERNAL_AUTH_ENFORCE`). Nothing was watching.

| Verdict per route | Status | Meaning |
|---|---|---|
| `refused` | 401, 403 | what every route in the targets file must answer |
| `absent` | 404, 405, 410 | route or id unknown. **Not proof of auth**: reported, never counted as a pass |
| `invalid` | 400, 422 | rejected as malformed. With a well-formed URL this means the handler's own validation ran with **no auth in front of it** (email-ingress, hubspot and pipedrive did exactly that on 2026-11-22 until the required `parent_user_id` was sent), or the probe's parameters went stale. Never a pass |
| `redirect` | 3xx | not followed. Not counted as a pass either |
| `error` | no answer, 429, 5xx after retries | could not evaluate |
| `open` | 2xx, no records | auth is not enforced |
| `leak` | 2xx with records | anonymous callers get data |

| Alert kind | When | Timing |
|---|---|---|
| `leak` | at least one route answered 2xx with records | at once |
| `open` | at least one route answered 2xx without records | at once |
| `failed` | could not evaluate enough: an `error`, a host with no evaluable route, or fewer than `MIN_EVALUATED_PCT` (50) of the probes evaluated | after `CONFIRM_RUNS` (2) runs in a row, so a blip does not page |
| `config` | cannot run: no `curl` or `jq`, an unreadable, empty or malformed targets file, or a non-staging target | at once, and the unit exits 2 |

The contract is the one in `ops/offsite-backup-deadman`:
- **Fails loud.** With no `SLACK_WEBHOOK` the unit fails (exit 2). If Slack is down, the alert is not recorded and is retried next run (exit 1).
- **Dedupes.** An unchanged problem re-alerts at most every `REMIND_HOURS` (46, so a daily run always lands on it). A new or changed *set* of leaking routes alerts at once: unlike the dead-man, the state keeps a signature of the set, so a second route starting to leak is not hidden behind the first alert.
- **RECOVERED.** When the probe is clean again, one RECOVERED message is posted and the state resets.

## Decisions worth knowing

- **`open` alerts as well as `leak`.** The probe asks for a nonexistent tenant (id `999999999`) so that an open route has nothing to return. That means "2xx but no records" proves nothing about auth. The finding is the 2xx, so both alert; the label only says whether records were seen.
- **Defaults are not records.** The probe asks for a tenant that does not exist, so a zero, `false`, empty string or `null` in an answer can only be a default. Only a non-empty array or a non-default scalar (a non-zero number, a non-empty string, `true`) counts as records, and response plumbing (`message`, `total`, `pagination`, `current_page`...) never does. Two live answers were first mislabelled `leak` and drove this: an empty paginated list on sms-service, and a zero-filled summary on analytics. Both are tests now.
- **Bodies never leave the process.** A response body goes to one temp file only so `jq` can ask "are there records?", and is truncated at once. The report, the journal, Slack and the state file hold host, path, status, size and a verdict, never a body. The test plants a sentinel in every mock body and proves it never shows up.
- **Staging only, enforced in code.** A target whose host is not a staging domain (`*.test.revhero.io`, `*.staging2.revhero.io`, `*.staging.revhero.ai`, `*.test.revhero.ai`) is a `config` error and nothing at all is requested. The targets file cannot point the probe at prod.
- **GET only, and read-only list routes only.** Some GETs in this fleet trigger work when reachable (deal-mover `/v1/sweeper/run`, deals-actions `/v1/actions/linkedin-enrich-sweep`). If one were open, the probe would run it. The targets file says which routes must never be added.
- **Never follows a redirect, never reads `~/.curlrc`** (`curl -q`), sends no cookie or auth header.
- **Daily at 10:20 UTC**, outside VPS4's nightly dump window (~02:00-08:45Z), which slows staging answers and would manufacture `failed` alerts.

## Where to run it

**A probe is only as honest as its vantage point.** The goal is to see what an anonymous caller on the internet sees. The prod edge lock's allowlist (`internal-plus-fleet`) is the private ranges plus the swarm nodes' public IPs, and that includes VPS2 (147.93.1.174). Checked 2026-11-22: **every host in the targets file resolves to 147.93.1.174, which is VPS2 itself**, so staging is served by the same Traefik as prod, and a probe on VPS2 would call its own public address from an allowlisted one. Today the staging hosts have no edge lock, so VPS2 sees what the internet sees. **The day a staging default-deny is added, a probe running on VPS2 will walk straight through it** and report only the application layer: it cannot show that the edge works, and it will cry `leak` for a route the world is correctly refused on.

So install it on VPS2 only knowing that. To test the edge itself, run it from outside the fleet (a scheduled GitHub-hosted workflow, one of the scraper EC2 boxes, a small external VM). Set `PROBE_VANTAGE` in the env file to say where it runs: it is printed in every alert, so nobody reads an application-layer result as an edge result.

## Install (manual, not CI)

1. **On the target host, first:** `bash ops/staging-anon-probe/test-probe.sh`. It needs the host's real `jq` and proves the body classifier against it (the test was developed against gojq, a jq-compatible implementation, because the author's machine had no `jq`).
2. `sudo bash ops/staging-anon-probe/install.sh`, then fill `/etc/revhero/staging-anon-probe.env` (`SLACK_WEBHOOK`).
3. Run the two manual tests the installer prints: the report-mode run first, then `TEST_ALERT=true`.

Merging this repo deploys nothing by itself. **The first scheduled run will alert** for every route that is open today (see the PR for the 2026-11-22 list), and repeat every `REMIND_HOURS` until each is fixed or removed from the targets file. Decide that before installing.

## Run it by hand

```bash
PROBE_NO_SLACK=1 bash ops/staging-anon-probe/probe-staging-anon.sh
```

Report mode prints the table, needs no webhook, writes no state and posts nothing. Exit codes: `0` clean, `3` a route answered 2xx, `4` could not evaluate, `2` config.

## Targets

`staging-anon-probe.targets` (installed to `/etc/revhero/`, never overwritten once it exists). One line per target: `<https-base> <path> <family>`. Routes were read from `origin/staging` of each service. The rules for adding one are at the top of the file. A route that moves answers 404: it shows as `absent`, counts against `MIN_EVALUATED_PCT`, and a host whose every route is `absent` raises `failed`, so drift is visible instead of silent.

## What it cannot tell you

- **A 404 is inconclusive.** The probe cannot tell a missing route from an open route with an unknown id.
- **`refused` does not mean the right gate.** A 401 from the wrong middleware still passes.
- **A non-empty default string reads as records** (a currency code, a timezone). The label only sets severity: any 2xx alerts either way.
- **GET only.** It says nothing about POST, PUT or DELETE on the same hosts.
- **No authenticated checks.** Cross-tenant access with a valid token (IDOR) is out of scope.
- **Routes open on purpose are not probed** (webhooks, public pages, the unauthenticated `GET /v1/supported-crms/account-by-crm-user` leftover). They would alert every day.
- **Lane-2 internal hosts** are not listed: none was found in the repo configs. Add them to the targets file if they exist.

## Test

`bash ops/staging-anon-probe/test-probe.sh` is hermetic: `curl` is mocked, no network, no Slack. It needs the real `jq` (it classifies bodies). It covers the verdict table, the staging-only guard (including look-alike hosts such as `https://api.staging.revhero.ai@evil.com`), alert, dedupe, a changed set, REMIND, RECOVERED, retries, the time budget, fail-loud, report mode and the "no body content ever leaves" sentinel.
