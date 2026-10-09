# image-freshness-reconciler

Closes the "GHA build succeeded but the container never rolled" gap (observed
5× on 2026-06-03: campaign-service ×3, BFF, FE). The per-repo `deploy-prod.yml`
fires `application.deploy` at Dokploy **fire-and-forget**; when Dokploy drops
the deployment, prod keeps running the previous image silently.

## What it does

Every 5 minutes on the **swarm manager (VPS2)**, for every service whose image
is `ghcr.io/revhero-llc/*` **or `registry.revhero.io/revhero-llc/*`**
(auto-discovered; covers all prod *and* staging services, present and future;
nats/redis/traefik and the registry's own public image are skipped):

> Since P6 #84 (2026-10-05) the fleet pulls from the self-hosted registry
> `registry.revhero.io`. Its tags are pulled with a dedicated READ-ONLY login
> (`dokploy-pull` robot) kept in `REGISTRY_DOCKER_CONFIG`
> (`/etc/revhero/reconciler-docker`), never in root's `~/.docker/config.json`.
> Lane-2 stays on ghcr.io until it is migrated. After the ghcr.io credential is
> revoked, its pulls fail and those services are skipped with a WARN, never
> healed. `DRY_RUN=1` logs "would heal" without updating or alerting. A full
> pass over about 68 services takes about 4 min.

1. `docker pull <tag>` (manifest-only when unchanged) and compare:
   - **tier 1:** registry image `Created` vs the running task `CreatedAt`
     (+120s grace). Task older than the image ⇒ a published image never rolled.
   - **tier 2 (VPS2-local containers):** exact image-ID mismatch.
2. Stale ⇒ `docker service update --force --detach=false` (manager resolves the
   tag to the current digest, so the node pulls the right image) + Slack alert.
3. Back-offs: skips services mid-update (won't race a real deploy); won't
   re-heal the same service within 30 min — if it's stale *again* that fast it
   alerts `:rotating_light:` and leaves it for a human.
4. **tier 3 (#940, DETECT-ONLY):** independently of 1/2, resolves the branch
   the service's tag claims to track (`staging*` → `staging`, `prod*` →
   `main`) via the GitHub API, rebuilds the tag that branch's HEAD commit
   would have produced, and compares ITS pulled image ID against the
   currently-pinned tag's image ID. A mismatch — once that HEAD commit is
   older than `SHA_GRACE_SECS` (10 min), so a normal deploy would have
   finished — is logged and Slack-alerted (`:mag:`, separately debounced from
   the tier-1/2 alerts). **Never heals, never calls `docker service update`.**
   Needs `GITHUB_READ_TOKEN`; without it tier 3 is skipped entirely (one
   startup log line) and tiers 1/2 run exactly as before.

Known residual gaps (accepted, documented from the 2026-06-04 drills):

1. A task that crash-restarts on a node holding a stale cache *after* the
   image was published looks "fresh" to tier 1 on remote nodes (VPS1/VPS3);
   tier 2 catches it only for VPS2-local containers.
2. **Zero-diff rebuilds keep the old image `Created`** (BuildKit full cache
   hit reproduces the cached config — seen on an empty-commit rebuild AND on
   LABEL-only builds), so tier 1 can't flag them if the roll is missed. Real
   deploys change code layers and always get a fresh `Created`, so the
   production failure mode is covered. If this ever matters, the upgrade path
   is digest-state tracking (remember last-seen registry digest per service,
   heal when it changes without a newer task). **Tier 3 is actually immune to
   this one** — it compares image IDs (content), not timestamps, so a
   zero-diff rebuild that legitimately matches HEAD never false-flags.
3. Dokploy ALSO early-rolls on the git push webhook (before the image is
   built) — harmless restart on the old image, later corrected by the
   workflow's `application.deploy` (or by this reconciler).
4. ~~A per-SHA-tag service whose Dokploy `dockerImage` spec was never
   advanced past an older `:env-<sha>` reads as healthy — tiers 1/2 only
   check the running image against the tag it's ALREADY pinned to, never
   against the tag it SHOULD be pinned to.~~ **Closed (detect-only) by tier 3
   above (#940).** It reports the mismatch; it does not fix it — the fix is
   still a manual `docker service update --force --with-registry-auth` or a
   Dokploy re-trigger, same as any other reconciler alert.
5. Tier 3 is best-effort, not exhaustive: a service whose tag isn't
   `staging*`/`prod*`, whose image name doesn't resolve to a real
   `RevHERO-LLC` repo, or whose expected tag hasn't been pushed yet (build
   still in flight) is reported `sha_unknown` and silently skipped for that
   cycle — by design (fail-safe over false alarms), per the summary line's
   `sha_unknown=N` count.

## Install (VPS2)

```bash
scp image-freshness-reconciler.sh root@147.93.1.174:/usr/local/bin/
scp image-freshness-reconciler.{service,timer} root@147.93.1.174:/etc/systemd/system/
ssh root@147.93.1.174 '
  chmod +x /usr/local/bin/image-freshness-reconciler.sh
  # reuse the overlay-healer Slack webhook
  grep ^SLACK_WEBHOOK= /etc/revhero/overlay-routing-healer.env > /etc/revhero/image-freshness-reconciler.env
  # read-only registry login for registry.revhero.io tags (pipe the dokploy-pull
  # password in over stdin; never put it on a command line):
  #   install -d -m 700 /etc/revhero/reconciler-docker
  #   DOCKER_CONFIG=/etc/revhero/reconciler-docker docker login registry.revhero.io -u dokploy-pull --password-stdin
  echo REGISTRY_DOCKER_CONFIG=/etc/revhero/reconciler-docker >> /etc/revhero/image-freshness-reconciler.env
  # tier 3 (#940): a read-only PAT, Contents:Read across the RevHERO-LLC fleet
  # repos — the same scope as the FLEET_READ_TOKEN GitHub Actions secret used
  # by .github/workflows/staging-prod-drift-check.yml (can be the identical
  # token, copied in rather than minted fresh). Omit this line to leave tier 3
  # disabled — tiers 1/2 are unaffected either way.
  echo GITHUB_READ_TOKEN=... >> /etc/revhero/image-freshness-reconciler.env
  systemctl daemon-reload
  systemctl enable --now image-freshness-reconciler.timer
'
```

Logs: `journalctl -u image-freshness-reconciler.service -n 50`

## Testing

`test-sha-stuck-roll.sh` is a self-contained red/green regression test for
tier 3 — it mocks `docker`/`curl`/`jq` on `PATH`, so it needs no swarm, no
registry, no network, and no real `jq`/`docker` installed on the box running
it:

```bash
./test-sha-stuck-roll.sh   # exit 0 = all assertions passed
```

It runs the real script (not a reimplementation) against two synthetic
services — one pinned to a stale SHA, one already current — and asserts the
stale one is flagged `SHA-STUCK` and Slack-alerted, the current one is not,
and `docker service update` is never invoked (detect-only). There is no
existing test convention for the bash scripts under `ops/` (only the
Playwright/`vitest` suites under `runner/` have one), so this intentionally
stays a plain, dependency-free bash script rather than introducing a new
framework for one tool.

## Verified

2026-06-04: deployed; negative pass clean over 29 services; positive test —
out-of-band derivative image pushed to `:staging` for `staging-hubspot-service`
(no Dokploy trigger) was detected and force-rolled on the next run, Slack alert
fired; canonical image rebuilt afterwards via a normal staging deploy.

2026-10-09: tier 3 (#940) added and red/green-tested locally (see Testing
above) — **not yet deployed to VPS2.** The next person to ship this should
add `GITHUB_READ_TOKEN` to the live env file per Install above and watch one
real cycle's `sha_unknown` count before trusting `sha_stuck` alerts fleet-wide.
