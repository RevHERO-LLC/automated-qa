#!/usr/bin/env bash
# Keep internal_analytics daily partitions ahead of "now", in every lane.
#
# WHY THIS EXISTS, rather than pg_cron:
# migration 000006 defines internal_analytics.rotate_partitions() and schedules it with
#   SELECT cron.schedule('rotate-internal-analytics-partitions', '13 6 * * *', ...)
# but pg_cron is NOT INSTALLED and NOT EVEN AVAILABLE on this Postgres build
# (pg_available_extensions has no pg_cron). So that schedule was never created and the
# rotator has never once run. Partitions ran out after 2026-09-01 and EVERY analytics
# insert was rejected for 13 days, in BOTH prod and staging, with no signal at all --
# the collectors are deliberately fire-and-forget. Same outage as 2026-06-21..2026-08-02.
#
# Two deliberate design choices:
#   1. ensure_partitions() creates D..D+14, not just D+1 like rotate_partitions(). A single
#      missed run must never be an outage. The original had ZERO buffer.
#   2. It NEVER DROPS. Purely additive, so this job is safe to run unattended. Enabling the
#      90-day retention drop is a separate, data-destroying decision that a human must make.
#
# Credentials are read from the SERVICE SPEC at call time, so there is no copy here to go
# stale at the next rotation. `docker service inspect` is used rather than `docker exec`
# because it works from the manager for services scheduled on ANY node -- the staging
# analytics container does not run on the manager, so a `docker ps` lookup finds nothing
# and would silently skip that lane.
set -uo pipefail

DAYS_AHEAD="${DAYS_AHEAD:-14}"
rc=0

svc_env() { docker service inspect "$1" --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' 2>/dev/null; }

mapfile -t SERVICES < <(docker service ls --format '{{.Name}}' | while read -r S; do
  svc_env "$S" | grep -q '^ANALYTICS_DB_NAME=' && echo "$S"
done)

if [ "${#SERVICES[@]}" -eq 0 ]; then
  echo "::error::no service carries ANALYTICS_DB_NAME -- cannot top up partitions (is this the swarm manager?)"
  exit 1
fi

for S in "${SERVICES[@]}"; do
  ENVV=$(svc_env "$S")
  get() { printf '%s\n' "$ENVV" | grep "^$1=" | head -1 | cut -d= -f2-; }
  H=$(get ANALYTICS_DB_HOST); P=$(get ANALYTICS_DB_PORT); D=$(get ANALYTICS_DB_NAME)
  U=$(get ANALYTICS_DB_USER); PW=$(get ANALYTICS_DB_PASSWORD)
  if [ -z "$H" ] || [ -z "$D" ] || [ -z "$U" ] || [ -z "$PW" ]; then
    echo "::error::$S ($D): incomplete ANALYTICS_DB_* config -- SKIPPED, partitions NOT topped up"
    rc=1; continue
  fi

  OUT=$(PGPASSWORD="$PW" timeout 60 psql -h "$H" -p "${P:-5432}" -U "$U" -d "$D" -tAX \
        -c "SELECT internal_analytics.ensure_partitions($DAYS_AHEAD);" 2>&1)
  if [ $? -ne 0 ]; then
    # Most likely cause: ensure_partitions() does not exist in this lane yet.
    echo "::error::$D: partition top-up FAILED -- ${OUT//$'\n'/ }"
    rc=1; continue
  fi

  NEWEST=$(PGPASSWORD="$PW" timeout 60 psql -h "$H" -p "${P:-5432}" -U "$U" -d "$D" -tAX \
           -c "SELECT COALESCE(MAX(substring(c.relname from 'y[0-9]{4}m[0-9]{2}d[0-9]{2}')),'none') FROM pg_inherits i JOIN pg_class p ON p.oid=i.inhparent JOIN pg_class c ON c.oid=i.inhrelid WHERE p.relname='ai_calls';" 2>/dev/null | tr -d ' ')
  printf '%-28s created=%-4s newest ai_calls partition=%s\n' "$D" "$(echo "$OUT" | tr -d ' ')" "$NEWEST"
done

exit $rc
