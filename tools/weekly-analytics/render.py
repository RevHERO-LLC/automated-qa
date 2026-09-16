#!/usr/bin/env python3
"""
Generator for the Weekly Analytics client-health digest (internal).

Pure function: reads a data JSON (see schema.json), writes a self-contained,
theme-aware HTML document to stdout. DETERMINISTIC: same data in => byte-identical
HTML out. No external fetches, NO render-time clock (the week label + all dates
come from the DATA, never datetime.now()) — keep runs/ append-only + comparable.

Usage:
  python render.py runs/<week>.json > out.html
  python render.py runs/<week>.json runs/<prev-week>.json > out.html   # diff mode

The FORMAT is frozen here; only the DATA varies per run (the /report convention).
"""
import json
import sys
import html


def esc(s):
    return html.escape(str(s if s is not None else ""))


def _num(v):
    """Format a metric value: ints plain, floats/revenue with separators."""
    if v is None:
        return "—"
    if isinstance(v, float) and not v.is_integer():
        return f"{v:,.1f}"
    try:
        return f"{int(v):,}"
    except (ValueError, TypeError):
        return esc(v)


STATUS_BADGE = {
    "active": ("ok", "Active"),
    "dropped_to_zero": ("bad", "Dropped to zero"),
    "new": ("neutral", "New — no baseline"),
    "no_data": ("neutral", "No data"),
    "dormant": ("neutral", "Dormant"),
    "paused": ("neutral", "Paused"),
    "inactive": ("neutral", "Inactive"),
    "error": ("bad", "Error"),
}

SERIES_LABELS = [("messages_sent", "Sent"), ("replies_received", "Replies"),
                 ("positive_sentiment", "Positive"), ("meetings_booked", "Booked"),
                 ("revenue_generated", "Revenue")]


def _delta_cell(m):
    """Render the delta% cell with tone. direction 'down'/'up' + flagged drive color."""
    pct = m.get("delta_pct")
    if pct in (None, ""):
        return '<td class="num muted">—</td>'
    tone = ""
    if m.get("flagged"):
        tone = "red-t"  # a flag is always the bad direction by construction
    return f'<td class="num {tone}">{esc(pct)}</td>'


def _metric_row(m):
    flag = ' class="flagged"' if m.get("flagged") else ""
    mark = ' <span class="flagmark">▲</span>' if m.get("flagged") else ""
    email = m.get("email")
    sms = m.get("sms")
    split = ""
    if email is not None or sms is not None:
        split = f'<span class="split">e {_num(email)} · s {_num(sms)}</span>'
    return (
        f"<tr{flag}><td>{esc(m.get('label'))}{mark}</td>"
        f'<td class="num strong">{_num(m.get("value"))}{split}</td>'
        f'<td class="num muted">{_num(m.get("baseline"))}</td>'
        f"{_delta_cell(m)}</tr>"
    )


def _funnel(f):
    if not f:
        return ""
    steps = [("Sent", f.get("sent")), ("Clicked", f.get("clicked")),
             ("Booked", f.get("booked")), ("Completed", f.get("completed"))]
    cells = "".join(
        f'<div class="fstep"><div class="fv">{_num(v)}</div><div class="fl">{esc(lbl)}</div></div>'
        + ('<div class="farrow">&rarr;</div>' if i < len(steps) - 1 else "")
        for i, (lbl, v) in enumerate(steps)
    )
    return f'<div class="funnel">{cells}</div>'


def _flag_list(flags):
    if not flags:
        return ""
    items = "".join(
        f'<li class="{ "critical" if fl.get("severity")=="critical" else "warn" }">'
        f'<b>{esc(fl.get("metric"))}</b> '
        f'{"&darr;" if fl.get("direction")=="down" else "&uarr;"} '
        f'{esc(fl.get("pct"))} '
        f'<span class="muted">({_num(fl.get("this_week"))} vs {_num(fl.get("baseline"))} avg)</span></li>'
        for fl in flags
    )
    return f'<ul class="flags">{items}</ul>'


def _derived(dv):
    if not dv:
        return ""
    ap = dv.get("actions_performed")
    hs = dv.get("hours_saved")
    bits = []
    if ap is not None:
        bits.append(f'<span class="chip">Actions performed: <b>{_num(ap)}</b></span>')
    if hs is not None:
        bits.append(f'<span class="chip">Hours saved: <b>{esc(hs)}</b></span>')
    return f'<div class="chips">{"".join(bits)}</div>' if bits else ""


def _sparkline(values, color):
    """Deterministic inline SVG sparkline. Rounded coords -> byte-stable output."""
    vals = [float(v) if isinstance(v, (int, float)) else 0.0 for v in (values or [])]
    if not vals:
        return ""
    w, h, pad = 132, 30, 4
    n = len(vals)
    vmax, vmin = max(vals), min(vals)
    span = (vmax - vmin) or 1.0

    def x(i):
        return pad + (w - 2 * pad) * (i / (n - 1) if n > 1 else 0.5)

    def y(v):
        return h - pad - (h - 2 * pad) * ((v - vmin) / span)

    pts = " ".join(f"{x(i):.1f},{y(v):.1f}" for i, v in enumerate(vals))
    lx, ly = x(n - 1), y(vals[-1])
    return (f'<svg class="spark" viewBox="0 0 {w} {h}" preserveAspectRatio="none" aria-hidden="true">'
            f'<polyline fill="none" stroke="{color}" stroke-width="1.5" stroke-linejoin="round" '
            f'stroke-linecap="round" points="{pts}"/>'
            f'<circle cx="{lx:.1f}" cy="{ly:.1f}" r="2.2" fill="{color}"/></svg>')


def _trend_block(series):
    if not series or not series.get("weeks"):
        return ""
    data = series.get("data", {})
    cards = []
    for key, lbl in SERIES_LABELS:
        vals = data.get(key, [])
        last = vals[-1] if vals else 0
        trend = (vals[-1] - vals[0]) if len(vals) >= 2 else 0
        color = "var(--green)" if trend > 0 else ("var(--red)" if trend < 0 else "var(--muted)")
        cards.append(f'<div class="tcard"><div class="tlbl">{esc(lbl)}</div>'
                     f'{_sparkline(vals, color)}<div class="tval">{_num(last)}</div></div>')
    wk0, wkn = esc(series["weeks"][0]), esc(series["weeks"][-1])
    return (f'<div class="trend"><div class="trend-h">Trend · {wk0} → {wkn}</div>'
            f'<div class="tgrid">{"".join(cards)}</div></div>')


def _campaign_table(campaigns):
    real = [c for c in (campaigns or []) if c.get("sent") is not None]
    if not campaigns:
        return ""
    rows = []
    for c in campaigns:
        if c.get("sent") is None:  # the "+N more" fold row
            rows.append(f'<tr><td colspan="7" class="muted">{esc(c.get("name"))}</td></tr>')
            continue
        dot = '<span class="cdot on">●</span>' if c.get("is_active") else '<span class="cdot off">○</span>'
        rows.append(
            f'<tr><td>{dot} {esc(c.get("name"))}</td>'
            f'<td class="num">{_num(c.get("sent"))}</td><td class="num">{_num(c.get("replies"))}</td>'
            f'<td class="num">{_num(c.get("positive"))}</td><td class="num">{_num(c.get("booked"))}</td>'
            f'<td class="num">{_num(c.get("won"))}</td><td class="num">{_num(c.get("revenue"))}</td></tr>')
    return (f'<details class="campaigns"><summary>By campaign · {len(real)}</summary>'
            '<div class="tbl-wrap"><table><thead><tr><th>Campaign</th><th class="num">Sent</th>'
            '<th class="num">Repl</th><th class="num">Pos</th><th class="num">Book</th>'
            f'<th class="num">Won</th><th class="num">Rev</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div></details>')


def _client_card(c, newly_flagged=False, cleared=False):
    scls, slabel = STATUS_BADGE.get(c.get("status"), ("neutral", esc(c.get("status"))))
    flagged = bool(c.get("flags"))
    card_cls = "card client"
    if flagged or c.get("status") in ("dropped_to_zero", "error"):
        card_cls += " attention"
    comp = c.get("completeness") or {}
    comp_warn = ""
    if comp.get("warning"):
        comp_warn = f'<div class="datawarn">⚠ {esc(comp["warning"])}</div>'
    diff_badge = ""
    if newly_flagged:
        diff_badge = '<span class="badge bad diffb">newly flagged</span>'
    elif cleared:
        diff_badge = '<span class="badge ok diffb">cleared since last week</span>'

    rows = "".join(_metric_row(m) for m in c.get("metrics", []))
    body = ""
    if c.get("status") == "error":
        body = f'<div class="nodata errbody">⚠ {esc(c.get("note") or "Collection failed for this client — metrics unavailable this week.")}</div>'
    elif c.get("status") == "no_data":
        body = f'<div class="nodata">{esc(c.get("note") or "No activity recorded.")}</div>'
    else:
        table = (
            '<div class="tbl-wrap"><table><thead><tr><th>Metric</th>'
            '<th class="num">This week</th><th class="num">4-wk avg</th>'
            '<th class="num">&Delta;</th></tr></thead><tbody>'
            f"{rows}</tbody></table></div>"
        )
        body = (_flag_list(c.get("flags")) + comp_warn + table + _funnel(c.get("funnel"))
                + _derived(c.get("derived")) + _trend_block(c.get("series")) + _campaign_table(c.get("campaigns")))

    return f"""
      <div class="{card_cls}" id="client-{esc(c.get('parent_user_id'))}">
        <div class="card-head">
          <span class="cname">{esc(c.get('name'))}</span>
          <span class="badges"><span class="badge {scls}">{esc(slabel)}</span>{diff_badge}</span>
        </div>
        {body}
      </div>"""


def render(d, prev=None):
    s = d.get("summary", {})
    prev_flagged = set()
    if prev:
        prev_flagged = {c.get("parent_user_id") for c in prev.get("clients", []) if c.get("flags")}
    now_flagged = {c.get("parent_user_id") for c in d.get("clients", []) if c.get("flags")}

    clients = d.get("clients", [])
    # attention = flagged / dropped-to-zero / error, most-flags first (stable within by name)
    def _attn(c):
        return bool(c.get("flags")) or c.get("status") in ("dropped_to_zero", "error")
    attention = sorted([c for c in clients if _attn(c)],
                       key=lambda c: (-len(c.get("flags", [])), str(c.get("name", "")).lower()))
    healthy = sorted([c for c in clients if not _attn(c) and c.get("status") in ("active", "new")],
                     key=lambda c: str(c.get("name", "")).lower())
    paused = sorted([c for c in clients if c.get("status") == "paused"],
                    key=lambda c: -(c.get("open_deals") or 0))
    inactive = sorted([c for c in clients if c.get("status") in ("inactive", "no_data", "dormant")],
                      key=lambda c: str(c.get("name", "")).lower())

    attention_html = "".join(
        _client_card(c,
                     newly_flagged=(prev is not None and c.get("parent_user_id") in now_flagged and c.get("parent_user_id") not in prev_flagged),
                     cleared=False)
        for c in attention) or '<div class="allok">✅ No clients off-trend this week.</div>'

    healthy_html = "".join(
        _client_card(c,
                     cleared=(prev is not None and c.get("parent_user_id") not in now_flagged and c.get("parent_user_id") in prev_flagged))
        for c in healthy)

    def _mini_list(rows):
        return "".join(f"<li>{esc(c.get('name'))} <span class='muted'>{esc((c.get('note') or ''))}</span></li>" for c in rows)

    paused_html = ""
    if paused:
        prows = "".join(
            f'<tr><td>{esc(c.get("name"))}</td>'
            f'<td class="num">{_num(c.get("open_deals"))}</td>'
            f'<td>{esc(c.get("last_active") or "—")}</td>'
            f'<td>{"⚠ active, no sends" if c.get("has_active_campaign") else "off"}</td></tr>'
            for c in paused)
        paused_html = f"""
    <h2>Paused <span class="count">{len(paused)}</span></h2>
    <p class="lead">Real clients (open deals or a recent send) not sending this week — campaigns paused/quiet. Not flagged.</p>
    <div class="tbl-wrap"><table><thead><tr><th>Client</th><th class="num">Open deals</th><th>Last active</th><th>Campaigns</th></tr></thead><tbody>{prows}</tbody></table></div>"""

    inactive_html = ""
    if inactive:
        inactive_html = f"""
    <h2>Inactive / not launched <span class="count">{len(inactive)}</span></h2>
    <p class="lead">No open deals and no recent activity — test / never-launched accounts.</p>
    <details class="fold"><summary>Show {len(inactive)} inactive account(s)</summary>
    <ul class="nodata-list">{_mini_list(inactive)}</ul></details>"""

    diff_note = ""
    if prev:
        diff_note = f' · <span class="muted">diff vs {esc(prev.get("week_label",""))}</span>'

    alert_html = f'<div class="alert">{esc(d.get("alert"))}</div>' if d.get("alert") else ""

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(d.get('title', 'Weekly Analytics'))}</title>
<style>
:root{{--bg:#f7f8fa;--panel:#fff;--ink:#1a1d21;--muted:#5b6570;--line:#e3e7ec;
--red:#c0392b;--redbg:#fdecea;--redln:#f3c0b9;--green:#1e7e46;--greenbg:#e9f7ef;--greenln:#bce5cc;
--amber:#9a6b00;--amberbg:#fff5e0;--amberln:#f0d9a0;--accent:#2c5cc5;}}
@media (prefers-color-scheme:dark){{:root:not([data-theme=light]){{--bg:#0f1216;--panel:#171b21;--ink:#e7ebf0;--muted:#9aa4b0;--line:#262c34;
--red:#ff8a80;--redbg:#2a1614;--redln:#5a2a24;--green:#7ee2a8;--greenbg:#0f2318;--greenln:#1f4a30;
--amber:#f0c674;--amberbg:#2a2212;--amberln:#4a3a12;--accent:#8fb0ff;}}}}
:root[data-theme=dark]{{--bg:#0f1216;--panel:#171b21;--ink:#e7ebf0;--muted:#9aa4b0;--line:#262c34;--red:#ff8a80;--redbg:#2a1614;--redln:#5a2a24;--green:#7ee2a8;--greenbg:#0f2318;--greenln:#1f4a30;--amber:#f0c674;--amberbg:#2a2212;--amberln:#4a3a12;--accent:#8fb0ff;}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}}
.wrap{{max-width:1000px;margin:0 auto;padding:32px 20px 64px}}
h1{{font-size:26px;margin:0 0 4px}} .sub{{color:var(--muted);margin:0 0 20px}}
h2{{font-size:19px;margin:36px 0 6px}} h2 .count{{color:var(--muted);font-weight:500;font-size:15px}}
.lead{{color:var(--muted);margin:0 0 16px}}
.status{{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 24px}}
.badge{{padding:5px 11px;border-radius:999px;font-size:12.5px;font-weight:600;border:1px solid var(--line);white-space:nowrap}}
.badge.ok{{background:var(--greenbg);color:var(--green);border-color:var(--greenln)}}
.badge.bad{{background:var(--redbg);color:var(--red);border-color:var(--redln)}}
.badge.neutral{{background:color-mix(in srgb,var(--panel),var(--ink) 6%);color:var(--muted)}}
.diffb{{margin-left:6px}}
.card{{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin:0 0 14px;overflow:hidden}}
.card.attention{{border-color:var(--redln);border-left:4px solid var(--red)}}
.card-head{{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line)}}
.cname{{font-weight:700;font-size:15.5px}} .badges{{display:flex;align-items:center;flex-wrap:wrap;gap:4px}}
ul.flags{{list-style:none;padding:12px 16px 0;margin:0}}
ul.flags li{{padding:7px 11px;border-radius:8px;margin:0 0 7px;font-size:13.5px;border:1px solid var(--redln);background:var(--redbg);color:var(--red)}}
ul.flags li.critical{{font-weight:600}}
ul.flags li.warn{{border-color:var(--amberln);background:var(--amberbg);color:var(--amber)}}
.datawarn{{margin:10px 16px 0;padding:7px 11px;border-radius:8px;background:var(--amberbg);color:var(--amber);border:1px solid var(--amberln);font-size:13px}}
.tbl-wrap{{overflow-x:auto;padding:12px 16px 4px}}
table{{width:100%;border-collapse:collapse;font-size:13.5px}}
th,td{{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}}
th{{font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted)}}
th.num,td.num{{text-align:right;font-variant-numeric:tabular-nums}}
tr:last-child td{{border-bottom:none}}
td.strong{{font-weight:700}} .muted{{color:var(--muted)}} .red-t{{color:var(--red);font-weight:600}}
tr.flagged td{{background:var(--redbg)}} tr.flagged td:first-child{{color:var(--red);font-weight:600}}
.flagmark{{color:var(--red);font-size:11px;vertical-align:middle}}
.split{{display:block;font-size:11px;color:var(--muted);font-weight:400}}
.funnel{{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:12px 16px 14px;border-top:1px solid var(--line);margin-top:4px}}
.fstep{{text-align:center;min-width:64px}} .fstep .fv{{font-size:17px;font-weight:700}} .fstep .fl{{font-size:11px;color:var(--muted)}}
.farrow{{color:var(--muted)}}
.chips{{display:flex;gap:8px;flex-wrap:wrap;padding:0 16px 14px}}
.chip{{font-size:12.5px;color:var(--muted);background:color-mix(in srgb,var(--panel),var(--ink) 4%);border:1px solid var(--line);border-radius:999px;padding:4px 10px}}
.nodata{{padding:14px 16px;color:var(--muted)}}
.errbody{{color:var(--red);font-weight:600}}
ul.nodata-list{{list-style:none;padding:0;margin:0;columns:2;gap:16px}}
ul.nodata-list li{{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:0 0 8px;font-size:13.5px;break-inside:avoid}}
.allok{{background:var(--greenbg);border:1px solid var(--greenln);color:var(--green);border-radius:12px;padding:16px 18px;font-weight:600}}
.alert{{background:var(--redbg);border:1px solid var(--redln);border-left:4px solid var(--red);color:var(--red);border-radius:10px;padding:13px 16px;margin:0 0 20px;font-size:14px;font-weight:600}}
.method{{color:var(--muted);font-size:12.5px;border-top:1px solid var(--line);margin-top:40px;padding-top:14px}}
.trend{{border-top:1px solid var(--line);padding:12px 16px 14px}}
.trend-h{{font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);margin-bottom:8px}}
.tgrid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}}
.tcard{{background:color-mix(in srgb,var(--panel),var(--ink) 3%);border:1px solid var(--line);border-radius:8px;padding:8px 10px}}
.tlbl{{font-size:11px;color:var(--muted)}} .tval{{font-size:15px;font-weight:700;margin-top:2px}}
svg.spark{{display:block;width:100%;height:30px;margin:3px 0}}
details.campaigns,details.fold{{border-top:1px solid var(--line)}}
details.campaigns summary,details.fold summary{{cursor:pointer;padding:11px 16px;font-weight:600;font-size:13.5px;color:var(--accent)}}
details.campaigns .tbl-wrap{{padding-top:0}}
.cdot{{font-size:10px;vertical-align:middle}} .cdot.on{{color:var(--green)}} .cdot.off{{color:var(--muted)}}
details.fold ul.nodata-list{{padding:0 4px}}
@media(max-width:640px){{ul.nodata-list{{columns:1}}}}
</style></head><body><div class="wrap">
<h1>{esc(d.get('title', 'Weekly Analytics'))}</h1>
<p class="sub">Week of {esc(d.get('week_label'))}{diff_note}</p>
<div class="status">
  <span class="badge neutral">{_num(s.get('clients_active'))} active senders</span>
  <span class="badge bad">{_num(s.get('clients_flagged'))} off-trend</span>
  <span class="badge neutral">{_num(s.get('clients_paused'))} paused</span>
  <span class="badge neutral">{_num(s.get('clients_inactive'))} inactive</span>
</div>
{alert_html}
<h2>Needs attention <span class="count">{len(attention)}</span></h2>
<p class="lead">Clients whose metrics moved off their 4-week trend (or dropped to zero). Reds first.</p>
{attention_html}

<h2>Active senders <span class="count">{len(healthy)}</span></h2>
{healthy_html}
{paused_html}
{inactive_html}

<div class="method">{esc(d.get('method'))}</div>
</div>
</body></html>"""


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: render.py <data.json> [previous.json]")
    with open(sys.argv[1], encoding="utf-8") as f:
        data = json.load(f)
    prev = None
    if len(sys.argv) >= 3:
        with open(sys.argv[2], encoding="utf-8") as f:
            prev = json.load(f)
    # newline="\n" disables Windows CRLF translation so output is byte-identical
    # on any OS (Windows dev == Linux GHA runner) — the determinism guarantee.
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stdout.write(render(data, prev))


if __name__ == "__main__":
    main()
