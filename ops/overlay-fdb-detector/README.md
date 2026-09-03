# overlay-fdb-detector

**LOG-ONLY** detector for the Docker Swarm overlay partition that silently killed
all outbound email for ~6 days (2026-08-31 and again 2026-09-03).

## The fault it catches

A healthy overlay peer needs **two** things in a node's `vxlan0`: an ARP/neigh
entry (IP→MAC) *and* a forwarding-DB VTEP entry (MAC→peer-host-IP,
`bridge fdb ... dst <ip> self permanent`). The bug: on a node, the `dst` line for
specific peer container MACs **silently vanishes while the neigh entry remains**.
The node then knows the MAC exists but has nowhere to tunnel frames — every
connection to that container black-holes (`dial tcp i/o timeout`) until the entry
is manually re-added. Underlay ping works, firewall is fine, gossip is fine; only
the VTEP is gone.

The existing `overlay-routing-healer` cannot see this: it probes Traefik→VIP HTTP
reachability from the manager node, where the affected services also run, so its
checks never cross the broken edge. This detector works at the L2 forwarding
layer, **per node**, which is where the fault actually lives.

## What it does

Every 10 min, on the manager (VPS2), for **every swarm node** (local + SSH to
each worker) and **every overlay netns**: computes the set of MACs with a
`PERMANENT` neigh entry minus the set with a `dst` fdb entry. Any leftover MAC is
a broken VTEP → **Slack alert** (node, netns, MAC, overlay IP, resolved container
name). Debounced; Slack failure non-fatal; every run logs the result for liveness.

**It does NOT repair anything.** Auto-`bridge fdb add` across every node's root
netns on a timer is deliberately out of scope — the blast radius of a wrong
MAC→node mapping (traffic silently sent to the wrong host) is worse than the gap
it fixes. Repair stays a human action on the alert (or a future, separately
reviewed tool), using the command the alert prints.

## Deploy (VPS2 systemd timer)

```sh
sudo bash ops/overlay-fdb-detector/install.sh
sudo vi /etc/revhero/overlay-fdb-detector.env   # SLACK_WEBHOOK
sudo systemctl start overlay-fdb-detector.service
```

Requires node→node root SSH from the manager (already trusted) and `jq`/`curl`/
`nsenter`/`bridge` (standard). Reuses the org Slack webhook.

## Config (env)

| var | default | meaning |
|---|---|---|
| `SLACK_WEBHOOK` | — | incoming webhook; unset ⇒ log-only |
| `STATE_DIR` | `/var/lib/overlay-fdb-detector` | debounce marker dir |
| `DEBOUNCE_HOURS` | `2` | min gap between repeat alerts |
| `TEST_ALERT` | `false` | `true` ⇒ post one Slack message (validate path) |

## When it fires — repair

On the named node's overlay netns:
`bridge fdb add <mac> dev vxlan0 dst <peer-host-ip> self permanent`
(peer-host-ip = the public/advertise IP of the node running that container). Then
verify from the *real caller container* (`nsenter -t $(docker inspect -f
'{{.State.Pid}}' <cid>) -n curl ...`), never from the netns gateway. Full runbook:
project memory `reference_overlay_users_service_partition.md`.
