# upload-health-probe

Hourly systemd timer that uploads a file to **cloud-documents-service** and then **fetches it back**,
failing loud to Slack if either half breaks.

## Why this exists

Before 2026-09-16, `cloud-documents-service` was monitored by **nothing**. It is absent from
`scripts/periodic-job-heartbeat.sh`'s `JOBS` array, and none of the seven other `ops/` monitors touch
storage. The only detector for a broken upload path was a customer complaint.

That mattered more after uploads moved from Cloudinary to S3, because the new failure modes are
**silent on the read side**.

### Why not just add it to periodic-job-heartbeat.sh

That was the original plan and it does not work. Every `JOBS` entry is

```
name|service|LOG-MARKER|expected-interval-minutes|max-age
```

i.e. it greps for a **recurring log marker emitted by a periodic background job**. cloud-documents is
a request-serving HTTP service with **no periodic job**, so it emits no such marker. An entry there
would either never fire or always alarm. It needs a probe that generates its own traffic.

### Why the FETCH is the whole point

Public read on `revhero-user-uploads-{prod,staging}` is granted by a **bucket policy**, not by
per-object ACLs — the buckets are `ObjectOwnership=BucketOwnerEnforced`, which rejects ACL-bearing
requests outright. So if someone re-enables Block Public Access, edits the policy, or rotates the IAM
key:

> **uploads keep returning 200 while every stored URL 403s for the reader.**

A write-only check stays green through all of that, and reproduces exactly the blind spot it was
meant to close. The anonymous `GET` is the assertion that matters; the upload is just how we get
something to fetch.

This is the same shape as the **2026-06 mailbox-watch lapse** documented in
`ops/mailbox-watch-renewer/`: the health flag kept reporting connected while the thing it measured had
silently stopped. Hence the same remedy — an active probe that **fails loud**.

## What each run asserts

1. `POST /v1/upload/` returns 200/201 and a `url`.
2. That URL is **not** a Cloudinary URL — after the cutover, one would mean something still routes there.
3. An **anonymous** `GET` of that URL returns **200**.
4. The fetched bytes **match what was uploaded** — a unique timestamped body per run, so a stale or
   cached object cannot pass for a fresh one.

Any failure logs and posts to `SLACK_WEBHOOK_DEPLOYS`. A non-zero exit without the webhook set is
still an exit code, but nobody sees it — set the webhook.

## Install (VPS2)

```bash
sudo install -m 0755 upload-health-probe.sh /usr/local/bin/upload-health-probe.sh
sudo install -m 0644 upload-health-probe.service /etc/systemd/system/
sudo install -m 0644 upload-health-probe.timer   /etc/systemd/system/
sudo install -D -m 0600 upload-health-probe.env.example /etc/revhero/upload-health-probe.env
sudo "$EDITOR" /etc/revhero/upload-health-probe.env     # set SLACK_WEBHOOK_DEPLOYS
sudo systemctl daemon-reload
sudo systemctl enable --now upload-health-probe.timer
```

Verify it actually fires — a timer that cannot run is indistinguishable from one that always passes:

```bash
systemctl list-timers upload-health-probe.timer
sudo systemctl start upload-health-probe.service && journalctl -u upload-health-probe -n 30 --no-pager
```

## ⚠️ Do not arm this before the S3 cutover

Until `RevHero-FE-New` #327 and `cloud-documents` #33 are deployed, uploads still go to Cloudinary,
and assertion 2 will fire on every run. Arm it as the **last step** of the cutover (see the cutover
task), not before.

## Housekeeping

Each run leaves one small object under the `health-probe/` prefix. Add an S3 lifecycle rule expiring
that prefix after ~7 days rather than deleting from the probe: a probe that deletes what it just
wrote cannot distinguish "the object is gone because I removed it" from "the object was never
durable".
