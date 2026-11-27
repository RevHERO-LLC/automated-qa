#!/usr/bin/env python3
"""
Offline tests for the Auto-Replies metric in the weekly-analytics digest (UAT AN-01).

No database, no network. psycopg2.connect is replaced by a scripted FakeDb that imitates just
enough of the three prod databases -- including raising like Postgres when a query names a column
the schema does not have -- so collect.collect() runs end to end through its real SQL-building and
row-shaping code, once with the auto_replies column present and once with it missing (production
analytics is on an older schema).

Run from this directory:   python -m unittest -v test_auto_replies      (pytest also works)
"""
import copy
import datetime as dt
import json
import os
import re
import sys
import types
import unittest
from decimal import Decimal
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:
    import psycopg2  # noqa: F401
    import psycopg2.extras  # noqa: F401
except ImportError:  # collect.py exits without the driver; this suite must not need it
    _stub = types.ModuleType("psycopg2")
    _stub.extras = types.ModuleType("psycopg2.extras")
    _stub.extras.RealDictCursor = object
    _stub.connect = None
    sys.modules["psycopg2"], sys.modules["psycopg2.extras"] = _stub, _stub.extras

import collect  # noqa: E402
import render  # noqa: E402

ANALYTICS_DSN, USERS_DSN, CAMPAIGN_DSN = "fake://analytics", "fake://users", "fake://campaign"
REPORT_START = dt.date(2026, 11, 2)  # a Monday
LEGEND = ("Replies = people only; Auto-Replies = out-of-office, bounces and other automatic "
          "replies, counted once per message.")


def wk(i):
    """Monday i weeks before the report week (0 = the report week)."""
    return REPORT_START - dt.timedelta(days=7 * i)


# ---------------------------------------------------------------- fake databases

class FakePgError(Exception):
    """Stands in for psycopg2.errors.UndefinedColumn."""


class FakeDb:
    def __init__(self, snapshots, has_auto_replies):
        self.snapshots = snapshots
        self.has_auto_replies = has_auto_replies
        self.snapshot_sql = []  # every metrics query sent to the analytics DB
        self.probe_dsns = []    # the DSN each information_schema probe went to

    def connect(self, dsn):
        return FakeConn(self, dsn)

    def run(self, dsn, sql, params):
        s = " ".join(sql.split())
        if s.upper().startswith("SET TIME ZONE"):
            return []
        if "information_schema.columns" in s:
            self.probe_dsns.append(dsn)
            found = (dsn == ANALYTICS_DSN and self.has_auto_replies
                     and tuple(params) == ("public", "daily_analytics_snapshots", "auto_replies"))
            return [(1,)] if found else []
        if "FROM public.daily_analytics_snapshots" in s and "GROUP BY 1, 2" in s:  # table-level day coverage
            days = (params["end"] - params["start"]).days
            return [(collect.monday_of(d), d)
                    for d in (params["start"] + dt.timedelta(days=n) for n in range(days))]
        if "FROM public.daily_analytics_snapshots" in s:  # the metrics query
            self.snapshot_sql.append(sql)
            if re.search(r"\bauto_replies\b", sql) and not self.has_auto_replies:
                raise FakePgError('column "auto_replies" does not exist')
            # a real SELECT returns exactly the columns it names: one dict key per "AS <alias>"
            aliases = [a for a in re.findall(r"\bAS\s+(\w+)", sql) if a not in ("wk", "days")]
            rows = []
            for (pid, cid), by_week in self.snapshots.items():
                for monday, vals in by_week.items():
                    if not (params["start"] <= monday < params["end"]):
                        continue
                    row = {"parent_user_id": pid, "campaign_id": cid, "wk": monday, "days": 7}
                    row.update({a: Decimal(vals.get(a, 0)) for a in aliases})  # SUM(bigint) -> Decimal
                    rows.append(row)
            return rows
        if "FROM accounts" in s:
            return [{"parent_user_id": 1, "name": "Acme"}, {"parent_user_id": 2, "name": "Bravo"},
                    {"parent_user_id": 3, "name": "Charlie"}]
        if "FROM automation_campaigns" in s:
            return [{"parent_user_id": 1, "id": 10, "name": "Q4 Outbound", "is_active": True},
                    {"parent_user_id": 1, "id": 11, "name": "SMS Nudge", "is_active": True},
                    {"parent_user_id": 2, "id": 20, "name": "Bravo Main", "is_active": True}]
        if "FROM deals" in s:
            return [(1, 40), (2, 25)]
        raise AssertionError(f"FakeDb: unexpected SQL {s[:90]!r}")


class FakeConn:
    def __init__(self, db, dsn):
        self.db, self.dsn = db, dsn

    def set_session(self, **kwargs):
        pass

    def cursor(self, cursor_factory=None):
        return FakeCursor(self)

    def close(self):
        pass


class FakeCursor:
    def __init__(self, conn):
        self.conn, self.rows = conn, []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.rows = self.conn.db.run(self.conn.dsn, sql, params)

    def fetchall(self):
        return list(self.rows)

    def fetchone(self):
        return self.rows[0] if self.rows else None


def snapshots():
    """Acme: two campaigns, steady sends/replies, auto-replies 7 this week vs 2/4/6/8 before.
    Bravo: steady, but auto-replies fall from 10/week to 0 (must NOT be flagged). Charlie: no rows."""
    s = {}

    def put(pid, cid, i, **vals):
        s.setdefault((pid, cid), {})[wk(i)] = vals

    for i, (a10, a11) in {0: (4, 3), 1: (2, 0), 2: (4, 0), 3: (6, 0), 4: (8, 0),
                          5: (1, 0), 6: (1, 0), 7: (1, 0)}.items():
        put(1, 10, i, messages_sent=100, replies_received=6, auto_replies=a10)
        put(1, 11, i, messages_sent=50, replies_received=4, auto_replies=a11)
    for i in range(8):
        put(2, 20, i, messages_sent=100, replies_received=10, auto_replies=0 if i == 0 else 10)
    return s


def run_collect(has_auto_replies):
    db = FakeDb(snapshots(), has_auto_replies)
    with mock.patch.object(collect.psycopg2, "connect", side_effect=db.connect):
        doc = collect.collect(ANALYTICS_DSN, USERS_DSN, CAMPAIGN_DSN, REPORT_START, "t")
    return doc, db


def client(doc, name):
    return next(c for c in doc["clients"] if c["name"] == name)


def need_metric(c, key):
    m = next((m for m in c.get("metrics", []) if m["key"] == key), None)
    if m is None:
        raise AssertionError(f"client {c['name']!r} has no {key!r} metric")
    return m


def strip_auto(doc):
    """The run JSON with every Auto-Replies field removed."""
    d = copy.deepcopy(doc)
    d.pop("auto_replies_available", None)
    for c in d["clients"]:
        c["metrics"] = [m for m in c["metrics"] if m["key"] != "auto_replies"]
        if c.get("series"):
            c["series"]["data"].pop("auto_replies", None)
        for camp in c.get("campaigns", []):
            camp.pop("auto_replies", None)
    return d


# ---------------------------------------------------------------- collect.py

class SqlBuilderTests(unittest.TestCase):
    def test_default_query_is_the_pre_change_query(self):
        self.assertNotIn("auto_replies", collect.build_metrics_sql())

    def test_asking_for_auto_replies_adds_exactly_one_summed_column(self):
        without = collect.build_metrics_sql(include_auto_replies=False)
        with_ar = collect.build_metrics_sql(include_auto_replies=True)
        self.assertIn("COALESCE(SUM(auto_replies),0) AS auto_replies", with_ar)
        self.assertEqual(re.sub(r"\n\s+COALESCE\(SUM\(auto_replies\),0\) AS auto_replies,", "", with_ar), without)
        for clause in ("FROM public.daily_analytics_snapshots", "WHERE date >= %(start)s AND date < %(end)s",
                       "GROUP BY parent_user_id, campaign_id, date_trunc('week', date)"):
            self.assertIn(clause, with_ar)


class CollectColumnPresentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc, cls.db = run_collect(True)

    def test_tenant_value_baseline_and_delta(self):
        m = need_metric(client(self.doc, "Acme"), "auto_replies")
        self.assertEqual(m["label"], "Auto-Replies")
        self.assertEqual((m["value"], m["baseline"], m["delta_pct"]), (7, 5.0, "+40%"))
        self.assertIsInstance(m["value"], int)
        self.assertEqual((m["flagged"], m["direction"]), (False, "neutral"))

    def test_sits_right_after_replies_received(self):
        keys = [m["key"] for m in client(self.doc, "Acme")["metrics"]]
        self.assertIn("auto_replies", keys)
        self.assertEqual(keys.index("auto_replies"), keys.index("replies_received") + 1)

    def test_people_replies_are_not_inflated(self):
        self.assertEqual(need_metric(client(self.doc, "Acme"), "replies_received")["value"], 10)

    def test_per_campaign_and_trend_series(self):
        acme = client(self.doc, "Acme")
        self.assertEqual({c["id"]: c.get("auto_replies") for c in acme["campaigns"]}, {10: 4, 11: 3})
        self.assertEqual(acme["series"]["data"].get("auto_replies"), [1, 1, 1, 8, 6, 4, 2, 7])
        self.assertEqual(client(self.doc, "Charlie")["series"]["data"].get("auto_replies"), [0] * 8)

    def test_same_single_query_window_and_grouping_as_replies(self):
        self.assertEqual(len(self.db.snapshot_sql), 1)
        sql = self.db.snapshot_sql[0]
        self.assertIn("AS replies_received,", sql)
        self.assertIn("AS auto_replies", sql)
        self.assertIn("GROUP BY parent_user_id, campaign_id, date_trunc('week', date)", sql)

    def test_probe_goes_to_the_analytics_database_only(self):
        self.assertEqual(self.db.probe_dsns, [ANALYTICS_DSN])
        self.assertIs(self.doc.get("auto_replies_available"), True)

    def test_neutral_never_flagged_even_when_it_falls_to_zero(self):
        bravo = need_metric(client(self.doc, "Bravo"), "auto_replies")
        self.assertEqual((bravo["value"], bravo["baseline"], bravo["flagged"]), (0, 10.0, False))
        for c in self.doc["clients"]:
            self.assertEqual(c["flags"], [], c["name"])


class CollectColumnMissingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc, cls.db = run_collect(False)  # a query naming auto_replies would raise, like prod

    def test_reports_na_not_zero(self):
        self.assertIs(self.doc.get("auto_replies_available"), False)
        for name in ("Acme", "Bravo"):
            m = need_metric(client(self.doc, name), "auto_replies")
            self.assertEqual((m["value"], m["baseline"], m["delta_pct"], m["flagged"]), (None, None, None, False), name)

    def test_never_sends_the_missing_column(self):
        self.assertEqual(len(self.db.snapshot_sql), 1)
        self.assertNotIn("auto_replies", self.db.snapshot_sql[0])

    def test_series_and_campaigns_are_na(self):
        acme = client(self.doc, "Acme")
        self.assertIn("auto_replies", acme["series"]["data"])
        self.assertIsNone(acme["series"]["data"]["auto_replies"])
        self.assertTrue(acme["campaigns"])
        for camp in acme["campaigns"]:
            self.assertIn("auto_replies", camp)
            self.assertIsNone(camp["auto_replies"])
        self.assertIsNone(client(self.doc, "Charlie")["series"]["data"].get("auto_replies", "absent"))

    def test_everything_else_is_identical_with_or_without_the_column(self):
        present, _ = run_collect(True)
        self.assertEqual(strip_auto(present), strip_auto(self.doc))


# ---------------------------------------------------------------- render.py

def mini_doc(available=True):
    """One active client in run-JSON shape; Auto-Replies fields are null when the column was missing."""
    n = (lambda v: v) if available else (lambda v: None)

    def metric(key, label, value, baseline, delta, direction="down", email=None, sms=None):
        return {"key": key, "label": label, "value": value, "baseline": baseline, "delta_pct": delta,
                "flagged": False, "direction": direction, "email": email, "sms": sms}

    c = {
        "name": "Acme", "parent_user_id": 1, "status": "active", "note": None, "has_active_campaign": True,
        "open_deals": 40, "real_client": True, "flags": [],
        "metrics": [
            metric("messages_sent", "Messages sent", 150, 150.0, "+0%", email=100, sms=50),
            metric("replies_received", "Replies received", 10, 10.0, "+0%", email=8, sms=2),
            metric("auto_replies", "Auto-Replies", n(7), n(5.0), n("+40%"), direction="neutral"),
        ],
        "funnel": {"sent": 150, "clicked": 3, "booked": 1, "completed": 0},
        "derived": {"actions_performed": 150, "hours_saved": "7.5 (default weights)"},
        "campaigns": [{"id": 10, "name": "Q4 Outbound", "is_active": True, "sent": 100, "replies": 6,
                       "auto_replies": n(4), "positive": 2, "negative": 0, "clicked": 3, "booked": 1,
                       "won": 0, "revenue": 0}],
        "series": {"weeks": ["Sep 14", "Sep 21", "Sep 28", "Oct 5", "Oct 12", "Oct 19", "Oct 26", "Nov 2"],
                   "data": {"messages_sent": [150] * 8, "replies_received": [10] * 8,
                            "positive_sentiment": [3] * 8, "meetings_booked": [1] * 8,
                            "revenue_generated": [0] * 8,
                            "auto_replies": [1, 1, 1, 8, 6, 4, 2, 7] if available else None}},
        "completeness": {"days_present": 7, "days_expected": 7, "warning": None},
    }
    return {"title": "T", "week_label": "Oct 26 - Nov 1, 2026", "week_start": "2026-10-26",
            "week_end": "2026-11-01", "auto_replies_available": available,
            "summary": {"clients_total": 1, "clients_active": 1, "clients_flagged": 0,
                        "clients_paused": 0, "clients_inactive": 0},
            "clients": [c], "method": "m"}


def has(test, html, needle):
    test.assertTrue(needle in html, f"missing from the report: {needle!r}")


def legend_of(html):
    m = re.search(r'<p class="lead legend">(.*?)</p>', html, re.S)
    return m.group(1) if m else None


class RenderPresentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = render.render(mini_doc(True))

    def test_metric_row_follows_replies_in_the_same_format(self):
        has(self, self.html, "<td>Replies received</td>")
        m = re.search(r"<td>Replies received</td>.*?</tr><tr><td>Auto-Replies</td>(.*?)</tr>", self.html, re.S)
        self.assertIsNotNone(m, "Auto-Replies row does not directly follow Replies received")
        self.assertIn('<td class="num strong">7</td>', m.group(1))
        self.assertIn(">5</td>", m.group(1))
        self.assertIn("+40%</td>", m.group(1))

    def test_trend_card_after_replies(self):
        has(self, self.html, '<div class="tlbl">Auto-Replies</div>')
        i = lambda s: self.html.index(s)  # noqa: E731
        self.assertLess(i('<div class="tlbl">Replies</div>'), i('<div class="tlbl">Auto-Replies</div>'))
        self.assertLess(i('<div class="tlbl">Auto-Replies</div>'), i('<div class="tlbl">Positive</div>'))

    def test_campaign_table_column_after_replies(self):
        has(self, self.html, '<th class="num">Repl</th><th class="num" title="Auto-Replies">Auto</th><th class="num">Pos</th>')
        has(self, self.html, '<td class="num">6</td><td class="num">4</td><td class="num">2</td>')

    def test_legend_note_verbatim_and_no_na_explanation(self):
        text = legend_of(self.html)
        self.assertIsNotNone(text, "no legend paragraph")
        self.assertIn(LEGEND, text)
        self.assertNotIn("n/a", text)


class RenderUnavailableTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = render.render(mini_doc(False))

    def test_metric_row_is_na_never_zero(self):
        m = re.search(r"<tr><td>Auto-Replies</td>(.*?)</tr>", self.html, re.S)
        self.assertIsNotNone(m, "no Auto-Replies row")
        self.assertEqual(m.group(1).count("n/a"), 3)
        self.assertNotIn("strong", m.group(1))

    def test_trend_card_and_campaign_cell_are_na(self):
        has(self, self.html, '<div class="tcard"><div class="tlbl">Auto-Replies</div><div class="tval muted">n/a</div></div>')
        has(self, self.html, '<td class="num">6</td><td class="num muted">n/a</td><td class="num">2</td>')

    def test_legend_explains_the_na(self):
        text = legend_of(self.html)
        self.assertIsNotNone(text, "no legend paragraph")
        self.assertIn(LEGEND, text)
        self.assertIn("n/a", text)
        self.assertIn("auto_replies column", text)


class RenderBackwardCompatTests(unittest.TestCase):
    def test_run_json_from_before_the_metric_renders_without_it(self):
        html = render.render(strip_auto(mini_doc(True)))
        for needle in ("Auto-Replies", ">Auto</th>", "legend"):
            self.assertNotIn(needle, html)

    def test_sample_fixture_exercises_the_metric_and_is_deterministic(self):
        with open(os.path.join(HERE, "sample.json"), encoding="utf-8") as f:
            sample = json.load(f)
        html = render.render(sample)
        self.assertEqual(html, render.render(copy.deepcopy(sample)))
        text = legend_of(html)
        self.assertIsNotNone(text, "sample.json report has no legend")
        self.assertIn(LEGEND, text)
        with_metrics = [c for c in sample["clients"] if c.get("metrics")]
        self.assertTrue(with_metrics)
        for c in with_metrics:
            keys = [m["key"] for m in c["metrics"]]
            self.assertEqual(keys.index("auto_replies"), keys.index("replies_received") + 1, c["name"])


if __name__ == "__main__":
    unittest.main()
