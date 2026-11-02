# analytics-alarm-deadman

Dead-man check for the **analytics-service alarm loop** (m1030 Phase 3: silence must not look
like health). The loop raises every alert in the analytics bundle (AI-failure, send-volume, new AI
bookings, reconciler caps, SiteForge backlog, ...). A dead loop raises nothing, and "no alerts" reads
exactly like "healthy". So the loop stamps a last-run time, and this check - a separate process on a
separate host - pages when the stamp goes stale.

## What it does

Every 5 min on the swarm manager (VPS2, systemd timer) it calls analytics-service
`GET /v1/internal/alarms/heartbeat` (contract C5, `X-Internal-Secret`) and reads `last_run_at`
(a bare `{"last_run_at":...}` and a `{"data":{"last_run_at":...}}` envelope both work).

| observed | meaning | Slack |
|---|---|---|
| `last_run_at` <= 30 min old | healthy | nothing |
| `last_run_at` > 30 min old | **stale** - the loop stopped | at once |
| no response / non-2xx / no `last_run_at` (null, missing, zero time) / unparseable / future stamp | **failed** - a missing response IS an alert | after 2 consecutive runs (a rolling analytics deploy must not page) |
| no secret / no way to read it | **config** - the check cannot run | at once, and the unit exits 2 (stays red) |

**Dedupe:** a new or changed kind alerts immediately; the same kind re-alerts at most every
`REMIND_HOURS` (6), labelled REMINDER; when the heartbeat is fresh again one RECOVERED message is
posted and the state resets. Slack is the same `jq -Rs '{text:.}' | curl` idiom as
`overlay-fdb-detector`.

**Fail loud:** no `SLACK_WEBHOOK` => exit 2; Slack undeliverable => exit 1 and the alert state is
not recorded (it retries next run); a hung check is capped by `TimeoutStartSec=2min`. A FAILED
`analytics-alarm-deadman.service` in `systemctl --failed` means the dead-man itself is broken, which
is a different thing from the loop being dead (that one pages Slack).

**Credential:** header only (never `?secret=`), handed to curl on stdin so it is never in argv, `ps`
or a trace, and never logged. By default it is read from the live swarm service spec of
`ANALYTICS_SERVICE` on every run, so a secret rotation can never leave a stale copy here (a stale
credential is what blinded `email-drift-check` for three days). `ANALYTICS_INTERNAL_SECRET` overrides
it for a service that is not on this swarm.

## Install (VPS2) - an end-of-mission checklist step, NOT done by merging

Install only AFTER analytics-service with `/v1/internal/alarms/heartbeat` is live on prod, otherwise
the check correctly alerts "HTTP 404 ... heartbeat endpoint not deployed" after two runs.

```sh
sudo bash ops/analytics-alarm-deadman/install.sh
sudo vi /etc/revhero/analytics-alarm-deadman.env     # SLACK_WEBHOOK (reuse the org webhook)
set -a; . /etc/revhero/analytics-alarm-deadman.env; set +a; TEST_ALERT=true /usr/local/bin/check-alarm-heartbeat.sh
journalctl -u analytics-alarm-deadman.service --no-pager -n 50
```

Config (env file): `SLACK_WEBHOOK` (required), `ANALYTICS_BASE_URL` (default
`https://internal-analytics.revhero.io`), `ANALYTICS_SERVICE` | `ANALYTICS_INTERNAL_SECRET`,
`LANE_LABEL`, `STALE_MINUTES` (30), `CONFIRM_RUNS` (2), `REMIND_HOURS` (6), `CURL_TIMEOUT` (15).
To watch the staging lane too, run a second instance with its own env file (different
`ANALYTICS_BASE_URL`/`STATE_DIR`); none is provisioned by default.

## Test

```sh
bash ops/analytics-alarm-deadman/test-deadman.sh      # exit 0 = all PASS
```

Mocks `curl`/`jq`/`docker` on PATH (no network, no swarm, no real `jq`), runs the real script, and
covers: fresh/stale/recovered/reminder dedupe, a failed call (blip tolerance then alert), HTTP
401/502, null/zero/garbage/future timestamps, both response envelopes, no webhook (exit 2), Slack
down (exit 1, state not recorded, retried), no secret (config alert, exit 2), and that the secret
travels on stdin only.

## Known limit

It cannot watch itself. `scripts/periodic-job-heartbeat.sh` (daily, GitHub Actions on the VPS2
runner) is the outer net for jobs; a FAILED unit in `systemctl --failed` is the signal for this one.
