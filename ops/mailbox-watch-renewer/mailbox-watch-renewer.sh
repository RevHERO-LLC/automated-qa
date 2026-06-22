#!/usr/bin/env bash
# Renew Gmail + Microsoft mailbox watch subscriptions in email-ingress.
#
# Replaces the unreliable Dokploy "Google Mailbox Refresh prod" schedule, which
# was enabled (cron `0 0 */2 * *`) with a working script yet silently stopped
# firing ~2026-06-19 -> Gmail push watches lapsed fleet-wide (a watch lives only
# ~7 days). josh@gigapress.net (and others) went dark; a customer's POSITIVE
# reply, sitting in the normal inbox, was never pushed to us and never ingested.
#
# This runs every 2h (well inside email-ingress's 4h re-arm gate so nothing
# lapses) and FAILS LOUD: any non-200 pings the deploy Slack channel — the
# opposite of Dokploy's silent failure.
#
# Install: see README.md. Env: /etc/revhero/mailbox-watch-renewer.env
set -uo pipefail
ENV_FILE=/etc/revhero/mailbox-watch-renewer.env
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
BASE="${EMAIL_INGRESS_BASE:-https://email-ingress.revhero.io}"
TAG=mailbox-watch-renewer
fail=0
results=""
for ep in refresh-expired-google refresh-expired-microsoft; do
  out=$(curl -sS -m 150 -w $'\n%{http_code}' -X POST "$BASE/v1/user-mailboxes/$ep" 2>&1) || true
  code=$(printf '%s' "$out" | tail -n1)
  body=$(printf '%s' "$out" | sed '$d' | tr '\n' ' ')
  logger -t "$TAG" "$ep -> HTTP ${code}: ${body}"
  results="${results}${ep}=HTTP${code}; "
  [ "$code" = "200" ] || fail=1
done
if [ "$fail" -ne 0 ] && [ -n "${SLACK_WEBHOOK:-}" ]; then
  msg=":rotating_light: *mailbox-watch-renewer FAILED on VPS2* - ${results}- Gmail/MS watch renewal did not return 200; email ingestion will lapse."
  curl -sS -m 20 -X POST -H 'Content-type: application/json' --data "{\"text\":\"${msg}\"}" "$SLACK_WEBHOOK" >/dev/null 2>&1 || true
fi
exit "$fail"
