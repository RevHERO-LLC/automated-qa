# swarm-node-watch

Node-drop alert for the prod Docker Swarm (task #1321, plan P5-D4). It tells a human, in Slack, when a swarm node is
not `Ready`/`Active`, and when a worker keeps losing its heartbeat to the manager even though `docker node ls` looks fine
between polls. Detect-only: it never changes the swarm.

## The fault it watches for

The prod worker `revhero-web` (VPS3, label `role=prod-integrations`) has logged swarm-link failures every day since at least
2026-11-18 (206 to 351 lines a day). On 2026-11-24 its own dockerd logged `heartbeat to manager ... failed` / `agent: session
failed` in 30 separate waves, about 1.2 an hour, around the clock, while the manager logged memberlist timeouts to it. When such
a drop outlasts the heartbeat grace the manager marks the node Down and replaces every task pinned to it at once: the Zot registry,
email-ingress, sms-service, activity, hubspot and pipedrive. Nothing raised an alarm; it was found by hand on 11-19 and
again on 11-25. The evidence is in the RevHero mission docs `runbook-2026-11-25/r17-vps3-evidence.md`.

A state poll alone is not enough: a drop lasts seconds to a minute, so a poll every 2 minutes sees the node `Down` only
some of the time. The worker's own journal records every drop, hence the second check below.

## What it does

Every 2 min on the swarm manager (VPS2, systemd timer) it reads `docker node ls`, and for every Ready/Active **worker**
reads that worker's dockerd journal over SSH (one bounded `journalctl --since -60min`, read-only, nothing written there).

| key | meaning | pages |
|---|---|---|
| `node:<host>=<Status>/<Availability>[/<Mgr>]` | a node that is not `Ready`+`Active` (Down, Unknown, Disconnected, Drain, Pause), or a manager that is not Leader/Reachable | at once |
| `missing:<host>` | a node named in `EXPECTED_NODES` that `docker node ls` no longer lists | at once |
| `flap:<host>` | a worker with >= `WAVE_THRESHOLD` (3) heartbeat-failure **waves** in the last `WAVE_WINDOW_MINUTES` (60). A wave = failing minutes <= `WAVE_GAP_MINUTES` (5) apart | at once; stays active while any wave is left in the window, clears only after a clean window |
| `blind:nodels`, `blind:waves:<host>` | the check could not do its job: `docker node ls` failed or gave no answer within `SWARM_READ_TIMEOUT` (is this the manager? is dockerd wedged?), or a Ready worker's journal could not be read | after `BLIND_RUNS` (2) consecutive runs |

A worker that is not Ready is not SSHed: its state is already the alert. The manager is never SSHed (it has no heartbeat to
itself). Each run logs the per-worker wave count (`waves(60m) revhero-web=2`), so `journalctl -u swarm-node-watch` is a
timeline of the drops even when nothing paged.

**Dedupe** (same shape as `overlay-fdb-detector` and `analytics-alarm-deadman`): the alert is keyed on the SET of problem
keys. A new or changed set alerts at once; an unchanged set re-alerts at most every `REMIND_HOURS` (6), labelled REMINDER.
After the set has been empty for `RECOVER_RUNS` (2) consecutive runs, ONE RECOVERED message is posted and the state resets.
The two-run recovery is the flap guard: down, up, down inside two runs is one alert, not three.

**A failed or hung listing is never "all up".** When `docker node ls` fails or gives no answer, nothing was observed about any
node, so that run is neither a clean run nor a recovery: it never posts RECOVERED, never advances the clean-run count and never
drops an alert that is already active. The first failed read only waits (`BLIND_RUNS`, like every blind spot); once it is
confirmed, `blind:nodels` is alerted and deduped like any other key, and the alerts that cannot be re-checked without the list
(`node:*`, `missing:*`, `flap:*`, `blind:waves:*`) are carried forward exactly as they were stored and listed in that message
as unverified. When the list answers again the normal rules apply (a problem that is still there alerts again because the set
changed; a clean list recovers after `RECOVER_RUNS` clean runs).

**Fail loud:** no `SLACK_WEBHOOK` (or the `REPLACE_ME` placeholder) => exit 2. Slack undeliverable => exit 1 and the alert
state is not recorded (it retries next run). A confirmed `blind:nodels` keeps the unit red (exit 2) even after its alert was
delivered. A hung swarm read (`docker node ls`, `docker node inspect`) is cut by the script's own `SWARM_READ_TIMEOUT` (20 s)
and reported as a blind spot. `TimeoutStartSec=2min` in the unit is only the outer cap: a run it kills posts nothing, and
nothing pages on a red unit, so the script must never depend on it. A FAILED `swarm-node-watch.service` in
`systemctl --failed` means the watcher itself is broken, which is a different thing from a node dropping (that one pages Slack).

## Install (VPS2) - an end-of-mission checklist step, NOT done by merging

```sh
sudo bash ops/swarm-node-watch/install.sh
sudo vi /etc/revhero/swarm-node-watch.env      # SLACK_WEBHOOK (reuse the org webhook in overlay-routing-healer.env)
set -a; . /etc/revhero/swarm-node-watch.env; set +a; TEST_ALERT=true /usr/local/bin/check-swarm-nodes.sh
sudo systemctl enable --now swarm-node-watch.timer      # install.sh does this itself once the webhook is set
journalctl -u swarm-node-watch.service --no-pager -n 50
```

`TEST_ALERT=true` runs the whole read path (`docker node ls`, the SSH journal read on every worker) and posts one Slack
message listing the nodes, the per-worker wave counts and any current problem. It changes no state. It cannot simulate a drop:
never drain or pause a prod node to test, a paused `role=prod-integrations` node cannot take back the tasks pinned to it.

Needs on the manager: `docker`, `jq`, `curl`, `ssh`, `timeout`, and root SSH to every worker (already trusted, the
overlay-fdb-detector uses it). On the workers: `journalctl` and `grep`. `install.sh` checks the manager side.

Planned maintenance (a deliberate drain or reboot) pages by design, then posts RECOVERED. Stop the timer for the window if
that is unwanted: `systemctl stop swarm-node-watch.timer`, then start it again.

## Config (env file `/etc/revhero/swarm-node-watch.env`)

| var | default | meaning |
|---|---|---|
| `SLACK_WEBHOOK` | - | REQUIRED. Incoming webhook; reuse the org one |
| `LANE_LABEL` | `prod` | shown in every message |
| `EXPECTED_NODES` | unset | comma list of node names that must exist |
| `REMIND_HOURS` | `6` | re-alert interval for an unchanged set |
| `RECOVER_RUNS` | `2` | consecutive clean runs before RECOVERED |
| `BLIND_RUNS` | `2` | consecutive runs a blind spot must last before it pages |
| `WAVE_THRESHOLD` | `3` | waves in the window that page a worker; `0` switches the wave check (and its SSH) off |
| `WAVE_WINDOW_MINUTES` | `60` | window for the wave count |
| `WAVE_GAP_MINUTES` | `5` | failing minutes this close together are one wave |
| `WAVE_CLEAR_BELOW` | `1` | an alerted worker clears only with fewer waves than this in the window |
| `REMOTE_TIMEOUT` | `30` | seconds per worker for the SSH + journal read |
| `SWARM_READ_TIMEOUT` | `20` | seconds for each `docker node ls` / `docker node inspect` call; a call that does not answer is a blind spot. Keep it well under the unit's `TimeoutStartSec` (2 min), together with the workers x `REMOTE_TIMEOUT` and the Slack post |
| `SSH_OPTS` | BatchMode, ConnectTimeout 8, accept-new | ssh options |
| `STATE_DIR` | `/var/lib/swarm-node-watch` | dedupe state (set by the unit) |

A bad number never silently disables a check: it falls back to the default and logs a WARN.

The default threshold of 3 is deliberately above the 2026-11-24 baseline of about 1.2 waves an hour: it pages when the link is
worse than that baseline, or in a burst (the sliding-hour maximum seen that day was 3). Set `WAVE_THRESHOLD=1` to be told about
every wave.

## Test

```sh
bash ops/swarm-node-watch/test-node-watch.sh      # exit 0 = all PASS
```

Mocks `docker`, `ssh`, `curl` and `jq` on PATH (no swarm, no network, no real `jq`) and runs the real script. It covers: the
pure functions (wave counting with merge and window edges, node classification, key hygiene, the decision table); a healthy
cluster staying silent; Down, Drain, Pause, Unknown and an Unreachable manager paging; dedupe, REMINDER, RECOVERED and the
two-run flap guard; a second node changing the set; `EXPECTED_NODES`; waves at, below and above the threshold, adjacent
minutes merging, `WAVE_THRESHOLD=0`, and the hysteresis; both signals in one message; every blind spot (node list, SSH, a
journal answer without the `WAVES_OK` sentinel, a remote `journalctl` failure) alerting instead of reading as zero; no
webhook, the placeholder webhook and Slack down (exit codes, state not recorded, retried); the webhook never printed; and the
`TEST_ALERT` path. It also covers the two ways the swarm read itself can fail: a `docker node ls` or `docker node inspect` that
HANGS is cut by `SWARM_READ_TIMEOUT` inside an emulated unit cap (one alert after `BLIND_RUNS`, deduped, a REMINDER later, then
RECOVERED), and a FAILED or hung listing between clean runs never posts RECOVERED: the first failed read leaves the stored
alert state (`active`, `since`, `last_alert`, `ok_streak`) exactly as it was, and a confirmed blind spot carries the active
alerts forward next to `blind:nodels` (original `since` kept), through REMINDER, recovery, and a problem that is still there
when the list answers again. The install-time `TEST_ALERT` reports an unreadable list as UNKNOWN, never as "no problems".

## Known limits

- It samples. The wave check closes most of the gap, but it depends on dockerd's log wording
  (`heartbeat to manager ... failed`, `agent: session failed`, as seen on 2026-11-24). If a Docker upgrade changes the text the
  count reads 0 silently: compare the `waves(60m)` log lines or the `TEST_ALERT` message with
  `journalctl -u docker --since -60min | grep -E 'heartbeat to manager|session failed'` on a worker after any Docker upgrade.
- It cannot watch itself or the manager. If VPS2 is down this host is down too; `scripts/periodic-job-heartbeat.sh` (daily,
  GitHub Actions) is the outer net, and a FAILED unit in `systemctl --failed` is the signal for this one.
- It watches every node of the shared swarm, the staging node included, and posts to one channel.
- It detects and reports. It cannot tell a hypervisor stall from a network fault; that needs the evidence in the mission docs.
