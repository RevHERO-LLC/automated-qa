# mailbox-watch-renewer

Systemd timer on **VPS2** that keeps email-ingress's Gmail/Microsoft **push watch subscriptions** renewed, so inbound email keeps being ingested.

## Why this exists (2026-06-22 incident)

Gmail `users.watch` push subscriptions expire after ~7 days; email-ingress sets its own `email_subscriptions.expires_at` to +6d and re-arms a watch only within **4h of expiry** (`mailbox.service.go:457`, endpoint `POST /v1/user-mailboxes/refresh-expired-google`). A cron must hit that endpoint regularly.

That cron used to be a **Dokploy schedule ("Google Mailbox Refresh prod")**. It was enabled and its script worked, but Dokploy's scheduler **silently stopped firing it ~2026-06-19**. With no renewal, watches lapsed one-by-one across the fleet (~40 of 64 subscription rows expired); `josh@gigapress.net` went dark and a customer's POSITIVE reply (in the normal inbox) was never pushed to us → never ingested → "missing from the inbox entirely." The mailbox still showed `is_connected=true` (a token-refresh path kept it looking healthy), so the failure was invisible.

This timer replaces that unreliable scheduler and, critically, **fails loud**: any non-200 from the renewal endpoint posts to the deploy Slack channel.

## Behavior

- Runs **every 2h** (< the 4h re-arm gate, so no mailbox lapses between runs).
- POSTs `refresh-expired-google` + `refresh-expired-microsoft` (both unauth, async, idempotent — they re-arm only the expiring/expired mailboxes).
- Logs each result via `logger -t mailbox-watch-renewer` (journald).
- On any non-200, Slack-alerts the deploy channel.

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
