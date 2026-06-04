# image-freshness-reconciler

Closes the "GHA build succeeded but the container never rolled" gap (observed
5× on 2026-06-03: campaign-service ×3, BFF, FE). The per-repo `deploy-prod.yml`
fires `application.deploy` at Dokploy **fire-and-forget**; when Dokploy drops
the deployment, prod keeps running the previous image silently.

## What it does

Every 5 minutes on the **swarm manager (VPS2)**, for every service whose image
is `ghcr.io/revhero-llc/*` (auto-discovered — covers all prod *and* staging
services, present and future; nats/redis/traefik are skipped):

1. `docker pull <tag>` (manifest-only when unchanged) and compare:
   - **tier 1:** registry image `Created` vs the running task `CreatedAt`
     (+120s grace). Task older than the image ⇒ a published image never rolled.
   - **tier 2 (VPS2-local containers):** exact image-ID mismatch.
2. Stale ⇒ `docker service update --force --detach=false` (manager resolves the
   tag to the current digest, so the node pulls the right image) + Slack alert.
3. Back-offs: skips services mid-update (won't race a real deploy); won't
   re-heal the same service within 30 min — if it's stale *again* that fast it
   alerts `:rotating_light:` and leaves it for a human.

Known residual gap (accepted): a task that crash-restarts on a node holding a
stale cache *after* the image was published looks "fresh" to tier 1 on remote
nodes (VPS1/VPS3); tier 2 catches it only for VPS2-local containers. Real
deploys and healer force-rolls always resolve digests, so this is rare.

## Install (VPS2)

```bash
scp image-freshness-reconciler.sh root@147.93.1.174:/usr/local/bin/
scp image-freshness-reconciler.{service,timer} root@147.93.1.174:/etc/systemd/system/
ssh root@147.93.1.174 '
  chmod +x /usr/local/bin/image-freshness-reconciler.sh
  # reuse the overlay-healer Slack webhook
  grep ^SLACK_WEBHOOK= /etc/revhero/overlay-routing-healer.env > /etc/revhero/image-freshness-reconciler.env
  systemctl daemon-reload
  systemctl enable --now image-freshness-reconciler.timer
'
```

Logs: `journalctl -u image-freshness-reconciler.service -n 50`

## Verified

2026-06-04: deployed; negative pass clean over 29 services; positive test —
out-of-band derivative image pushed to `:staging` for `staging-hubspot-service`
(no Dokploy trigger) was detected and force-rolled on the next run, Slack alert
fired; canonical image rebuilt afterwards via a normal staging deploy.
