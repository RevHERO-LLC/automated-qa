#!/usr/bin/env python3
"""
Collector for the weekly-analytics client-health digest.

READ-ONLY. Reads two Postgres DBs and emits the render schema.json shape as JSON:
  USERS_DB_DSN     -> revhero_prod_users     : enumerate active client tenants
  ANALYTICS_DB_DSN -> revhero_prod_analytics : SUM public.daily_analytics_snapshots

Per client it computes: this-week metric totals (tenant-wide, all seats), the prior
N-week trailing baseline, red flags for off-trend metrics, the booking funnel, the
derived KPIs (Actions Performed, Hours Saved), and data-completeness context.

Authoritative schema facts (verified against prod + analytics-service source 2026-09-15):
  - table is public.daily_analytics_snapshots (NOT internal_analytics.*)
  - grain = (date, parent_user_id, owner_account_id, campaign_id, stage_id, variant_id);
    unique on that sextuple, so summing all rows per parent = tenant total, no double-count.
  - "account_id=0" in the dashboard = NO owner_account_id filter (all seats) -> we omit it.
  - metric columns are <name>_total / _email / _sms; deals/meetings/revenue are plain.
  - rows are SPARSE (no row for a zero-activity day) -> day-count is NOT a reliable
    "did the precalc run" signal; we use a GLOBAL volume guard for pipeline gaps instead.
  - date is timestamptz truncated to UTC midnight -> we SET TIME ZONE 'UTC' before filtering.

Deterministic given (--week-start, DB contents). Default report week = the previous
complete calendar week (Mon-Sun) relative to --today (default: system date). No paid APIs.

Usage:
  ANALYTICS_DB_DSN=... USERS_DB_DSN=... python collect.py --out runs/2026-09-08.json
  python collect.py --week-start 2026-09-08 --analytics-dsn ... --users-dsn ... --out -
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
THRESHOLD_PCT = 0.30          # >= 30% off-trend in the unhealthy direction -> flag
CRITICAL_PCT = 0.60           # >= 60% move (or dropped-to-zero) -> critical severity
FLOOR_SENDS = 10              # baseline messages_sent below this -> skip send-derived flags
FLOOR_REPLIES = 3             # baseline replies below this -> skip reply/sentiment flags
GLOBAL_MIN_RATIO = 0.35       # report-week total vol < this * baseline avg -> pipeline-gap alert

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

# Hours-Saved default minute weights (FE features/settings/constants/hoursSaved.ts).
# Only email_sent/sms_sent/deal_won/deal_lost have non-zero counts in the FE compute.
HS_WEIGHTS = {"email_sent": 3, "sms_sent": 2, "deal_won": 15, "deal_lost": 5}


def monday_of(d):
    return d - dt.timedelta(days=d.weekday())


def week_window(today):
    """Previous complete calendar week (Mon..Sun) relative to `today`."""
    report_start = monday_of(today) - dt.timedelta(days=7)
    report_end = report_start + dt.timedelta(days=6)
    return report_start, report_end


def week_label(start, end):
    if start.year == end.year:
        return f"{MONTHS[start.month]} {start.day} – {MONTHS[end.month]} {end.day}, {end.year}"
    return f"{MONTHS[start.month]} {start.day}, {start.year} – {MONTHS[end.month]} {end.day}, {end.year}"


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
SELECT parent_user_id,
       date_trunc('week', date)::date AS wk,
       count(DISTINCT date::date) AS days,
       {col_sql}
FROM public.daily_analytics_snapshots
WHERE date >= %(start)s AND date < %(end)s
GROUP BY parent_user_id, date_trunc('week', date)
"""


def fetch_snapshots(dsn, start_exclusive_lo, end_exclusive_hi):
    """Return {parent_user_id: {wk_date: rowdict}} across [lo, hi)."""
    out = {}
    conn = psycopg2.connect(dsn)
    try:
        conn.set_session(readonly=True, autocommit=True)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SET TIME ZONE 'UTC'")
            cur.execute(build_metrics_sql(), {"start": start_exclusive_lo, "end": end_exclusive_hi})
            for r in cur.fetchall():
                pid = r["parent_user_id"]
                out.setdefault(pid, {})[r["wk"]] = dict(r)
    finally:
        conn.close()
    return out


def fetch_week_coverage(dsn, lo, hi):
    """{week_monday: set(dates present)} — table-level day coverage. With ~10 active
    tenants every real calendar day gets >=1 row, so a week missing days = precalc gap."""
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


def _num(v):
    # Postgres SUM(bigint) -> numeric -> psycopg2 Decimal; COUNT -> bigint -> int.
    # Normalize everything to plain int/float so arithmetic + json.dumps both work.
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


def _has_activity(row):
    return row and (_num(row.get("messages_sent", 0)) > 0 or _num(row.get("replies_received", 0)) > 0)


def _pct_str(tw, bl):
    if bl in (None, 0):
        return None
    p = (tw - bl) / bl
    return f"{'+' if p >= 0 else ''}{round(p * 100)}%"


def analyze_client(name, pid, weeks, report_wk, baseline_mondays, suppress_flags):
    """Build one client record (schema.json shape) from its weekly buckets."""
    report = weeks.get(report_wk)
    baseline_rows = [weeks[w] for w in baseline_mondays if w in weeks]
    baseline_active = sum(1 for r in baseline_rows if _has_activity(r))

    def bl(key):
        return _mean([_num(r.get(key, 0)) for r in baseline_rows]) if baseline_rows else None

    def tw(key):
        return _num(report.get(key, 0)) if report else 0

    bl_sends = bl("messages_sent")
    bl_replies = bl("replies_received")

    # ---- status ----
    # dropped_to_zero is a churn SIGNAL, so it takes the same bar as flags: >= MIN_BASELINE_WEEKS
    # of prior activity, and it is suppressed during an incomplete-precalc week (a "0" that is
    # really just missing days must not masquerade as churn).
    if report is None and baseline_active == 0:
        status = "no_data"
    elif _has_activity(report) and baseline_active < MIN_BASELINE_WEEKS:
        status = "new"
    elif (not _has_activity(report)) and baseline_active >= MIN_BASELINE_WEEKS and not suppress_flags:
        status = "dropped_to_zero"
    else:
        status = "active"

    if status == "no_data":
        return {
            "name": name, "parent_user_id": pid, "status": "no_data",
            "note": "Active account, no activity recorded and no prior baseline — not launched or paused.",
            "flags": [], "metrics": [], "funnel": None, "derived": None,
            "completeness": {"days_present": 0, "days_expected": 7, "warning": None},
        }

    has_baseline = baseline_active >= MIN_BASELINE_WEEKS
    metrics_out, flags_out = [], []

    for key, label, _total, split, direction, floor in METRICS:
        v = tw(key)
        b = bl(key) if has_baseline else None
        flagged = False
        # floor gate for flagging
        gate_ok = True
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
             "delta_pct": _pct_str(v, b),
             "flagged": flagged,
             "direction": direction if direction != "neutral" else "neutral"}
        if split:
            m["email"] = tw(key + "_email")
            m["sms"] = tw(key + "_sms")
        else:
            m["email"] = None
            m["sms"] = None
        metrics_out.append(m)

    # ---- derived KPIs (mirror FE formulas) ----
    ms = tw("messages_sent"); dw = tw("deals_won"); dl = tw("deals_lost")
    actions = ms + dw + dl
    mins = (tw("messages_sent_email") * HS_WEIGHTS["email_sent"]
            + tw("messages_sent_sms") * HS_WEIGHTS["sms_sent"]
            + dw * HS_WEIGHTS["deal_won"] + dl * HS_WEIGHTS["deal_lost"])
    hours = round(mins / 60.0, 1)

    days_present = _num(report.get("days", 0)) if report else 0

    return {
        "name": name, "parent_user_id": pid,
        "status": status, "note": None,
        "flags": flags_out,
        "metrics": metrics_out,
        "funnel": {"sent": ms, "clicked": tw("links_clicked"),
                   "booked": tw("meetings_booked"), "completed": tw("meetings_completed")},
        "derived": {"actions_performed": actions, "hours_saved": f"{hours} (default weights)"},
        "completeness": {"days_present": days_present, "days_expected": 7, "warning": None},
    }


def collect(analytics_dsn, users_dsn, report_start, title):
    report_end = report_start + dt.timedelta(days=6)
    report_wk = monday_of(report_start)  # == report_start (it is a Monday)
    baseline_mondays = [report_start - dt.timedelta(days=7 * i) for i in range(1, BASELINE_WEEKS + 1)]
    lo = min(baseline_mondays)
    hi = report_start + dt.timedelta(days=7)  # exclusive upper bound

    clients = fetch_clients(users_dsn)
    weeks_by_pid = fetch_snapshots(analytics_dsn, lo, hi)

    # ---- global completeness guard: catch an incomplete precalc for the report week ----
    # Two independent signals; either one suppresses all flags (avoid false churn alerts):
    #   (1) day-coverage: report week has >=2 fewer distinct days than a full baseline week
    #       (rows are sparse per-client, but table-level day coverage is reliable).
    #   (2) volume: report-week send volume far below the trailing weekly average.
    coverage = fetch_week_coverage(analytics_dsn, lo, hi)
    report_dates = coverage.get(report_wk, set())
    report_days = len(report_dates)
    baseline_daycounts = [len(coverage.get(w, set())) for w in baseline_mondays]
    baseline_daycounts = [d for d in baseline_daycounts if d > 0]
    expected_days = max(baseline_daycounts) if baseline_daycounts else 7

    def total_vol(wk):
        return sum(_num(w[wk].get("messages_sent", 0)) for w in weeks_by_pid.values() if wk in w)
    report_vol = total_vol(report_wk)
    baseline_vols = [v for v in (total_vol(w) for w in baseline_mondays) if v > 0]
    baseline_avg = (sum(baseline_vols) / len(baseline_vols)) if baseline_vols else 0

    day_gap = report_days < expected_days - 1
    vol_gap = baseline_avg > 0 and report_vol < GLOBAL_MIN_RATIO * baseline_avg
    suppress = day_gap or vol_gap
    alert = None
    if suppress:
        expected_all = {report_start + dt.timedelta(days=i) for i in range(7)}
        missing = sorted(expected_all - report_dates)
        reasons = []
        if day_gap:
            reasons.append(f"snapshots for only {report_days} of {expected_days} days")
        if vol_gap:
            reasons.append(f"send volume {round(100 * report_vol / baseline_avg)}% of the "
                           f"{len(baseline_vols)}-week average")
        miss_txt = (" Missing: " + ", ".join(f"{MONTHS[m.month]} {m.day}" for m in missing) + ".") if missing else ""
        alert = ("⚠ The analytics precalc looks INCOMPLETE for this week (" + "; ".join(reasons) + ")."
                 + miss_txt +
                 " Red flags are SUPPRESSED to avoid false churn alerts — verify the nightly precalc ran "
                 "for every day of the week before acting on these numbers.")

    out_clients = []
    for c in clients:
        pid = c["parent_user_id"]
        try:
            out_clients.append(analyze_client(c["name"], pid, weeks_by_pid.get(pid, {}),
                                              report_wk, baseline_mondays, suppress))
        except Exception as e:  # per-client isolation: one bad client never crashes the report
            out_clients.append({
                "name": c["name"], "parent_user_id": pid, "status": "error",
                "note": f"Collection failed for this client: {type(e).__name__}: {e}",
                "flags": [], "metrics": [], "funnel": None, "derived": None,
                "completeness": {"days_present": 0, "days_expected": 7, "warning": None},
            })

    flagged = sum(1 for c in out_clients if c.get("flags"))
    no_data = sum(1 for c in out_clients if c.get("status") == "no_data")
    active = sum(1 for c in out_clients if c.get("status") in ("active", "dropped_to_zero", "new"))

    doc = {
        "title": title,
        "week_label": week_label(report_start, report_end),
        "week_start": report_start.isoformat(),
        "week_end": report_end.isoformat(),
        "summary": {"clients_total": len(out_clients), "clients_active": active,
                    "clients_flagged": flagged, "clients_no_data": no_data},
        "clients": out_clients,
        "method": ("Read-only weekly digest. Per client, metrics are SUM(public.daily_analytics_snapshots) "
                   "over the report week, tenant-wide (all seats, no owner_account_id filter — matching the "
                   f"dashboard's account_id=0). Baseline = trailing {BASELINE_WEEKS}-week average over weeks with "
                   f"activity. A metric is red-flagged when it moves ≥ {round(THRESHOLD_PCT*100)}% in the unhealthy "
                   "direction (down: sends/replies/positive/meetings/revenue; up: negative/blocked), above a "
                   f"min-volume floor (baseline ≥ {FLOOR_SENDS} sends / ≥ {FLOOR_REPLIES} replies), or drops to zero "
                   f"after prior activity. Clients with < {MIN_BASELINE_WEEKS} active baseline weeks render without flags "
                   "(“new”). Snapshot rows are sparse (no row for a zero-activity day), so day-count is context "
                   "only; a global volume guard suppresses all flags if the report week looks like a pipeline gap."),
    }
    if alert:
        doc["alert"] = alert
    return doc


def parse_date(s):
    return dt.datetime.strptime(s, "%Y-%m-%d").date()


def main():
    ap = argparse.ArgumentParser(description="Collect weekly client-health analytics.")
    ap.add_argument("--week-start", type=parse_date, help="Monday of the report week (YYYY-MM-DD). Default: previous complete week.")
    ap.add_argument("--today", type=parse_date, help="Reference date for 'previous week' (YYYY-MM-DD). Default: system date.")
    ap.add_argument("--analytics-dsn", default=os.environ.get("ANALYTICS_DB_DSN"), help="DSN for revhero_prod_analytics (or env ANALYTICS_DB_DSN).")
    ap.add_argument("--users-dsn", default=os.environ.get("USERS_DB_DSN"), help="DSN for revhero_prod_users (or env USERS_DB_DSN).")
    ap.add_argument("--title", default="Weekly Client Analytics — Health Digest")
    ap.add_argument("--out", default="-", help="Output path, or '-' for stdout.")
    args = ap.parse_args()

    if not args.analytics_dsn or not args.users_dsn:
        sys.exit("ERROR: set ANALYTICS_DB_DSN and USERS_DB_DSN (or --analytics-dsn/--users-dsn).")

    if args.week_start:
        report_start = monday_of(args.week_start)
    else:
        today = args.today or dt.date.today()
        report_start, _ = week_window(today)

    doc = collect(args.analytics_dsn, args.users_dsn, report_start, args.title)
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
