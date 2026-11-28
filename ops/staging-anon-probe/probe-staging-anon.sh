#!/usr/bin/env bash
# probe-staging-anon.sh — daily anonymous-request probe of the STAGING public API hosts (plan P5-D6).
#
# WHY: the staging public hosts were never edge-locked (the U18 Traefik default-deny covers prod hosts only), and
# users-service routes answered anonymous callers on staging until code gates were added. A gate that is added once
# can silently go missing again (a refactor, a new route, INTERNAL_AUTH_ENFORCE left log-only). THIS check sends plain
# unauthenticated GETs to representative /v1 routes (users, campaigns, deals, inbox, admin) on every staging host and
# Slacks when one of them answers 2xx.
#
# WHAT IT DOES (and never does):
#   * GET only. No credentials, no cookies, no ~/.curlrc (curl -q). Never follows redirects.
#   * STAGING ONLY, enforced in code: a target whose host is not a staging domain is a "config" error and is never
#     requested (see is_staging_host). It cannot be pointed at prod by editing the targets file.
#   * Never reads a body into the report, the log, Slack or the state file. A body is written to one temp file only to
#     classify it ("records present?") and is truncated straight away. Only host, path, status, size and a verdict are
#     ever printed.
#   * Asks for a NONEXISTENT tenant (id 999999999) wherever a route takes one, so even an open route has nothing to
#     return. Targets are read-only list routes only: never a GET that triggers work (sweeps, enrich, fire-on-resolve).
#
# VERDICT PER ROUTE:   refused (401/403) | absent (404/405/410: route or id unknown, NOT proof of auth)
#                      | invalid (400/422: rejected as malformed; with a well-formed URL the handler ran with no auth in front)
#                      | redirect (3xx) | error (000/429/5xx after retries) | open (2xx, no records) | leak (2xx WITH records)
# ALERT KINDS (same fail-loud / dedupe / RECOVERED contract as ops/offsite-backup-deadman):
#   leak    >=1 route answered 2xx with records             -> alerts at once
#   open    >=1 route answered 2xx, no records              -> alerts at once. Because the probe asks for a nonexistent
#                                                              tenant, "no records" says nothing about auth: any 2xx on a
#                                                              route that should be protected is the finding.
#   failed  the probe could not evaluate enough (errors, a host with no evaluable route, < MIN_EVALUATED_PCT evaluated)
#                                                           -> needs CONFIRM_RUNS consecutive runs (a blip must not page)
#   config  the check cannot run (no curl/jq, bad or non-staging target) -> alerts at once, exit 2
# A NEW or CHANGED set of leak/open routes alerts immediately (unlike the dead-man, the signature of the set is part of
# the state, so a second route starting to leak is not hidden behind the first alert); the same set re-alerts at most
# every REMIND_HOURS. When the probe is clean again, one "RECOVERED" message is posted and the state resets.
# FAIL LOUD: no SLACK_WEBHOOK => exit 2; Slack undeliverable => exit 1 and the alert is NOT recorded (retried next run).
#
# VANTAGE POINT: the result is only as good as where it runs. From inside the fleet (VPS2 is on the edge allowlist once a
# staging default-deny exists) it describes the application layer, not the edge. See README.md.
#
# Env: SLACK_WEBHOOK (REQUIRED, except in report mode), TARGETS_FILE (default /etc/revhero/staging-anon-probe.targets,
#      else the file next to this script), STATE_DIR (/var/lib/staging-anon-probe), LANE_LABEL (staging),
#      MAX_TIME (20 s per request), RETRIES (1 extra try on error/5xx), RETRY_SLEEP (3), BUDGET_SECS (420 total),
#      MIN_EVALUATED_PCT (50), CONFIRM_RUNS (2), REMIND_HOURS (46), PROBE_VANTAGE (hostname),
#      PROBE_NO_SLACK ("1" => REPORT MODE: print the table, never post, never write state; exit 0 clean | 3 leak/open |
#      4 could not evaluate | 2 config), TEST_ALERT ("true" => post one Slack message to validate the path),
#      PROBE_NOW_EPOCH (tests only), PROBE_LIB_ONLY ("1" => define functions only, for test-probe.sh).
# Exit (scheduled mode): 0 ran (ok / alert delivered / suppressed) | 1 Slack undeliverable | 2 cannot run (config).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"
STATE_DIR="${STATE_DIR:-/var/lib/staging-anon-probe}"
STATE_FILE="${STATE_DIR}/state"
LABEL="${LANE_LABEL:-staging}"
TEST_ALERT="${TEST_ALERT:-false}"
REPORT_ONLY="${PROBE_NO_SLACK:-}"
VANTAGE="${PROBE_VANTAGE:-$(hostname 2>/dev/null || echo unknown-host)}"
UA='revhero-staging-anon-probe/1 (automated-qa ops; read-only GET)'

log() { echo "[anon-probe $(date -u +%H:%M:%SZ)] $*"; }

# A bad knob must never silently disable the check: fall back to the default and say so.
int_or_default() { # name default
  local v="${!1:-}"
  if [[ "$v" =~ ^[0-9]+$ ]] && [ "$v" -ge 1 ]; then echo "$v"; else
    [ -n "$v" ] && log "WARN: $1='$v' is not a positive integer — using default $2" >&2
    echo "$2"
  fi
}
MAX_TIME="$(int_or_default MAX_TIME 20)"
RETRIES="${RETRIES:-1}"; [[ "$RETRIES" =~ ^[0-9]+$ ]] || RETRIES=1
RETRY_SLEEP="${RETRY_SLEEP:-3}"; [[ "$RETRY_SLEEP" =~ ^[0-9]+$ ]] || RETRY_SLEEP=3
BUDGET_SECS="$(int_or_default BUDGET_SECS 420)"
MIN_EVALUATED_PCT="$(int_or_default MIN_EVALUATED_PCT 50)"
CONFIRM_RUNS="$(int_or_default CONFIRM_RUNS 2)"
REMIND_HOURS="$(int_or_default REMIND_HOURS 46)"

now_epoch() { echo "${PROBE_NOW_EPOCH:-$(date +%s)}"; }
fmt_ts() { date -u -d "@$1" '+%Y-%m-%d %H:%MZ' 2>/dev/null || echo "?"; }

# --- Slack (same idiom as the other dead-mans). Returns 0 only when the post was accepted.
slack_post() {
  printf '%s' "$1" | jq -Rs '{text:.}' | curl -q -fsS -m 15 -X POST -H 'Content-Type: application/json' -d @- "$SLACK_WEBHOOK" >/dev/null 2>&1
}

# --- state: kind (empty = clean), consecutive failure count, since, last alert time, signature of the finding set.
state_get() { sed -n "s/^$1=//p" "$STATE_FILE" 2>/dev/null | head -1; }
state_put() { # kind fail_count since last_alert sig
  mkdir -p "$STATE_DIR" 2>/dev/null || { log "WARN: cannot create $STATE_DIR — dedupe state NOT saved"; return 1; }
  local tmp="${STATE_FILE}.tmp.$$"
  printf 'kind=%s\nfail_count=%s\nsince=%s\nlast_alert=%s\nsig=%s\n' "$1" "$2" "$3" "$4" "${5:-}" > "$tmp" && mv -f "$tmp" "$STATE_FILE"
}

# Pure decision: observed kind, signature of the finding set, fail_count BEFORE this run, now.
# Prints: none | wait | alert | remind | recover
decide() {
  local obs="$1" sig="$2" fc="$3" now="$4" st_kind st_last
  st_kind="$(state_get kind)"; st_last="$(state_get last_alert)"; st_last="${st_last:-0}"
  if [ "$obs" = ok ]; then
    [ -n "$st_kind" ] && echo recover || echo none
    return
  fi
  if [ "$obs" = failed ] && [ "$st_kind" != failed ] && [ $((fc + 1)) -lt "$CONFIRM_RUNS" ]; then
    echo wait; return
  fi
  if [ "$st_kind" != "$obs" ]; then echo alert; return; fi
  # A changed set of leaking/open routes is news even though the kind is the same.
  if { [ "$obs" = leak ] || [ "$obs" = open ]; } && [ "$(state_get sig)" != "$sig" ]; then echo alert; return; fi
  if [ $(( now - st_last )) -ge $(( REMIND_HOURS * 3600 )) ]; then echo remind; return; fi
  echo none
}

# --- STAGING ONLY. https, no userinfo/port/path, lowercase, and the host must end in a staging domain with at least one
# label in front (so the FE host staging.revhero.ai and every prod host are refused).
STAGING_HOST_RE='^https://([a-z0-9-]+\.)+(test\.revhero\.io|staging2\.revhero\.io|staging\.revhero\.ai|test\.revhero\.ai)$'
is_staging_host() { [[ "$1" =~ $STAGING_HOST_RE ]]; }

# --- targets: "<base-url> <path> <family>" per line; '#' comments and blank lines are skipped.
declare -a TG_BASE=() TG_PATH=() TG_FAM=()
CONFIG_ERR=""
resolve_targets_file() {
  if [ -n "${TARGETS_FILE:-}" ]; then echo "$TARGETS_FILE"
  elif [ -f /etc/revhero/staging-anon-probe.targets ]; then echo /etc/revhero/staging-anon-probe.targets
  else echo "${HERE}/staging-anon-probe.targets"; fi
}
load_targets() {
  local f line base path fam extra ln=0
  f="$(resolve_targets_file)"
  TG_BASE=(); TG_PATH=(); TG_FAM=(); CONFIG_ERR=""
  [ -r "$f" ] || { CONFIG_ERR="targets file $f is not readable"; return 1; }
  while IFS= read -r line || [ -n "$line" ]; do
    ln=$((ln + 1)); line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    read -r base path fam extra <<<"$line"
    base="${base%/}"
    if [ -z "$base" ] || [ -z "$path" ]; then CONFIG_ERR="$f line $ln: need '<base-url> <path> [family]'"; return 1; fi
    if ! is_staging_host "$base"; then CONFIG_ERR="$f line $ln: REFUSING to probe '${base}': not a staging host (this probe is staging-only by design)"; return 1; fi
    if ! [[ "$path" =~ ^/[^[:space:]#]*$ ]]; then CONFIG_ERR="$f line $ln: bad path '${path}' (must start with / and hold no spaces or #)"; return 1; fi
    TG_BASE+=("$base"); TG_PATH+=("$path"); TG_FAM+=("${fam:-other}")
  done < "$f"
  [ "${#TG_BASE[@]}" -gt 0 ] || { CONFIG_ERR="targets file $f has no targets"; return 1; }
  return 0
}

# --- one GET. Sets F_CODE F_BYTES F_CTYPE F_RC F_ERR. The body goes to $BODY (truncated by the caller right after use).
BODY=""
F_CODE=000 F_BYTES=0 F_CTYPE="" F_RC=0 F_ERR=""
fetch() { # url
  local out errf
  errf="$(mktemp)"
  out="$(curl -q -sS -o "$BODY" -w '%{http_code}\t%{size_download}\t%{content_type}' \
        --connect-timeout 10 --max-time "$MAX_TIME" --max-filesize 2000000 \
        -A "$UA" -H 'Accept: application/json' "$1" 2>"$errf")"
  F_RC=$?
  F_ERR="$(head -c 160 "$errf" | tr -d '\r\n')"
  rm -f "$errf"
  IFS=$'\t' read -r F_CODE F_BYTES F_CTYPE <<<"$out"
  F_CODE="${F_CODE:-000}"; F_BYTES="${F_BYTES:-0}"; F_CTYPE="${F_CTYPE:-}"
  [[ "$F_BYTES" =~ ^[0-9]+$ ]] || F_BYTES=0
}

# status -> refused | invalid | absent | redirect | error | 2xx (the caller decides open vs leak from the body)
#   invalid = 400/422: the request was rejected as malformed. With a well-formed probe URL that means the handler's own
#             validation ran with no auth in front of it (found 2026-11-22 on email-ingress, hubspot, pipedrive), or the
#             probe's parameters went stale. Either way it is NOT proof of auth, so it is never counted as a pass.
classify() {
  case "$1" in
    401|403) echo refused ;;
    2??) echo 2xx ;;
    3??) echo redirect ;;
    400|422) echo invalid ;;
    429|5??|000) echo error ;;
    *) echo absent ;;
  esac
}

# Does a 2xx JSON body hold records? Prints data | nodata | nonjson. Two things never count:
#   * response plumbing: a scalar under an envelope key (success, message, error, total, page, current_page...) or anywhere
#     inside a pagination / meta / links container;
#   * DEFAULTS: the probe asks for a tenant that does not exist, so a zero, false, "" or null can only be a default, never
#     tenant data. Only a non-empty array, or a non-default scalar (a non-zero number, a non-empty string, true), is "data".
# So {"error":"missing token"}, {"data":[],"total":0}, {"message":"ok","pagination":{"current_page":1,"total_count":0}} and a
# zero-filled summary ({"data":{"summary":{"campaigns":[],"totals":{"messages_sent":0}}}}) are all "nodata". Both the
# pagination case (sms-service) and the zero-filled summary (analytics) were real false LEAKs found by the first live runs.
# Limit: a non-empty DEFAULT string (a currency code, a timezone) still reads as data; the label only sets severity.
JQ_HAS_DATA='
  def envelope_keys: ["success","status","message","error","errors","code","count","total","total_count","total_pages","page","pages","limit","offset","per_page","page_size","page_number","current_page","last_page","next_page","prev_page","has_more","has_next","has_prev","ok","detail","title","statusCode","status_code","timestamp","path","request_id"];
  def envelope_containers: ["pagination","paging","meta","links","page_info","pageInfo"];
  def arr_data: [.. | arrays | select(length > 0)] | length > 0;
  def scalar_data: [paths as $p
      | select((getpath($p) | type) | . != "array" and . != "object")
      | select(([$p[] | tostring | select(IN(envelope_containers[]))] | length) == 0)
      | select((($p | last) | tostring | IN(envelope_keys[])) | not)
      | getpath($p) | select(. != "" and . != null and . != 0 and . != false)] | length > 0;
  if (arr_data or scalar_data) then "data" else "nodata" end'
has_data() { # file
  local v
  v="$(jq -r "$JQ_HAS_DATA" "$1" 2>/dev/null)" || { echo nonjson; return; }
  [ "$v" = data ] && echo data || echo nodata
}

# --- observe. Sets OBS (ok|leak|open|failed|config), REASON, FIND (alert lines), SIG, plus the R_* rows for the report.
OBS="" REASON="" FIND="" SIG="" ERRNOTE=""
declare -a R_CLASS=() R_CODE=() R_BYTES=() R_FAM=() R_HOST=() R_PATH=() R_NOTE=()
declare -A HOST_TOTAL=() HOST_EVAL=()
CNT_REFUSED=0 CNT_ABSENT=0 CNT_INVALID=0 CNT_REDIRECT=0 CNT_ERROR=0 CNT_OPEN=0 CNT_LEAK=0 N_EVAL=0 N_ALL=0
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-16; else cksum | cut -d' ' -f1; fi; }

observe() {
  local i n cls note host url attempt start line pct h
  OBS=ok; REASON=""; FIND=""; SIG=""; ERRNOTE=""
  R_CLASS=(); R_CODE=(); R_BYTES=(); R_FAM=(); R_HOST=(); R_PATH=(); R_NOTE=(); HOST_TOTAL=(); HOST_EVAL=()
  CNT_REFUSED=0; CNT_ABSENT=0; CNT_INVALID=0; CNT_REDIRECT=0; CNT_ERROR=0; CNT_OPEN=0; CNT_LEAK=0
  command -v curl >/dev/null 2>&1 || { OBS=config; REASON="curl is not installed on this host"; return; }
  command -v jq   >/dev/null 2>&1 || { OBS=config; REASON="jq is not installed on this host"; return; }
  load_targets || { OBS=config; REASON="$CONFIG_ERR"; return; }
  n=${#TG_BASE[@]}; N_ALL=$n; start=$SECONDS
  for ((i = 0; i < n; i++)); do
    host="${TG_BASE[i]#https://}"; url="${TG_BASE[i]}${TG_PATH[i]}"; note=""; attempt=0
    if [ $((SECONDS - start)) -ge "$BUDGET_SECS" ]; then
      cls=error; F_CODE=000; F_BYTES=0; F_CTYPE=""; note="skipped: the ${BUDGET_SECS}s time budget was used up"
    else
      while :; do
        fetch "$url"
        cls="$(classify "$F_CODE")"
        if [ "$cls" = error ] && [ "$attempt" -lt "$RETRIES" ]; then attempt=$((attempt + 1)); sleep "$RETRY_SLEEP"; continue; fi
        break
      done
      if [ "$cls" = error ]; then note="${F_ERR:-HTTP ${F_CODE}} (after $((attempt + 1)) tries)"; fi
      if [ "$cls" = 2xx ]; then
        if [ "$F_RC" -eq 63 ]; then cls=leak; note="2xx, body over 2 MB (not parsed)"
        elif [ "$F_RC" -ne 0 ]; then cls=error; note="transfer ended early (curl rc=${F_RC})"
        elif [ "$F_BYTES" -eq 0 ]; then cls=open; note="2xx, empty body"
        else
          case "$(has_data "$BODY")" in
            data)   cls=leak; note="2xx with records" ;;
            nodata) cls=open; note="2xx, no records (empty list or an error body)" ;;
            *)      cls=open; note="2xx, body is not JSON (${F_CTYPE%%;*})" ;;
          esac
        fi
      fi
      : > "$BODY"   # never leave a body behind
    fi
    R_CLASS+=("$cls"); R_CODE+=("$F_CODE"); R_BYTES+=("$F_BYTES"); R_FAM+=("${TG_FAM[i]}"); R_HOST+=("$host"); R_PATH+=("${TG_PATH[i]}"); R_NOTE+=("$note")
    HOST_TOTAL["$host"]=$(( ${HOST_TOTAL["$host"]:-0} + 1 ))
    case "$cls" in
      refused)  CNT_REFUSED=$((CNT_REFUSED + 1)); HOST_EVAL["$host"]=$(( ${HOST_EVAL["$host"]:-0} + 1 )) ;;
      open)     CNT_OPEN=$((CNT_OPEN + 1));       HOST_EVAL["$host"]=$(( ${HOST_EVAL["$host"]:-0} + 1 )) ;;
      leak)     CNT_LEAK=$((CNT_LEAK + 1));       HOST_EVAL["$host"]=$(( ${HOST_EVAL["$host"]:-0} + 1 )) ;;
      absent)   CNT_ABSENT=$((CNT_ABSENT + 1)) ;;
      invalid)  CNT_INVALID=$((CNT_INVALID + 1)) ;;
      redirect) CNT_REDIRECT=$((CNT_REDIRECT + 1)) ;;
      error)    CNT_ERROR=$((CNT_ERROR + 1)) ;;
    esac
  done
  N_EVAL=$((CNT_REFUSED + CNT_OPEN + CNT_LEAK))
  pct=$(( N_EVAL * 100 / n ))

  # The finding lines (leak first, then open), and the signature of that set.
  local -a leak_l=() open_l=() sig_l=() unassessed=() err_l=()
  for ((i = 0; i < n; i++)); do
    line="${R_HOST[i]} GET ${R_PATH[i]} -> ${R_CODE[i]}, ${R_BYTES[i]} B"
    case "${R_CLASS[i]}" in
      leak) leak_l+=("• ${line} (${R_NOTE[i]})"); sig_l+=("leak|${R_HOST[i]}|${R_PATH[i]}") ;;
      open) open_l+=("• ${line} (${R_NOTE[i]})"); sig_l+=("open|${R_HOST[i]}|${R_PATH[i]}") ;;
      error) err_l+=("${R_HOST[i]} GET ${R_PATH[i]}: ${R_NOTE[i]}") ;;
    esac
  done
  for h in "${!HOST_TOTAL[@]}"; do [ "${HOST_EVAL[$h]:-0}" -eq 0 ] && unassessed+=("$h"); done
  local -a un_sorted=(); [ "${#unassessed[@]}" -gt 0 ] && mapfile -t un_sorted < <(printf '%s\n' "${unassessed[@]}" | sort)

  local all_lines="" cap=15 shown=0 total_lines extra
  if [ $((CNT_LEAK + CNT_OPEN)) -gt 0 ]; then
    for line in "${leak_l[@]+"${leak_l[@]}"}" "${open_l[@]+"${open_l[@]}"}"; do
      [ "$shown" -lt "$cap" ] && all_lines+="${line}"$'\n'
      shown=$((shown + 1))
    done
    total_lines=$((CNT_LEAK + CNT_OPEN))
    if [ "$total_lines" -gt "$cap" ]; then extra=$((total_lines - cap)); all_lines+="• ... and ${extra} more (run it by hand, or see: journalctl -u staging-anon-probe.service)"$'\n'; fi
    FIND="${all_lines%$'\n'}"
    SIG="$(printf '%s\n' "${sig_l[@]}" | sort | sha)"
    if [ "$CNT_LEAK" -gt 0 ]; then OBS=leak; REASON="${CNT_LEAK} route(s) answered 2xx WITH records and ${CNT_OPEN} more answered 2xx without, to a request that carried no credentials"
    else OBS=open; REASON="${CNT_OPEN} route(s) answered 2xx to a request that carried no credentials (no records seen: the probe asks for a nonexistent tenant, so this is an auth gap, not proof of harm)"; fi
    [ "${#err_l[@]}" -gt 0 ] && ERRNOTE="${#err_l[@]} other probe(s) could not be evaluated."
    return
  fi
  if [ "${#err_l[@]}" -gt 0 ] || [ "${#un_sorted[@]}" -gt 0 ] || [ "$pct" -lt "$MIN_EVALUATED_PCT" ]; then
    OBS=failed
    REASON="only ${N_EVAL} of ${n} probes could be evaluated (${pct}%; threshold ${MIN_EVALUATED_PCT}%): ${CNT_ERROR} error(s), ${CNT_ABSENT} absent, ${CNT_INVALID} invalid (400/422), ${CNT_REDIRECT} redirect(s)"
    [ "${#un_sorted[@]}" -gt 0 ] && REASON+="; NO evaluable route on: $(IFS=,; echo "${un_sorted[*]}")"
    FIND="$(printf '%s\n' "${err_l[@]+"${err_l[@]}"}" | head -"$cap")"
    SIG="$(printf '%s\n' "${un_sorted[@]+"${un_sorted[@]}"}" "${err_l[@]+"${err_l[@]}"}" | sort | sha)"
    return
  fi
  OBS=ok
  REASON="no route answered 2xx to an anonymous request: ${CNT_REFUSED} refused (401/403), ${CNT_ABSENT} absent, ${CNT_INVALID} invalid (400/422), ${CNT_REDIRECT} redirect; ${N_EVAL} of ${n} probes evaluated across ${#HOST_TOTAL[@]} host(s)"
}

compose() { # kind header
  local kind="$1" head="$2"
  case "$kind" in
    leak|open)
      printf '%s\n%s\n%s\n%s' \
        "${head} ${REASON} (${LABEL})." \
        "${FIND}" \
        "Each of these should have answered 401 or 403. ${ERRNOTE:+${ERRNOTE} }Anonymous staging access is exactly what plan P5-D6 closes: add the missing gate (InternalServicesAuth / JWT), or the Traefik default-deny, and re-run." \
        "Probe: automated-qa/ops/staging-anon-probe, run from ${VANTAGE}. A route open ON PURPOSE must be removed from the targets file, not tolerated."
      ;;
    failed)
      printf '%s\n%s\n%s' \
        "${head} the staging anonymous-access probe could not evaluate enough (${LABEL}): ${REASON}. A missing answer is treated as an ALERT, not as health." \
        "${FIND}" \
        "Probe: automated-qa/ops/staging-anon-probe, run from ${VANTAGE}."
      ;;
    config)
      printf '%s' "${head} the staging anonymous-access probe cannot RUN (${LABEL}): ${REASON}. Anonymous access to staging is currently UNWATCHED. Fix the host / the targets file under /etc/revhero/."
      ;;
  esac
}

print_report() {
  local i
  echo "probe: ${N_ALL} target(s), vantage=${VANTAGE}, label=${LABEL}"
  printf '%-9s %-4s %8s  %-10s %-44s %s\n' CLASS CODE BYTES FAMILY HOST PATH
  for ((i = 0; i < ${#R_CLASS[@]}; i++)); do
    printf '%-9s %-4s %8s  %-10s %-44s %s%s\n' "${R_CLASS[i]}" "${R_CODE[i]}" "${R_BYTES[i]}" "${R_FAM[i]}" "${R_HOST[i]}" "${R_PATH[i]}" "${R_NOTE[i]:+   # ${R_NOTE[i]}}"
  done
  echo "summary: refused=${CNT_REFUSED} absent=${CNT_ABSENT} invalid=${CNT_INVALID} redirect=${CNT_REDIRECT} error=${CNT_ERROR} open=${CNT_OPEN} leak=${CNT_LEAK}; evaluated ${N_EVAL} of ${N_ALL}"
}

# Sourced by test-probe.sh for the pure functions only (never set in production).
if [ "${PROBE_LIB_ONLY:-}" = "1" ]; then return 0; fi

BODY="$(mktemp)"; trap 'rm -f "$BODY"' EXIT

if [ -z "$REPORT_ONLY" ] && [ -z "$SLACK_WEBHOOK" ]; then
  log "ERROR: SLACK_WEBHOOK is not set — this monitor cannot deliver findings (failing loudly)." >&2
  exit 2
fi

observe
now="$(now_epoch)"
log "observed=${OBS} :: ${REASON}"
[ "$OBS" != config ] && print_report

if [ -n "$REPORT_ONLY" ]; then
  [ -n "$FIND" ] && printf '%s\n' "$FIND"
  case "$OBS" in
    ok) exit 0 ;;
    leak|open) exit 3 ;;
    failed) exit 4 ;;
    *) exit 2 ;;
  esac
fi

if [ "$TEST_ALERT" = "true" ]; then
  if slack_post ":white_check_mark: *Staging anonymous-access probe* test run (${LABEL}) — Slack path OK. Current observation: ${OBS} — ${REASON} (TEST_ALERT=true)"; then log "Slack test alert sent."; exit 0; fi
  log "ERROR: Slack POST failed (test alert)." >&2; exit 1
fi

prev_fc="$(state_get fail_count)"; prev_fc="${prev_fc:-0}"
prev_since="$(state_get since)"; prev_since="${prev_since:-$now}"
prev_last="$(state_get last_alert)"; prev_last="${prev_last:-0}"
prev_kind="$(state_get kind)"
decision="$(decide "$OBS" "$SIG" "$prev_fc" "$now")"
log "decision=${decision} (state kind='${prev_kind}', consecutive_failures=${prev_fc})"

rc_final=0
case "$decision" in
  none)
    [ "$OBS" = ok ] && state_put "" 0 "" 0 "" >/dev/null 2>&1
    ;;
  wait)
    state_put "$prev_kind" $((prev_fc + 1)) "$prev_since" "$prev_last" "$(state_get sig)" ;;
  alert|remind)
    if [ "$decision" = remind ]; then head=":rotating_light: *Staging anonymous-access probe* — REMINDER (still failing since $(fmt_ts "$prev_since")):"
    else head=":rotating_light: *Staging anonymous-access probe* —"; fi
    if slack_post "$(compose "$OBS" "$head")"; then
      log "Slack ${decision} sent (kind=${OBS})."
      [ "$decision" = alert ] && since="$now" || since="$prev_since"
      [ "$OBS" = failed ] && new_fc=$((prev_fc + 1)) || new_fc=0
      state_put "$OBS" "$new_fc" "$since" "$now" "$SIG"
    else
      log "ERROR: Slack POST failed — alert NOT recorded, will retry next run." >&2; rc_final=1
    fi
    ;;
  recover)
    if slack_post ":white_check_mark: *Staging anonymous-access probe* — RECOVERED (${LABEL}): ${REASON}. It had been alerting (${prev_kind}) since $(fmt_ts "$prev_since")."; then
      log "Slack recovery sent."; state_put "" 0 "" 0 ""
    else
      log "ERROR: Slack POST failed (recovery notice) — will retry next run." >&2; rc_final=1
    fi
    ;;
esac

[ "$OBS" = config ] && [ "$rc_final" -eq 0 ] && rc_final=2
exit "$rc_final"
