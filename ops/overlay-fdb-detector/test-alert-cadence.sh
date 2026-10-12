#!/usr/bin/env bash
# Hermetic test of check-overlay-fdb.sh's alert cadence (no docker, no SSH, no Slack).
# Sources the detector in lib-only mode (FDB_LIB_ONLY=1) to get gap_fingerprint / alert_decision /
# record_alert / clear_alert_state, against a throwaway STATE_DIR.
#   bash ops/overlay-fdb-detector/test-alert-cadence.sh   -> exit 0 = all PASS
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$(mktemp -d)"; export STATE_DIR
export REMIND_HOURS=24
FDB_LIB_ONLY=1 . "$here/check-overlay-fdb.sh"

fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1: expected '$3', got '$2'"; fail=1; fi; }

A="node=revhero-web host=212.56.33.193 MISSING_VTEP ns=1-n5tbze8b2q mac=02:42:0a:00:01:4f ip=10.0.1.79"
B="node=vmi3162825 host=62.146.226.197 MISSING_VTEP ns=1-n5tbze8b2q mac=02:42:0a:00:01:15 ip=10.0.1.21"
t0=1760000000

fpA="$(gap_fingerprint "$A")"
check "fingerprint is order-independent" "$(gap_fingerprint "$A"$'\n'"$B")" "$(gap_fingerprint "$B"$'\n'"$A")"
check "different sets fingerprint differently" "$([ "$fpA" != "$(gap_fingerprint "$A"$'\n'"$B")" ] && echo yes)" yes

check "first sighting alerts" "$(alert_decision "$fpA" "$t0")" new
record_alert "$fpA" "$t0" new
check "unchanged set 2h later is suppressed (old logic re-paged here)" "$(alert_decision "$fpA" $((t0 + 7200)))" suppress
check "unchanged set 23h59m later is suppressed" "$(alert_decision "$fpA" $((t0 + 86399)))" suppress
check "unchanged set 24h later reminds" "$(alert_decision "$fpA" $((t0 + 86400)))" remind
check "first-seen survives a reminder" "$(record_alert "$fpA" $((t0 + 86400)) remind; cat "$FIRST_FILE")" "$t0"
check "a changed set alerts immediately" "$(alert_decision "$(gap_fingerprint "$A"$'\n'"$B")" $((t0 + 86460)))" new
clear_alert_state
check "after the set clears, the same gap alerts as new" "$(alert_decision "$fpA" $((t0 + 90000)))" new

rm -rf "$STATE_DIR"
[ "$fail" -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$fail"
