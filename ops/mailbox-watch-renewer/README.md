# mailbox-watch-renewer

Systemd timer on **VPS2** that keeps email-ingress's Gmail/Microsoft **push watch subscriptions** renewed, so inbound email keeps being ingested.

## Why this exists (2026-06-22 incident)

Gmail `users.watch` push subscriptions expire after ~7 days; email-ingress sets its own `email_subscriptions.expires_at` to +6d and re-arms a watch only within **4h of expiry** (`mailbox.service.go:457`, endpoint `POST /v1/user-mailboxes/refresh-expired-google`). A cron must hit that endpoint regularly.

That cron used to be a **Dokploy schedule ("Google Mailbox Refresh prod")**. It was enabled and its script worked, but Dokploy's scheduler **silently stopped firing it ~2026-06-19**. With no renewal, watches lapsed one-by-one across the fleet (~40 of 64 subscription rows expired); `josh@gigapress.net` went dark and a customer's POSITIVE reply (in the normal inbox) was never pushed to us → never ingested → "missing from the inbox entirely." The mailbox still showed `is_connected=true` (a token-refresh path kept it looking healthy), so the failure was invisible.

This timer replaces that unreliable scheduler and, critically, **fails loud** (see "Alerting" below).

## Behavior

- Runs **every 2h** (< the 4h re-arm gate, so no mailbox lapses between runs).
- POSTs `refresh-expired-google` + `refresh-expired-microsoft` (async, idempotent — they re-arm only the expiring/expired mailboxes). Since #1057 email-ingress gates `/v1/user-mailboxes` with its internal-auth check (log-only until `INTERNAL_AUTH_ENFORCE=true`), so the renewer sends `X-Internal-Secret` from `EMAIL_INGRESS_INTERNAL_SECRET` in the env file — set it before email-ingress enforces or renewals 401 and watches lapse.
- Logs each result via `logger -t mailbox-watch-renewer` (journald).
- Alerting (#1249), per endpoint: success is any 2xx; HTTP 000 (no answer), 4xx and 5xx are failed runs. Consecutive failed runs are counted in `/var/lib/mailbox-watch-renewer/` and ONE Slack alert is posted when the count reaches `ALERT_AFTER_FAILURES` (default 2, so a single 502 during an email-ingress restart does not page). The same outage re-alerts as a labelled reminder every `REMIND_EVERY` runs (default 12 = 24 h). When an endpoint that alerted answers 2xx again, ONE RECOVERED message is posted. Same Slack mechanism and state shape as `ops/analytics-alarm-deadman` and `ops/overlay-fdb-detector`.
- The alert path cannot fail silently: an unset `SLACK_WEBHOOK`, or a Slack post that was not accepted (`curl -f`), is logged at `user.err` (`journalctl -t mailbox-watch-renewer -p err`) and the alert state is NOT recorded, so the next run tries again. The unit still exits 1 on any failed run (`systemctl --failed`). If the state dir is unusable it alerts on every failed run instead of going quiet.

## Install (VPS2)

```sh
install -m 755 mailbox-watch-renewer.sh /usr/local/bin/mailbox-watch-renewer.sh
install -m 644 mailbox-watch-renewer.service /etc/systemd/system/
install -m 644 mailbox-watch-renewer.timer   /etc/systemd/system/
# env (chmod 600); reuse SLACK_WEBHOOK from overlay-routing-healer.env
cp mailbox-watch-renewer.env.example /etc/revhero/mailbox-watch-renewer.env  # then edit SLACK_WEBHOOK
chmod 600 /etc/revhero/mailbox-watch-renewer.env
systemctl daemon-reload
systemctl enable --now mailbox-watch-renewer.timer
systemctl start mailbox-watch-renewer.service   # test run
journalctl -t mailbox-watch-renewer -n 10 --no-pager
```

## Related follow-ups (email-ingress code, not yet shipped)

- **404 self-heal**: on Gmail `history.list` 404 (stale `last_history_id`), reset the cursor to current + re-watch instead of looping forever (`email.service.go:146`). This is the *other* stall mode (mailbox stuck despite a live watch).
- Fix subscription-row persistence on re-arm; widen the 4h re-arm gate; add `CATEGORY_*` watch labels (Promotions/Updates).

## Verify the alert path (after install, and after any webhook change)

```sh
TEST_ALERT=true /usr/local/bin/mailbox-watch-renewer.sh   # posts ONE test message, renews nothing; exit 0 = Slack accepted it, 2 = webhook unset, 1 = post refused
```

Why this exists: the 2026-11-10 18:39Z to 11-11 22:37Z outage (#1249) was 28 h of HTTP 000 (every call hung to curl's 150 s timeout; email-ingress's mailbox-list query had no deadline) and no alert could be found. The first version of this script paged on ANY single non-200 but swallowed every problem with the page itself, so an unset or dead webhook was invisible. email-ingress now answers 503 within 20 s instead of hanging (RevHero-email-ingress #230); a persistent 503 alerts on the 2nd consecutive run.

## Self-test

```sh
bash ops/mailbox-watch-renewer/test-mailbox-watch-renewer.sh   # hermetic: mocks curl + logger, throwaway STATE_DIR; exit 0 = all PASS
```
