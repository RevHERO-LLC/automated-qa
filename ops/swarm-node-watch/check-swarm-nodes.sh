#!/usr/bin/env bash
# check-swarm-nodes.sh — swarm NODE-DROP alert (DETECT-ONLY, task #1321 / plan P5-D4).
#
# WHY: the prod worker revhero-web (VPS3, label role=prod-integrations) has logged swarm-link failures every day since at
# least 2026-11-18 (206 to 351 lines a day); on 2026-11-24 it lost its link to the manager 30 times, about 1.2 an hour,
# around the clock. When a drop outlasts the heartbeat grace the manager replaces the tasks pinned to that node (Zot
# registry, email-ingress, sms, activity, hubspot, pipedrive) and nobody was told: it was found by chance on 11-19 and
# again on 11-25. This check tells a human, with a timeline in the journal.
#
# Runs on the swarm MANAGER (VPS2, systemd timer, every 2 min). It raises a Slack alert for:
#   * node:<host>=<Status>/<Availability>[/<Mgr>]   a node that is not Ready/Active (Down, Unknown, Disconnected,
#                                                    Drain, Pause) or a manager that is not Leader/Reachable.
#                                                    Alerts at once (a Down state is already >= 15 s old).
#   * missing:<host>       a node named in EXPECTED_NODES that `docker node ls` no longer lists (optional).
#   * flap:<host>          a WORKER with >= WAVE_THRESHOLD heartbeat-failure "waves" in the last WAVE_WINDOW_MINUTES.
#                          WHY it exists: a flap lasts seconds to a minute, so a poll every 2 min sees the node Down
#                          only part of the time. The worker's own dockerd journal ("heartbeat to manager ... failed" /
#                          "agent: session failed") records every one, so the manager reads it over SSH (read-only,
#                          bounded by --since). A wave = failing minutes <= WAVE_GAP_MINUTES apart. Hysteresis: once
#                          alerted it stays active while any wave is left in the window (WAVE_CLEAR_BELOW) and clears
#                          only after a clean window, so a node that keeps flapping pages once, not every hour.
#                          WAVE_THRESHOLD=0 switches this check (and its SSH) off.
#   * blind:nodels / blind:waves:<host>   the check could not do its job (docker node ls failed; the journal could not
#                          be read). A silent monitor manufactures confidence, so a blind spot is an alert too, after
#                          BLIND_RUNS consecutive runs (a daemon restart or one dropped SSH must not page).
#
# FAIL LOUD: no SLACK_WEBHOOK => exit 2. Slack undeliverable => exit 1 and the alert state is NOT recorded (it retries
# next run). A confirmed blind:nodels keeps the unit RED (exit 2) even after its alert was delivered. A hung run is
# capped by TimeoutStartSec in the unit. A FAILED swarm-node-watch.service in `systemctl --failed` = the watcher is broken.
#
# Dedupe (same shape as overlay-fdb-detector / analytics-alarm-deadman): the alert is keyed on the SET of problem keys.
# A new or changed set alerts at once; an unchanged set re-alerts at most every REMIND_HOURS, labelled REMINDER; once
# the set has been empty for RECOVER_RUNS consecutive runs ONE "RECOVERED" message is posted and the state resets.
# (RECOVER_RUNS=2 is the flap guard: down, up, down inside two runs is ONE alert, not three.)
#
# Reads only: `docker node ls`, `docker node inspect`, and one bounded journalctl per Ready worker over SSH. It writes
# only its own STATE_DIR on this host and never writes a file on a worker.
#
# Env: SLACK_WEBHOOK (REQUIRED), STATE_DIR (/var/lib/swarm-node-watch), LANE_LABEL (prod), REMIND_HOURS (6),
#      RECOVER_RUNS (2), BLIND_RUNS (2), WAVE_THRESHOLD (3; 0 = off), WAVE_WINDOW_MINUTES (60), WAVE_GAP_MINUTES (5),
#      WAVE_CLEAR_BELOW (1), EXPECTED_NODES (comma list, optional), REMOTE_TIMEOUT (30 s per worker), SSH_OPTS,
#      TEST_ALERT ("true" => one Slack message that validates docker + SSH + Slack, no state touched),
#      NODEWATCH_NOW_EPOCH / NODEWATCH_LIB_ONLY (tests only).
# Exit: 0 ran (ok / alert delivered / suppressed) | 1 Slack undeliverable | 2 cannot run (config) or confirmed blind:nodels.

set -uo pipefail

SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"
STATE_DIR="${STATE_DIR:-/var/lib/swarm-node-watch}"
STATE_FILE="${STATE_DIR}/state"
LABEL="${LANE_LABEL:-prod}"
TEST_ALERT="${TEST_ALERT:-false}"
EXPECTED_NODES="${EXPECTED_NODES:-}"
SSH_OPTS="${SSH_OPTS:--o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new}"
BT=$'\x60'

log() { echo "[node-watch $(date -u +%H:%M:%SZ)] $*"; }

# A bad knob must never silently disable a check: fall back to the default and say so.
int_or_default() { # name default [min]
  local v="${!1:-}" min="${3:-1}"
  if [[ "$v" =~ ^[0-9]+$ ]] && [ "$v" -ge "$min" ]; then echo "$v"; else
    [ -n "$v" ] && log "WARN: $1='$v' is not an integer >= ${min} — using default $2" >&2
    echo "$2"
  fi
}
REMIND_HOURS="$(int_or_default REMIND_HOURS 6)"
RECOVER_RUNS="$(int_or_default RECOVER_RUNS 2)"
BLIND_RUNS="$(int_or_default BLIND_RUNS 2)"
WAVE_THRESHOLD="$(int_or_default WAVE_THRESHOLD 3 0)"
WAVE_WINDOW_MINUTES="$(int_or_default WAVE_WINDOW_MINUTES 60)"
WAVE_GAP_MINUTES="$(int_or_default WAVE_GAP_MINUTES 5)"
WAVE_CLEAR_BELOW="$(int_or_default WAVE_CLEAR_BELOW 1)"
REMOTE_TIMEOUT="$(int_or_default REMOTE_TIMEOUT 30)"

now_epoch() { echo "${NODEWATCH_NOW_EPOCH:-$(date +%s)}"; }
fmt_ts() { date -u -d "@$1" '+%Y-%m-%d %H:%MZ' 2>/dev/null || echo "?"; }

# --- Slack: same idiom as overlay-fdb-detector / analytics-alarm-deadman. Returns 0 only when the post was accepted —
#     callers must NOT record alert state on failure.
slack_post() { printf '%s' "$1" | jq -Rs '{text:.}' | curl -fsS -m 15 -X POST -H 'Content-Type: application/json' -d @- "$SLACK_WEBHOOK" >/dev/null 2>&1; }

# --- pure helpers (unit-tested through NODEWATCH_LIB_ONLY=1) -----------------------------------------------------
# State keys end up in a file and in `;`/`,`-separated lists: neutralise anything outside a safe alphabet.
sanitize_key() { printf '%s' "$1" | tr -c 'A-Za-z0-9._:=/-' '_'; }

# node_problem <Status> <Availability> <ManagerStatus>: prints "Status/Availability[/Mgr]" for an unhealthy node, nothing
# (rc 0) for a healthy one. Healthy = Ready + Active, and a manager must be Leader or Reachable. A blank field is a problem.
node_problem() {
  local st="${1:-}" av="${2:-}" ms="${3:-}"
  if [ "$st" = Ready ] && [ "$av" = Active ] && { [ -z "$ms" ] || [ "$ms" = Leader ] || [ "$ms" = Reachable ]; }; then return 0; fi
  printf '%s/%s%s' "${st:-?}" "${av:-?}" "${ms:+/$ms}"
}

# count_waves <now-epoch> <window-minutes> <gap-minutes>  < UTC minute stamps (YYYY-MM-DDTHH:MM), one per line.
# Prints the number of waves: stamps inside the window, sorted, with stamps <= gap minutes apart merged into one wave.
count_waves() {
  local now="$1" win="$2" gap="$3" m e cutoff prev=0 n=0
  local -a eps=()
  cutoff=$(( now - win * 60 ))
  while IFS= read -r m; do
    [[ "$m" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$ ]] || continue
    e="$(date -u -d "${m}:00Z" +%s 2>/dev/null)" || continue
    # a stamp is a whole minute: one that started up to 59 s before the cutoff still overlaps the window
    [ "$e" -ge $(( cutoff - 59 )) ] || continue
    eps+=("$e")
  done
  if [ "${#eps[@]}" -eq 0 ]; then echo 0; return; fi
  while IFS= read -r e; do
    if [ "$prev" -eq 0 ] || [ $(( e - prev )) -gt $(( gap * 60 )) ]; then n=$(( n + 1 )); fi
    prev="$e"
  done < <(printf '%s\n' "${eps[@]}" | sort -n)
  echo "$n"
}

# decide <observed-keys-csv> <active-keys-csv> <now> <last-alert-epoch> <ok-streak>  ->  none | wait | alert | remind | recover
decide() {
  local obs="$1" act="$2" now="$3" last="${4:-0}" streak="${5:-0}"
  if [ -z "$obs" ]; then
    [ -z "$act" ] && { echo none; return; }
    if [ $(( streak + 1 )) -ge "$RECOVER_RUNS" ]; then echo recover; else echo wait; fi
    return
  fi
  if [ "$obs" != "$act" ]; then echo alert; return; fi
  if [ $(( now - last )) -ge $(( REMIND_HOURS * 3600 )) ]; then echo remind; else echo none; fi
}

# --- state: active (alerted keys, csv), since, last_alert, ok_streak (healthy runs since the last problem), pending ----
state_get() { sed -n "s/^$1=//p" "$STATE_FILE" 2>/dev/null | head -1; }
state_put() { # active since last_alert ok_streak pending
  mkdir -p "$STATE_DIR" 2>/dev/null || { log "WARN: cannot create $STATE_DIR — dedupe state NOT saved"; return 1; }
  local tmp="${STATE_FILE}.tmp.$$"
  printf 'active=%s\nsince=%s\nlast_alert=%s\nok_streak=%s\npending=%s\n' "$1" "$2" "$3" "$4" "$5" > "$tmp" && mv -f "$tmp" "$STATE_FILE"
}

# Sourced by test-node-watch.sh for the pure functions only (never set in production).
if [ "${NODEWATCH_LIB_ONLY:-}" = "1" ]; then return 0; fi

if [ -z "$SLACK_WEBHOOK" ] || [ "$SLACK_WEBHOOK" = REPLACE_ME ]; then
  log "ERROR: SLACK_WEBHOOK is not set (or still the REPLACE_ME placeholder) — this monitor cannot deliver findings (failing loudly)." >&2
  exit 2
fi

# One run at a time: a manual run must not overlap the timer's (double alert, a miscounted streak).
if command -v flock >/dev/null 2>&1; then
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  if exec 9>"${STATE_DIR}/run.lock"; then
    flock -n 9 || { log "another run holds ${STATE_DIR}/run.lock — exiting (not an error)"; exit 0; }
  fi
fi

# Run on a worker over SSH (script on stdin, nothing written there). The sentinel WAVES_OK proves journalctl itself
# succeeded, so an unreadable journal can never pass as "zero waves"; the output is one UTC minute per failing minute.
read -r -d '' WAVE_SCRIPT <<'WV' || true
win="$1"
case "$win" in ''|*[!0-9]*) echo "WAVES_ERR bad-window"; exit 0 ;; esac
command -v journalctl >/dev/null 2>&1 || { echo "WAVES_ERR no-journalctl"; exit 0; }
journalctl -u docker --since "-${win}min" --utc -o short-iso --no-pager 2>/dev/null \
  | grep -E 'heartbeat to manager .* failed|agent: session failed' | cut -c1-16 | uniq
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || { echo "WAVES_ERR journalctl-rc-${rc}"; exit 0; }
echo WAVES_OK
WV

is_addr() { [[ "${1:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; }

# --- load state first (the flap hysteresis needs to know which keys are already active) -------------------------
now="$(now_epoch)"
prev_active="$(state_get active)"; prev_since="$(state_get since)"; prev_last="$(state_get last_alert)"
prev_streak="$(state_get ok_streak)"; PENDING_OLD="$(state_get pending)"
prev_last="${prev_last:-0}"; prev_streak="${prev_streak:-0}"

declare -a P_KEYS=() P_TEXT=() NODES_SEEN=()
declare -A ADDR_CACHE=()
PENDING_NEW=""; NODES_SUMMARY=""; WAVES_SUMMARY=""; BLIND_NODELS=0

add_problem() { P_KEYS+=("$(sanitize_key "$1")"); P_TEXT+=("$2"); }
active_has() { [[ ",${prev_active}," == *",$(sanitize_key "$1"),"* ]]; }
pend_count() { # key -> count so far (consecutive runs the blind spot was seen)
  local kv; local -a ps=()
  IFS=';' read -ra ps <<<"$PENDING_OLD"
  for kv in "${ps[@]+"${ps[@]}"}"; do [ "${kv%%|*}" = "$1" ] && { echo "${kv##*|}"; return; }; done
  echo 0
}
# A blind spot only pages after BLIND_RUNS consecutive runs; until then it is a WARN in the journal.
blind_candidate() { # key text
  local key n; key="$(sanitize_key "$1")"
  n=$(( $(pend_count "$key") + 1 ))
  PENDING_NEW+="${key}|${n};"
  if [ "$n" -ge "$BLIND_RUNS" ]; then add_problem "$key" "$2"
  else log "WARN: $2 (run ${n}/${BLIND_RUNS}; not paging yet)"; fi
}
node_addr() { # host -> address (cached; empty when unknown)
  local h="$1"
  if [ -z "${ADDR_CACHE[$h]+x}" ]; then ADDR_CACHE[$h]="$(docker node inspect "$h" --format '{{.Status.Addr}}' 2>/dev/null </dev/null | head -1)"; fi
  printf '%s' "${ADDR_CACHE[$h]}"
}

wave_check() { # <worker host> — only called for a Ready/Active worker
  local host="$1" addr out rc n key why
  addr="$(node_addr "$host")"
  if ! is_addr "$addr"; then
    blind_candidate "blind:waves:${host}" "cannot read the docker journal on ${host}: 'docker node inspect' gave no usable address"; return
  fi
  out="$(printf '%s' "$WAVE_SCRIPT" | timeout "$REMOTE_TIMEOUT" ssh $SSH_OPTS "root@${addr}" bash -s -- "$WAVE_WINDOW_MINUTES" 2>/dev/null)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    blind_candidate "blind:waves:${host}" "cannot read the docker journal on ${host} (${addr}): ssh/timeout rc=${rc}"; return
  fi
  if ! grep -qx 'WAVES_OK' <<<"$out"; then
    why="$(grep -m1 '^WAVES_ERR' <<<"$out" | cut -c1-120)"
    blind_candidate "blind:waves:${host}" "cannot read the docker journal on ${host} (${addr}): ${why:-no WAVES_OK answer from the node}"; return
  fi
  n="$(grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$' <<<"$out" | count_waves "$now" "$WAVE_WINDOW_MINUTES" "$WAVE_GAP_MINUTES")"
  log "waves(${WAVE_WINDOW_MINUTES}m) ${host}=${n}"
  WAVES_SUMMARY+="${WAVES_SUMMARY:+, }${host}=${n}"
  key="flap:${host}"
  # enter at WAVE_THRESHOLD; once active, stay while any wave is left in the window (hysteresis)
  if [ "$n" -ge "$WAVE_THRESHOLD" ] || { active_has "$key" && [ "$n" -ge "$WAVE_CLEAR_BELOW" ]; }; then
    add_problem "$key" "• node *${host}* (${addr}): ${n} heartbeat-failure waves in the last ${WAVE_WINDOW_MINUTES} min (alert at ${WAVE_THRESHOLD}) — its swarm link keeps dropping even when ${BT}docker node ls${BT} looks Ready between polls; each drop that outlasts the heartbeat grace makes the manager replace every task pinned to it."
  fi
}

# --- observe -----------------------------------------------------------------------------------------------------
observe() {
  local nl_out nl_rc line host st av ms prob addr want
  local -a lines=() want_list=()
  nl_out="$(docker node ls --format '{{.Hostname}}|{{.Status}}|{{.Availability}}|{{.ManagerStatus}}' 2>&1)"; nl_rc=$?
  if [ "$nl_rc" -ne 0 ] || [ -z "$nl_out" ]; then
    BLIND_NODELS=1
    blind_candidate "blind:nodels" "cannot read the swarm node list (docker node ls rc=${nl_rc}: $(printf '%s' "$nl_out" | tr '\n' ' ' | cut -c1-160)) — this check is blind; is this host the swarm manager and is dockerd up?"
    return
  fi
  mapfile -t lines <<<"$nl_out"
  for line in "${lines[@]}"; do
    IFS='|' read -r host st av ms <<<"$line"
    [ -z "$host" ] && continue
    NODES_SEEN+=("$host")
    NODES_SUMMARY+="${NODES_SUMMARY:+, }${host} ${st:-?}/${av:-?}${ms:+/$ms}"
    prob="$(node_problem "$st" "$av" "$ms")"
    if [ -n "$prob" ]; then
      addr="$(node_addr "$host")"
      add_problem "node:${host}=${prob}" "• node *${host}*${addr:+ (${addr})}: Status=${st:-?}, Availability=${av:-?}${ms:+, Manager=${ms}} — not Ready/Active: the manager treats its tasks as lost and reschedules them, and anything pinned to this node by a placement label waits until it is Ready again."
      continue
    fi
    # a healthy WORKER (no manager status): read its own heartbeat-failure record, unless the wave check is off
    if [ -z "$ms" ] && [ "$WAVE_THRESHOLD" -ge 1 ]; then wave_check "$host"; fi
  done
  if [ -n "$EXPECTED_NODES" ]; then
    IFS=',' read -ra want_list <<<"$EXPECTED_NODES"
    for want in "${want_list[@]+"${want_list[@]}"}"; do
      want="${want//[[:space:]]/}"; [ -z "$want" ] && continue
      printf '%s\n' "${NODES_SEEN[@]}" | grep -qxF "$want" \
        || add_problem "missing:${want}" "• node *${want}* is missing from ${BT}docker node ls${BT} although it is in EXPECTED_NODES — removed from the swarm, or never joined."
    done
  fi
}

TRIAGE="Triage: ${BT}docker node ps <node> --no-trunc | head${BT} on the manager; on the node: ${BT}journalctl -u docker --since -30min --no-pager | grep -E 'heartbeat to manager|session failed'${BT}. Runbook: automated-qa/ops/swarm-node-watch/README.md."
compose() { # headline -> full Slack text (headline + one bullet per problem + triage)
  local nl=$'\n' body="" i
  for i in "${!P_TEXT[@]}"; do body+="${P_TEXT[$i]}${nl}"; done
  printf '%s%s%s%s' "$1" "$nl" "$body" "$TRIAGE"
}

observe

obs_csv=""
if [ "${#P_KEYS[@]}" -gt 0 ]; then obs_csv="$(printf '%s\n' "${P_KEYS[@]}" | sed '/^$/d' | sort -u | paste -sd, -)"; fi
log "nodes: ${NODES_SUMMARY:-none read} | problems='${obs_csv}' active='${prev_active}'"

if [ "$TEST_ALERT" = "true" ]; then
  if [ -n "$obs_csv" ]; then cur="Current problems: ${obs_csv}."$'\n'"$(compose '')"; else cur="No current problems."; fi
  if slack_post ":white_check_mark: *Swarm node watch* test run (${LABEL}) — Slack path OK. Nodes: ${NODES_SUMMARY:-none read}. Wave check: ${WAVES_SUMMARY:-off or none} (alert at ${WAVE_THRESHOLD} per ${WAVE_WINDOW_MINUTES} min). ${cur} (TEST_ALERT=true)"; then
    log "Slack test alert sent."; exit 0
  fi
  log "ERROR: Slack POST failed (test alert)." >&2; exit 1
fi

decision="$(decide "$obs_csv" "$prev_active" "$now" "$prev_last" "$prev_streak")"
log "decision=${decision} (ok_streak=${prev_streak}/${RECOVER_RUNS}, last alert $( [ "$prev_last" -gt 0 ] && fmt_ts "$prev_last" || echo never ))"

rc_final=0
case "$decision" in
  none)
    if [ -z "$obs_csv" ]; then state_put "" "" 0 0 "$PENDING_NEW" >/dev/null 2>&1
    else state_put "$prev_active" "$prev_since" "$prev_last" 0 "$PENDING_NEW" >/dev/null 2>&1; fi
    ;;
  wait)
    state_put "$prev_active" "$prev_since" "$prev_last" $(( prev_streak + 1 )) "$PENDING_NEW" >/dev/null 2>&1
    ;;
  alert|remind)
    n_probs="${#P_KEYS[@]}"
    if [ "$decision" = remind ]; then head=":rotating_light: *Swarm node watch* (${LABEL}) — REMINDER (still alerting since $(fmt_ts "${prev_since:-$now}")), ${n_probs} problem(s):"
    else head=":rotating_light: *Swarm node watch* (${LABEL}) — ${n_probs} problem(s):"; fi
    if slack_post "$(compose "$head")"; then
      log "Slack ${decision} sent (${obs_csv})."
      if [ "$decision" = alert ] && [ -z "$prev_active" ]; then since="$now"; else since="${prev_since:-$now}"; fi
      state_put "$obs_csv" "$since" "$now" 0 "$PENDING_NEW"
    else
      log "ERROR: Slack POST failed — alert NOT recorded, will retry next run." >&2; rc_final=1
    fi
    ;;
  recover)
    if slack_post ":white_check_mark: *Swarm node watch* — RECOVERED (${LABEL}): every node is Ready/Active and no wave alarm is active. It had been alerting since $(fmt_ts "${prev_since:-$now}") (${prev_active})."; then
      log "Slack recovery sent."; state_put "" "" 0 0 "$PENDING_NEW"
    else
      log "ERROR: Slack POST failed (recovery notice) — will retry next run." >&2; rc_final=1
    fi
    ;;
esac

# A watcher that cannot read the node list stays RED in systemd even after its alert was delivered.
if [ "$BLIND_NODELS" = 1 ] && [[ ",${obs_csv}," == *",blind:nodels,"* ]] && [ "$rc_final" -eq 0 ]; then rc_final=2; fi
exit "$rc_final"
