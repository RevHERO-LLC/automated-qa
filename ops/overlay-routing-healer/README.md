# Overlay Routing Healer

Automatically detects and repairs stale Docker Swarm overlay IPVS routing on the RevHero production cluster.

## The Problem

After a Docker Swarm task replacement (e.g., a service redeploy), the IPVS rules in the `dokploy-network` overlay mesh can go stale on the manager node (VPS2). The container is healthy and reachable from within the overlay network, but Traefik on VPS2 returns `504 Bad Gateway` because its upstream routing entry points to the old task's virtual IP.

Manual fix: `docker service update --force --detach=false <service-name>` from the swarm manager.

This has occurred at least twice: 2026-04-28 and 2026-05-13.

## What the Healer Does

Every 5 minutes (via systemd timer):

1. Fetches all `applicationStatus == "done"` apps from the local Dokploy API.
2. For each app with a configured domain, probes the public HTTPS URL.
3. If the public probe returns `000` (timeout) or `504`, probes the container directly via `dokploy-network` overlay.
4. If the overlay probe responds (any HTTP code), stale routing is confirmed.
5. Checks swarm `UpdateStatus` — skips if a deploy is already in progress.
6. Runs `docker service update --force --detach=false <name>` to refresh IPVS rules.
7. Waits up to 90 seconds for the public URL to converge.
8. Posts a Slack alert (debounced to once per service per hour).

If the overlay probe also returns `000`, the script treats it as a real outage and skips the force-update (it wouldn't help, and masking the outage would be worse).

## Installation

Only install on **VPS2 (147.93.1.174)** — the swarm manager. Only the manager node can run `docker service update`.

```bash
git clone https://github.com/RevHERO-LLC/automated-qa.git /opt/automated-qa
# or: git -C /opt/automated-qa pull origin main
sudo bash /opt/automated-qa/ops/overlay-routing-healer/install.sh
```

The install script:
- Copies the checker script to `/usr/local/bin/check-and-fix-overlay-routing.sh`
- Copies `.service` and `.timer` units to `/etc/systemd/system/`
- Writes env vars to `/etc/revhero/overlay-routing-healer.env` (mode 0600)
- Enables and starts `overlay-routing-healer.timer`

## Configuration

Environment file: `/etc/revhero/overlay-routing-healer.env`

```
DOKPLOY_API_KEY=<key>
SLACK_WEBHOOK=<url>
```

## Viewing Logs

```bash
# Current/recent run output
journalctl -u overlay-routing-healer.service --no-pager -n 100

# Follow live during a manual trigger
journalctl -u overlay-routing-healer.service -f

# All runs today
journalctl -u overlay-routing-healer.service --since today --no-pager
```

## Timer Status

```bash
# Show next scheduled run
systemctl list-timers overlay-routing-healer.timer --no-pager

# Show timer + service status
systemctl status overlay-routing-healer.timer
systemctl status overlay-routing-healer.service
```

## Manual Trigger

```bash
sudo systemctl start overlay-routing-healer.service
# Then watch the output:
journalctl -u overlay-routing-healer.service -f --no-pager
```

## Disabling

```bash
# Stop the timer (survives reboot, service won't auto-run)
sudo systemctl disable --now overlay-routing-healer.timer

# Re-enable
sudo systemctl enable --now overlay-routing-healer.timer
```

## Debounce State

Debounce timestamps are stored in `/var/lib/overlay-routing-healer/last-fixed-<svc>`. Each file contains the Unix epoch of the last Slack alert for that service. Delete a file to reset the debounce for that service.

## Limitations

- Only checks apps registered in Dokploy with `applicationStatus == "done"` and at least one configured domain.
- The overlay probe uses port 80 — services that don't listen on 80 at the container level will return a non-000 code (likely 404 or similar) which still confirms the container is alive.
- The healer does not restart containers — it only refreshes swarm routing. If the container itself is crashed, the overlay probe returns `000` and the run is skipped.
