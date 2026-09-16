#!/usr/bin/env python3
"""
Collector for the weekly-analytics client-health digest.

READ-ONLY. Reads three Postgres DBs and emits the render schema.json shape as JSON:
  USERS_DB_DSN     -> revhero_prod_users     : enumerate active client tenants
  ANALYTICS_DB_DSN -> revhero_prod_analytics : SUM public.daily_analytics_snapshots
  CAMPAIGN_DB_DSN  -> revhero_prod_campaign  : campaign names + is_active (per-campaign + dormant)

Per client it computes: this-week metric totals (tenant-wide, all seats), the prior
N-week trailing baseline, red flags for off-trend metrics, the booking funnel, the
derived KPIs (Actions Performed, Hours Saved), an 8-week trend series (for sparklines),
a per-campaign breakdown, and a dormant/active-sender classification.

Authoritative schema facts (verified against prod + analytics-service source 2026-09-15):
  - table is public.daily_analytics_snapshots (NOT internal_analytics.*)
  - grain = (date, parent_user_id, owner_account_id, campaign_id, stage_id, variant_id);
    unique on that sextuple, so summing all rows per parent = tenant total, no double-count.
  - "account_id=0" in the dashboard = NO owner_account_id filter (all seats) -> we omit it.
  - metric columns are <name>_total / _email / _sms; deals/meetings/revenue are plain.
  - rows are SPARSE (no row for a zero-activity day) -> day-count is NOT a per-client
    reliability signal; a GLOBAL day-coverage + volume guard catches pipeline gaps.
  - date is timestamptz truncated to UTC midnight -> we SET TIME ZONE 'UTC' before filtering.
  - campaign_id is NULL (not 0) when unattributed; summing across campaigns == tenant total.

Deterministic given (--week-start, DB contents). Default report week = the previous
complete calendar week (Mon-Sun) relative to --today (default: system date). No paid APIs.

Usage:
  ANALYTICS_DB_DSN=... USERS_DB_DSN=... CAMPAIGN_DB_DSN=... python collect.py --out runs/2026-09-07.json
  python collect.py --week-start 2026-09-07 --analytics-dsn ... --users-dsn ... --campaign-dsn ... --out -
"""
import argparse
import datetime as dt
import json
import os
import sys
from decimal import Decimal

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    sys.exit("collect.py requires psycopg2 (pip install psycopg2-binary)")

# ------------------------- tunable red-flag rule (constants) -------------------------
BASELINE_WEEKS = 4            # trailing weeks that form the baseline
MIN_BASELINE_WEEKS = 2        # fewer active baseline weeks than this -> "new", no flags
SERIES_WEEKS = 8             # weeks of trend series emitted for sparklines (incl. report week)
THRESHOLD_PCT = 0.30          # >= 30% off-trend in the unhealthy direction -> flag
CRITICAL_PCT = 0.60           # >= 60% move (or dropped-to-zero) -> critical severity
FLOOR_SENDS = 10              # baseline messages_sent below this -> skip send-derived flags
FLOOR_REPLIES = 3             # baseline replies below this -> skip reply/sentiment flags
GLOBAL_MIN_RATIO = 0.35       # report-week total vol < this * baseline avg -> pipeline-gap alert
PER_CAMPAIGN_CAP = 8         # max campaigns listed per client (rest folded into "+N more")
RECENT_SEND_WEEKS = 6        # a client counts as a "real client" if it sent within this many weeks
# "real client" = has open deals OR sent recently. A real client not sending this week -> "paused"
# (NOT "dormant"/flagged). A non-real client (no open deals + no recent sends) -> "inactive".

MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# metric registry: key, label, total column, (email col, sms col) or None, direction, floor group
#   direction: 'down' = unhealthy when it falls; 'up' = unhealthy when it rises; 'neutral' = shown, never flagged
#   floor: 'sends' gates on baseline messages_sent; 'replies' gates on baseline replies; None = gate on own baseline>0
METRICS = [
    ("messages_sent",      "Messages sent",      "messages_sent_total",      ("messages_sent_email", "messages_sent_sms"),           "down",    "sends"),
    ("replies_received",   "Replies received",   "replies_received_total",   ("replies_received_email", "replies_received_sms"),     "down",    "replies"),
    ("positive_sentiment", "Positive sentiment", "positive_sentiment_total", ("positive_sentiment_email", "positive_sentiment_sms"), "down",   "replies"),
    ("negative_sentiment", "Negative sentiment", "negative_sentiment_total", ("negative_sentiment_email", "negative_sentiment_sms"), "up",     "replies"),
    ("blocked",            "Blocked / bounced",  "blocked_total",            ("blocked_email", "blocked_sms"),                       "up",      "sends"),
    ("links_clicked",      "Links clicked",      "links_clicked_total",      ("links_clicked_email", "links_clicked_sms"),           "down",    "sends"),
    ("meetings_booked",    "Meetings booked",    "meetings_booked",          None,                                                   "down",    "sends"),
    ("meetings_completed", "Meetings completed", "meetings_completed",       None,                                                   "neutral", None),
    ("meetings_cancelled", "Meetings cancelled", "meetings_cancelled",       None,                                                   "neutral", None),
    ("meetings_no_showed", "Meetings no-showed", "meetings_no_showed",       None,                                                   "neutral", None),
    ("deals_won",          "Deals won",          "deals_won",                None,                                                   "neutral", None),
    ("deals_lost",         "Deals lost",         "deals_lost",               None,                                                   "neutral", None),
    ("revenue_generated",  "Revenue generated",  "revenue_generated",        None,                                                   "down",    "sends"),
]
ALL_KEYS = [m[0] for m in METRICS]
# metrics whose weekly trend is drawn as a sparkline (the "trend line" the flags reference)
SERIES_KEYS = ["messages_sent", "replies_received", "positive_sentiment", "meetings_booked", "revenue_generated"]

# Hours-Saved default minute weights (FE features/settings/constants/hoursSaved.ts).
HS_WEIGHTS = {"email_sent": 3, "sms_sent": 2, "deal_won": 15, "deal_lost": 5}


def monday_of(d):
    return d - dt.timedelta(days=d.weekday())


def week_window(today):
    report_start = monday_of(today) - dt.timedelta(days=7)
    return report_start, report_start + dt.timedelta(days=6)


def week_label(start, end):
    if start.year == end.year:
        return f"{MONTHS[start.month]} {start.day} – {MONTHS[end.month]} {end.day}, {end.year}"
    return f"{MONTHS[start.month]} {start.day}, {start.year} – {MONTHS[end.month]} {end.day}, {end.year}"


def _num(v):
    # Postgres SUM(bigint) -> numeric -> psycopg2 Decimal; COUNT -> bigint -> int.
    if v is None:
        return 0
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def _mean(vals):
    vals = [v for v in vals if v is not None]
    return (sum(vals) / len(vals)) if vals else None


def _pct_str(tw, bl):
    if bl in (None, 0):
        return None
    p = (tw - bl) / bl
    return f"{'+' if p >= 0 else ''}{round(p * 100)}%"


def build_metrics_sql():
    cols = []
    for key, _label, total, split, _dir, _floor in METRICS:
        cols.append(f"COALESCE(SUM({total}),0) AS {key}")
        if split:
            e, s = split
            cols.append(f"COALESCE(SUM({e}),0) AS {key}_email")
            cols.append(f"COALESCE(SUM({s}),0) AS {key}_sms")
    col_sql = ",\n       ".join(cols)
    return f"""
SELECT parent_user_id, campaign_id, date_trunc('week', date)::date AS wk,
       count(DISTINCT date::date) AS days,
       {col_sql}
FROM public.daily_analytics_snapshots
WHERE date >= %(start)s AND date < %(end)s
GROUP BY parent_user_id, campaign_id, date_trunc('week', date)
"""


def fetch_snapshots(dsn, lo, hi):
    """{parent_user_id: {campaign_id(None ok): {wk_date: rowdict}}} across [lo, hi)."""
    out = {}
    conn = psycopg2.connect(dsn)
    try:
        conn.set_session(readonly=True, autocommit=True)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SET TIME ZONE 'UTC'")
            cur.execute(build_metrics_sql(), {"start": lo, "end": hi})
            for r in cur.fetchall():
                out.setdefault(r["parent_user_id"], {}).setdefault(r["campaign_id"], {})[r["wk"]] = dict(r)
    finally:
        conn.close()
    return out


def fetch_week_coverage(dsn, lo, hi):
    """{week_monday: set(dates present)} — table-level day coverage (precalc-gap signal)."""
    conn = psycopg2.connect(dsn)
    try:
        conn.set_session(readonly=True, autocommit=True)
        with conn.cursor() as cur:
            cur.execute("SET TIME ZONE 'UTC'")
            cur.execute(
                "SELECT date_trunc('week', date)::date AS wk, date::date AS d "
                "FROM public.daily_analytics_snapshots "
                "WHERE date >= %(start)s AND date < %(end)s GROUP BY 1, 2",
                {"start": lo, "end": hi})
            cov = {}
            for wk, d in cur.fetchall():
                cov.setdefault(wk, set()).add(d)
            return cov
    finally:
        conn.close()


def fetch_clients(dsn):
    """Active client tenants: accounts(is_active,is_admin,deleted_at IS NULL) -> users."""
    sql = """
        SELECT u.id AS parent_user_id,
               COALESCE(NULLIF(TRIM(u.company_name), ''), 'User ' || u.id) AS name
        FROM accounts a
        JOIN users u ON u.id = a.user_id
        WHERE a.is_active = true AND a.is_admin = true AND a.deleted_at IS NULL
        GROUP BY u.id, u.company_name
        ORDER BY name
    """
    conn = psycopg2.connect(dsn)
    try:
        conn.set_session(readonly=True, autocommit=True)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql)
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


def fetch_campaign_meta(dsn, pids):
    """{(parent_user_id, campaign_id): {'name','is_active'}} + set of pids with an active campaign."""
    meta, active_pids = {}, set()
    if not pids:
        return meta, active_pids
    conn = psycopg2.connect(dsn)
    try:
        conn.set_session(readonly=True, autocommit=True)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT parent_user_id, id, name, is_active "
                "FROM automation_campaigns WHERE parent_user_id = ANY(%s)",
                (list(pids),))
            for r in cur.fetchall():
                meta[(r["parent_user_id"], r["id"])] = {
                    "name": (r["name"] or f"Campaign {r['id']}").strip(),
                    "is_active": bool(r["is_active"]),
                }
                if r["is_active"]:
                    active_pids.add(r["parent_user_id"])
    finally:
        conn.close()
    return meta, active_pids


def fetch_open_deals(dsn, pids):
    """{parent_user_id: open_deal_count} — 'real client' signal (status OPEN, uppercase)."""
    out = {}
    if not pids:
        return out
    conn = psycopg2.connect(dsn)
    try:
        conn.set_session(readonly=True, autocommit=True)
        with conn.cursor() as cur:
            cur.execute("SELECT parent_user_id, count(*) FROM deals "
                        "WHERE parent_user_id = ANY(%s) AND status = 'OPEN' GROUP BY parent_user_id",
                        (list(pids),))
            for pid, cnt in cur.fetchall():
                out[pid] = int(cnt)
    finally:
        conn.close()
    return out


def _agg_weeks(campaign_map):
    """Collapse {campaign_id: {wk: row}} -> {wk: {metric: total, 'days': maxdays}} (client totals)."""
    weeks = {}
    for _cid, wkmap in campaign_map.items():
        for wk, row in wkmap.items():
            acc = weeks.setdefault(wk, {k: 0 for k in ALL_KEYS})
            for k in ALL_KEYS:
                acc[k] += _num(row.get(k, 0))
            for k in ALL_KEYS:
                for suf in ("_email", "_sms"):
                    if (k + suf) in row:
                        acc[k + suf] = acc.get(k + suf, 0) + _num(row.get(k + suf, 0))
            acc["days"] = max(acc.get("days", 0), _num(row.get("days", 0)))
    return weeks


def _has_activity(row):
    return bool(row) and (_num(row.get("messages_sent", 0)) > 0 or _num(row.get("replies_received", 0)) > 0)


def analyze_client(name, pid, campaign_map, cmeta, has_active_campaign, open_deals,
                   report_wk, baseline_mondays, series_mondays, suppress_flags):
    weeks = _agg_weeks(campaign_map)
    report = weeks.get(report_wk)
    baseline_rows = [weeks[w] for w in baseline_mondays if w in weeks]
    baseline_active = sum(1 for r in baseline_rows if _has_activity(r))

    def bl(key):
        return _mean([_num(r.get(key, 0)) for r in baseline_rows]) if baseline_rows else None

    def tw(key):
        return _num(report.get(key, 0)) if report else 0

    # ---- "real client" = has open deals OR sent within RECENT_SEND_WEEKS ----
    recent_send = any(_num((weeks.get(w) or {}).get("messages_sent", 0)) > 0
                      for w in series_mondays[-RECENT_SEND_WEEKS:])
    real_client = (open_deals > 0) or recent_send

    # ---- status ----
    #   sends this week             -> active / new (+ flags via the metric loop)
    #   incomplete week + real      -> active (don't demote a real client on missing data)
    #   real client, no sends       -> paused   (real client, campaigns paused / quiet — NOT flagged)
    #   not a real client, no sends -> inactive (no open deals + no recent sends: test / never-launched)
    if _has_activity(report):
        status = "new" if baseline_active < MIN_BASELINE_WEEKS else "active"
    elif suppress_flags and real_client:
        status = "active"
    elif real_client:
        status = "paused"
    else:
        status = "inactive"

    # ---- 8-week trend series (client totals per SERIES_KEYS) ----
    series = {"weeks": [], "data": {k: [] for k in SERIES_KEYS}}
    for w in series_mondays:
        series["weeks"].append(f"{MONTHS[w.month]} {w.day}")
        row = weeks.get(w) or {}
        for k in SERIES_KEYS:
            series["data"][k].append(_num(row.get(k, 0)))

    if status in ("paused", "inactive"):
        last_active = None
        for w in sorted(weeks.keys(), reverse=True):
            if _has_activity(weeks[w]):
                last_active = f"{MONTHS[w.month]} {w.day}, {w.year}"
                break
        if status == "paused":
            camp = ("⚠ campaign active but no sends this week" if has_active_campaign else "campaigns off")
            note = (f"Real client ({open_deals:,} open deals) — not sending this week ({camp}"
                    + (f"; last active {last_active}" if last_active else "") + ").")
        else:
            note = "No open deals and no recent sends — not launched / inactive."
        return {
            "name": name, "parent_user_id": pid, "status": status, "note": note,
            "has_active_campaign": has_active_campaign, "open_deals": open_deals,
            "real_client": real_client, "last_active": last_active,
            "flags": [], "metrics": [], "funnel": None, "derived": None,
            "campaigns": [], "series": series,
            "completeness": {"days_present": (tw("days") if report else 0), "days_expected": 7, "warning": None},
        }

    has_baseline = baseline_active >= MIN_BASELINE_WEEKS
    bl_sends, bl_replies = bl("messages_sent"), bl("replies_received")
    metrics_out, flags_out = [], []

    for key, label, _total, split, direction, floor in METRICS:
        v = tw(key)
        b = bl(key) if has_baseline else None
        flagged = False
        if floor == "sends":
            gate_ok = (bl_sends is not None and bl_sends >= FLOOR_SENDS)
        elif floor == "replies":
            gate_ok = (bl_replies is not None and bl_replies >= FLOOR_REPLIES)
        else:
            gate_ok = (b is not None and b > 0)

        if (not suppress_flags) and has_baseline and direction != "neutral" and gate_ok and b is not None:
            if direction == "down" and b > 0 and v == 0:
                flagged = True
                flags_out.append({"metric": label, "direction": "down", "this_week": v,
                                  "baseline": round(b, 1), "pct": "to zero", "severity": "critical"})
            elif b > 0:
                p = (v - b) / b
                if direction == "down" and p <= -THRESHOLD_PCT:
                    flagged = True
                    flags_out.append({"metric": label, "direction": "down", "this_week": v,
                                      "baseline": round(b, 1), "pct": f"{round(p * 100)}%",
                                      "severity": "critical" if p <= -CRITICAL_PCT else "warn"})
                elif direction == "up" and p >= THRESHOLD_PCT:
                    flagged = True
                    flags_out.append({"metric": label, "direction": "up", "this_week": v,
                                      "baseline": round(b, 1), "pct": f"+{round(p * 100)}%",
                                      "severity": "critical" if p >= 1.0 else "warn"})

        m = {"key": key, "label": label, "value": v,
             "baseline": (round(b, 1) if b is not None else None),
             "delta_pct": _pct_str(v, b), "flagged": flagged,
             "direction": direction}
        if split:
            m["email"], m["sms"] = tw(key + "_email"), tw(key + "_sms")
        else:
            m["email"], m["sms"] = None, None
        metrics_out.append(m)

    # ---- per-campaign breakdown (this week) ----
    campaigns_out = []
    for cid, wkmap in campaign_map.items():
        row = wkmap.get(report_wk)
        if not row:
            continue
        sent = _num(row.get("messages_sent", 0))
        meta = cmeta.get((pid, cid), {})
        cname = meta.get("name") or ("(no campaign)" if cid is None else f"Campaign {cid}")
        campaigns_out.append({
            "id": cid, "name": cname, "is_active": meta.get("is_active", False),
            "sent": sent, "replies": _num(row.get("replies_received", 0)),
            "positive": _num(row.get("positive_sentiment", 0)),
            "negative": _num(row.get("negative_sentiment", 0)),
            "clicked": _num(row.get("links_clicked", 0)),
            "booked": _num(row.get("meetings_booked", 0)),
            "won": _num(row.get("deals_won", 0)),
            "revenue": _num(row.get("revenue_generated", 0)),
        })
    campaigns_out.sort(key=lambda c: (-c["sent"], -c["replies"], str(c["name"]).lower()))
    campaigns_more = 0
    if len(campaigns_out) > PER_CAMPAIGN_CAP:
        campaigns_more = len(campaigns_out) - PER_CAMPAIGN_CAP
        campaigns_out = campaigns_out[:PER_CAMPAIGN_CAP]
    if campaigns_more:
        campaigns_out.append({"id": None, "name": f"+{campaigns_more} more campaign(s)", "is_active": False,
                              "sent": None, "replies": None, "positive": None, "negative": None,
                              "clicked": None, "booked": None, "won": None, "revenue": None})

    ms, dw, dl = tw("messages_sent"), tw("deals_won"), tw("deals_lost")
    mins = (tw("messages_sent_email") * HS_WEIGHTS["email_sent"] + tw("messages_sent_sms") * HS_WEIGHTS["sms_sent"]
            + dw * HS_WEIGHTS["deal_won"] + dl * HS_WEIGHTS["deal_lost"])

    return {
        "name": name, "parent_user_id": pid, "status": status, "note": None,
        "has_active_campaign": has_active_campaign, "open_deals": open_deals, "real_client": real_client,
        "flags": flags_out, "metrics": metrics_out,
        "funnel": {"sent": ms, "clicked": tw("links_clicked"),
                   "booked": tw("meetings_booked"), "completed": tw("meetings_completed")},
        "derived": {"actions_performed": ms + dw + dl, "hours_saved": f"{round(mins / 60.0, 1)} (default weights)"},
        "campaigns": campaigns_out, "series": series,
        "completeness": {"days_present": (tw("days") if report else 0), "days_expected": 7, "warning": None},
    }


def collect(analytics_dsn, users_dsn, campaign_dsn, report_start, title):
    report_end = report_start + dt.timedelta(days=6)
    report_wk = monday_of(report_start)
    baseline_mondays = [report_start - dt.timedelta(days=7 * i) for i in range(1, BASELINE_WEEKS + 1)]
    series_mondays = [report_start - dt.timedelta(days=7 * i) for i in range(SERIES_WEEKS - 1, -1, -1)]
    lo = min(series_mondays + baseline_mondays)
    hi = report_start + dt.timedelta(days=7)

    clients = fetch_clients(users_dsn)
    pids = [c["parent_user_id"] for c in clients]
    snaps = fetch_snapshots(analytics_dsn, lo, hi)
    coverage = fetch_week_coverage(analytics_dsn, lo, hi)
    cmeta, active_campaign_pids = fetch_campaign_meta(campaign_dsn, pids)
    open_deals_by_pid = fetch_open_deals(campaign_dsn, pids)

    # ---- global completeness guard (day-coverage primary, volume backstop) ----
    report_dates = coverage.get(report_wk, set())
    report_days = len(report_dates)
    baseline_daycounts = [len(coverage.get(w, set())) for w in baseline_mondays if len(coverage.get(w, set())) > 0]
    expected_days = max(baseline_daycounts) if baseline_daycounts else 7

    def total_vol(wk):
        tot = 0
        for cmap in snaps.values():
            for wkmap in cmap.values():
                if wk in wkmap:
                    tot += _num(wkmap[wk].get("messages_sent", 0))
        return tot
    report_vol = total_vol(report_wk)
    baseline_vols = [v for v in (total_vol(w) for w in baseline_mondays) if v > 0]
    baseline_avg = (sum(baseline_vols) / len(baseline_vols)) if baseline_vols else 0

    day_gap = report_days < expected_days - 1
    vol_gap = baseline_avg > 0 and report_vol < GLOBAL_MIN_RATIO * baseline_avg
    suppress = day_gap or vol_gap
    alert = None
    if suppress:
        missing = sorted({report_start + dt.timedelta(days=i) for i in range(7)} - report_dates)
        reasons = []
        if day_gap:
            reasons.append(f"snapshots for only {report_days} of {expected_days} days")
        if vol_gap:
            reasons.append(f"send volume {round(100 * report_vol / baseline_avg)}% of the {len(baseline_vols)}-week average")
        miss_txt = (" Missing: " + ", ".join(f"{MONTHS[m.month]} {m.day}" for m in missing) + ".") if missing else ""
        alert = ("⚠ The analytics precalc looks INCOMPLETE for this week (" + "; ".join(reasons) + ")."
                 + miss_txt +
                 " Red flags are SUPPRESSED to avoid false churn alerts — verify the nightly precalc ran "
                 "for every day of the week before acting on these numbers.")

    out = []
    for c in clients:
        pid = c["parent_user_id"]
        try:
            out.append(analyze_client(c["name"], pid, snaps.get(pid, {}), cmeta,
                                      pid in active_campaign_pids, open_deals_by_pid.get(pid, 0),
                                      report_wk, baseline_mondays, series_mondays, suppress))
        except Exception as e:
            out.append({"name": c["name"], "parent_user_id": pid, "status": "error",
                        "note": f"Collection failed for this client: {type(e).__name__}: {e}",
                        "has_active_campaign": pid in active_campaign_pids,
                        "open_deals": open_deals_by_pid.get(pid, 0), "real_client": None,
                        "flags": [], "metrics": [], "funnel": None, "derived": None,
                        "campaigns": [], "series": None,
                        "completeness": {"days_present": 0, "days_expected": 7, "warning": None}})

    flagged = sum(1 for c in out if c.get("flags"))
    inactive = sum(1 for c in out if c.get("status") == "inactive")
    paused = sum(1 for c in out if c.get("status") == "paused")
    active = sum(1 for c in out if c.get("status") in ("active", "new"))

    doc = {
        "title": title,
        "week_label": week_label(report_start, report_end),
        "week_start": report_start.isoformat(),
        "week_end": report_end.isoformat(),
        "summary": {"clients_total": len(out), "clients_active": active, "clients_flagged": flagged,
                    "clients_paused": paused, "clients_inactive": inactive},
        "clients": out,
        "method": (f"Read-only weekly digest. Per client, metrics are SUM(public.daily_analytics_snapshots) "
                   f"over the report week, tenant-wide (all seats). Baseline = trailing {BASELINE_WEEKS}-week "
                   f"average over weeks with activity; the trend sparkline covers {SERIES_WEEKS} weeks. A metric "
                   f"is red-flagged when it moves ≥ {round(THRESHOLD_PCT*100)}% in the unhealthy direction (down: "
                   f"sends/replies/positive/meetings/revenue; up: negative/blocked), above a min-volume floor "
                   f"(baseline ≥ {FLOOR_SENDS} sends / ≥ {FLOOR_REPLIES} replies), or drops to zero after prior "
                   f"activity. Clients with < {MIN_BASELINE_WEEKS} active baseline weeks render without flags "
                   f"(“new”). A real client (open deals OR a send within {RECENT_SEND_WEEKS} weeks) that isn’t "
                   f"sending this week is shown as “paused” (not flagged); accounts with no open deals and no "
                   f"recent sends are “inactive”. Per-campaign breakdowns use campaign names from revhero_prod_campaign. Snapshot rows "
                   f"are sparse; a global day-coverage guard suppresses all flags if the report week looks like a "
                   f"pipeline gap."),
    }
    if alert:
        doc["alert"] = alert
    return doc


def parse_date(s):
    return dt.datetime.strptime(s, "%Y-%m-%d").date()


def main():
    ap = argparse.ArgumentParser(description="Collect weekly client-health analytics.")
    ap.add_argument("--week-start", type=parse_date, help="Monday of the report week (YYYY-MM-DD). Default: previous complete week.")
    ap.add_argument("--today", type=parse_date, help="Reference date for 'previous week'. Default: system date.")
    ap.add_argument("--analytics-dsn", default=os.environ.get("ANALYTICS_DB_DSN"))
    ap.add_argument("--users-dsn", default=os.environ.get("USERS_DB_DSN"))
    ap.add_argument("--campaign-dsn", default=os.environ.get("CAMPAIGN_DB_DSN"))
    ap.add_argument("--title", default="Weekly Client Analytics — Health Digest")
    ap.add_argument("--out", default="-", help="Output path, or '-' for stdout.")
    args = ap.parse_args()

    if not args.analytics_dsn or not args.users_dsn or not args.campaign_dsn:
        sys.exit("ERROR: set ANALYTICS_DB_DSN, USERS_DB_DSN and CAMPAIGN_DB_DSN (or the --*-dsn flags).")

    if args.week_start:
        report_start = monday_of(args.week_start)
    else:
        report_start, _ = week_window(args.today or dt.date.today())

    doc = collect(args.analytics_dsn, args.users_dsn, args.campaign_dsn, report_start, args.title)
    text = json.dumps(doc, indent=2, ensure_ascii=False)
    if args.out == "-":
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
        sys.stdout.write(text + "\n")
    else:
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text + "\n")
        sys.stderr.write(f"wrote {args.out}\n")


if __name__ == "__main__":
    main()
