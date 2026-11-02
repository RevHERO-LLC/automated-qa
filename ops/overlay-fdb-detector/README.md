# overlay-fdb-detector

Detector, with an opt-in **guarded auto-repair** (#220), for the Docker Swarm overlay partition
that silently killed all outbound email for ~6 days (2026-08-31 and again 2026-09-03) and has hit
prod six times since 08-30 (users x2, campaign/ai-agent, deals-actions, Redis, sms).

## The fault it catches

A healthy overlay peer needs **two** things in a node's `vxlan0`: an ARP/neigh
entry (IP->MAC) *and* a forwarding-DB VTEP entry (MAC->peer-host-IP,
`bridge fdb ... dst <ip> self permanent`). The bug: on a node, the `dst` line for
specific peer container MACs **silently vanishes while the neigh entry remains**.
The node then knows the MAC exists but has nowhere to tunnel frames - every
connection to that container black-holes (`dial tcp i/o timeout`) until the entry
is re-added. Underlay ping works, firewall is fine, gossip is fine; only
the VTEP is gone. It is an upstream libnetwork bug (moby #52265 / #52661) with no fix and no
self-healing, so it recurs.

The existing `overlay-routing-healer` cannot see this: it probes Traefik->VIP HTTP
reachability from the manager node, where the affected services also run, so its
checks never cross the broken edge. This detector works at the L2 forwarding
layer, **per node**, which is where the fault actually lives.

## What it does

Every 10 min, on the manager (VPS2), for **every swarm node** (local + SSH to
each worker) and **every overlay netns**: computes the set of MACs with a
`PERMANENT` neigh entry minus the set with a `dst` fdb entry. Any leftover MAC is
a broken VTEP -> **Slack alert** (node, netns, MAC, overlay IP, resolved container
name, resolved owner node, and a ready-to-paste repair command). Alerting is keyed on the gap
SET: a new or changed set alerts immediately, an unchanged set re-alerts at most every
`REMIND_HOURS` (labelled REMINDER), and a cleared set posts one "resolved" notice and resets.

## Auto-repair (#220) - DRY-RUN IS THE DEFAULT

The 10-27 sms gap cost about 2 hours of human latency, so the detector can apply the fix itself.
Because a wrong MAC->node mapping would silently tunnel traffic to the wrong host (worse than the
gap), every repair passes these guards, in this order:

| guard | what happens when it is not met |
|---|---|
| **Armed explicitly**: `AUTO_REPAIR_ENABLED=true` (exact string) **and** `SLACK_WEBHOOK` set | dry-run: logs and alerts exactly what it *would* do, changes nothing. Armed without a webhook is refused (no silent prod mutation) |
| **Complete cluster view**: every node answered the survey | alert-only (an unseen node could hold the conflicting claim) |
| **Unambiguous owner** (the #939 resolver, hardened): exactly ONE node reports the gap's IP **and** exactly ONE reports its MAC, they are the SAME node, it is a plain IPv4, and it is not the gap node itself | alert-only with the reason (`UNRESOLVED`, or `AMBIGUOUS: ...` - several nodes claim it, IP and MAC disagree, owner is the gap node, ...). Never a guess |
| **Cap**: at most `MAX_REPAIRS_PER_HOUR` (3, hard ceiling 3) mutations fleet-wide per rolling hour (ledger on this manager-only host) | alert-only: "hourly cap reached (3/3)" |
| **No recent failed attempt** at the same gap (within `REPAIR_BLOCK_HOURS`, 6) | alert-only: a repair that did not verify is never retried in a loop |
| **BEFORE test from a REAL caller container** on the gap node: `nsenter -t <container pid> -n ping <target ip>` must FAIL | already reachable -> not touched; no real caller on the node, or the probe cannot run -> alert-only (never change what cannot be verified). **Never the overlay gateway netns** - it shows 100% loss even when fixed |
| **Re-resolved from scratch + gap re-confirmed** immediately before the write (fresh `docker network inspect` on every node, fresh `bridge fdb show`) | owner changed/ambiguous -> alert-only; gap healed by itself -> nothing to do |
| **Ledger written first** (fail closed) | no ledger record, no mutation |
| **AFTER test from the same caller** must PASS | not verified -> the entry is **reverted** (`bridge fdb del`, which restores the exact pre-state because the gap had no dst entry), and the gap is not auto-retried for `REPAIR_BLOCK_HOURS` |

The write is `bridge fdb replace <mac> dev vxlan0 dst <owner> self permanent` in the gap node's
overlay netns (idempotent). Every executed repair is announced in Slack **with what it did, the
BEFORE/AFTER results, and the exact UNDO command**, plus how many repairs were used this hour.
Gaps that were repaired and verified drop out of the gap alert; the rest stay in it, each with the
reason it was not repaired.

Not covered, by design: a `dst` entry that exists but points at the WRONG node (the detector only
sees *missing* entries); and the underlying libnetwork bug itself.

### Arming it (a deliberate, separate step - NOT done by merging this repo)

1. Install/upgrade on VPS2 (below). It starts in **DRY-RUN**: nothing changes.
2. Watch a few gap alerts. Each says `AUTO-REPAIR DRY-RUN (nothing changed): would run ...`.
3. When the "would run" lines look right, set `AUTO_REPAIR_ENABLED=true` in
   `/etc/revhero/overlay-fdb-detector.env` (and keep `SLACK_WEBHOOK` set). The next timer run is armed.
4. `TEST_ALERT=true` posts one message that names the current mode (`dry-run` / `armed`).
5. To disarm: remove the line (or set anything but `true`). The ledger is at
   `/var/lib/overlay-fdb-detector/repair-ledger` (`<epoch> <mac>@<gap-node> <owner> <outcome>`).

## Deploy (VPS2 systemd timer)

```sh
sudo bash ops/overlay-fdb-detector/install.sh
sudo vi /etc/revhero/overlay-fdb-detector.env   # SLACK_WEBHOOK
sudo systemctl start overlay-fdb-detector.service
```

Requires node->node root SSH from the manager (already trusted) and `jq`/`curl`/`nsenter`/`bridge`/`ping`
(standard; `ping` is only needed on the nodes for the real-caller probe, and its absence just makes the repair
alert-only). Reuses the org Slack webhook. The unit has `TimeoutStartSec=5min`, so a hung run becomes a failed unit
instead of silently stopping the timer.

## Config (env)

| var | default | meaning |
|---|---|---|
| `SLACK_WEBHOOK` | - | incoming webhook; unset => log-only (and auto-repair can never arm) |
| `AUTO_REPAIR_ENABLED` | unset (**dry-run**) | exactly `true` arms #220 auto-repair; anything else is dry-run |
| `MAX_REPAIRS_PER_HOUR` | `3` | mutations per rolling hour, fleet-wide. Clamped to <= 3; garbage falls back to 3 |
| `REPAIR_BLOCK_HOURS` | `6` | no auto-retry of a gap whose repair failed verification / could not be applied or undone |
| `STATE_DIR` | `/var/lib/overlay-fdb-detector` | alert state + the repair ledger |
| `REMIND_HOURS` | `24` | re-alert interval for an UNCHANGED gap set (new/changed sets alert immediately) |
| `DEBOUNCE_HOURS` | - | retired (was the flat 2h repeat); ignored |
| `TEST_ALERT` | `false` | `true` => post one Slack message (validates the path, names the mode) |
| `NETNS_DIR`, `REMOTE_TIMEOUT`, `FDB_NOW_EPOCH` | `/var/run/docker/netns`, `40`, - | tests / tuning only |

## When it alerts instead - manual repair

On the named node's overlay netns (the alert prints this, with the owner resolved):
`bridge fdb replace <mac> dev vxlan0 dst <peer-host-ip> self permanent`
(peer-host-ip = the advertise IP of the node running that container). Then verify from the
*real caller container* (`nsenter -t $(docker inspect -f '{{.State.Pid}}' <cid>) -n ping ...`),
never from the netns gateway. Undo: `bridge fdb del <mac> dev vxlan0 dst <peer-host-ip> self permanent`.
Full runbook: project memory `reference_overlay_users_service_partition.md`.

## Tests

```sh
bash ops/overlay-fdb-detector/test-alert-cadence.sh   # alert cadence (pure functions)
bash ops/overlay-fdb-detector/test-auto-repair.sh     # #220: the real script against a mocked 3-node swarm
```

`test-auto-repair.sh` mocks `docker`/`ssh`/`nsenter`/`ip`/`bridge`/`curl`/`jq` on PATH (no swarm, no root).
The mock ping succeeds only if the caller node holds a VTEP for the target MAC that points at the node that
REALLY owns it, so a wrong repair cannot pass verification. It covers: dry-run default (and that only the exact
string `true` arms it), armed repair with before/after from the real caller and the Slack undo, the refusal to
arm without a webhook, ambiguous / unresolved owners, an incomplete cluster view, the hourly cap (4 gaps => 3
repaired; the window sliding; the 4th repaired an hour later; the cap not raisable above 3), already-reachable,
no caller, probe unavailable, owner-changed and gap-healed between the BEFORE test and the write, an unverified
repair being reverted and not retried for 6h, a failed revert, a failed apply, an unwritable ledger (fail closed),
and a mixed run. Plus unit tests for the resolver, ledger and validators.

## Known limits

- A manual run and the timer run are serialised with `flock` when it is available (it is on VPS2); without
  it a manual run could overlap the timer and exceed the cap by one.
- The real-caller probe uses ICMP. A target container that drops ICMP looks "unreachable" both before and after,
  so the repair is verified as failed and reverted (safe, but it then needs a human).
