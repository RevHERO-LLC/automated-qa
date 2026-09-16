#!/usr/bin/env python3
"""
Slack poster for the weekly-analytics client-health digest.

Uploads the rendered HTML report via Slack's modern external-upload flow
(files.getUploadURLExternal -> HTTP POST the bytes -> files.completeUploadExternal),
then posts a Block Kit summary of the red-flagged clients via chat.postMessage.
The legacy files.upload is deprecated and intentionally NOT used.

Secrets are read from the environment, NEVER hard-coded:
  SLACK_ANALYTICS_BOT_TOKEN  (xoxb-...; bot needs files:write + chat:write)
  SLACK_ANALYTICS_CHANNEL    (channel id, e.g. C0C2YB9SDB2) — or --channel

The bot MUST be a member of the target channel or the post fails 'not_in_channel'
(the token lacks channels:read, so membership can't be pre-verified via API).

Exit code is non-zero on any failure so the GHA workflow can catch it and fire the
fallback text alert to SLACK_WEBHOOK_DEPLOYS.

Usage:
  SLACK_ANALYTICS_BOT_TOKEN=xoxb-... python post_slack.py --data runs/x.json --html out.html --channel C0C2YB9SDB2
  python post_slack.py --data runs/x.json --html out.html --channel C0C2YB9SDB2 --dry-run
"""
import argparse
import json
import os
import sys

try:
    import requests
except ImportError:
    sys.exit("post_slack.py requires requests (pip install requests)")

API = "https://slack.com/api"
MAX_FLAG_BLOCKS = 18  # cap client sections (Block Kit hard limit is 50 blocks/message)


class SlackError(RuntimeError):
    pass


def _call(method, token, *, data=None, json_body=None):
    headers = {"Authorization": f"Bearer {token}"}
    if json_body is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
        r = requests.post(f"{API}/{method}", headers=headers, data=json.dumps(json_body), timeout=30)
    else:
        r = requests.post(f"{API}/{method}", headers=headers, data=data, timeout=30)
    try:
        j = r.json()
    except ValueError:
        raise SlackError(f"{method}: non-JSON response (HTTP {r.status_code})")
    if not j.get("ok"):
        raise SlackError(f"{method}: {j.get('error', 'unknown_error')}")
    return j


def _arrow(direction):
    return "⬇" if direction == "down" else "⬆"


def build_blocks(d):
    """Block Kit summary: header, KPI fields, optional alert, flagged clients, footer."""
    s = d.get("summary", {})
    blocks = [
        {"type": "header",
         "text": {"type": "plain_text", "text": f"📊 Weekly Analytics — {d.get('week_label', '')}"[:150]}},
        {"type": "section", "fields": [
            {"type": "mrkdwn", "text": f"*Active clients:*\n{s.get('clients_active', 0)}"},
            {"type": "mrkdwn", "text": f"*Off-trend:*\n{s.get('clients_flagged', 0)}"},
            {"type": "mrkdwn", "text": f"*No data:*\n{s.get('clients_no_data', 0)}"},
        ]},
    ]

    if d.get("alert"):
        blocks.append({"type": "section",
                       "text": {"type": "mrkdwn", "text": f":warning: {d['alert']}"[:3000]}})

    flagged = [c for c in d.get("clients", []) if c.get("flags")]
    if flagged:
        blocks.append({"type": "divider"})
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": "*Needs attention*"}})
        for c in flagged[:MAX_FLAG_BLOCKS]:
            worst = ", ".join(f"{_arrow(f.get('direction'))} {f.get('pct')} {f.get('metric', '').lower()}"
                              for f in c.get("flags", [])[:4])
            blocks.append({"type": "section",
                           "text": {"type": "mrkdwn", "text": f"• *{c.get('name')}* — {worst}"[:3000]}})
        if len(flagged) > MAX_FLAG_BLOCKS:
            blocks.append({"type": "context", "elements": [
                {"type": "mrkdwn", "text": f"…and {len(flagged) - MAX_FLAG_BLOCKS} more flagged — see the attached report."}]})
    elif d.get("alert"):
        blocks.append({"type": "section",
                       "text": {"type": "mrkdwn", "text": "Red flags suppressed this week — see the notice above."}})
    else:
        blocks.append({"type": "section",
                       "text": {"type": "mrkdwn", "text": "✅ No clients off-trend this week."}})

    blocks.append({"type": "context", "elements": [
        {"type": "mrkdwn", "text": "Full client-by-client HTML report attached above. :point_up_2:"}]})
    return blocks


def fallback_text(d):
    s = d.get("summary", {})
    return (f"Weekly Analytics — {d.get('week_label', '')}: "
            f"{s.get('clients_flagged', 0)} client(s) off-trend, "
            f"{s.get('clients_active', 0)} active, {s.get('clients_no_data', 0)} no data.")


def upload_html(token, channel, html_bytes, filename, title):
    up = _call("files.getUploadURLExternal", token,
               data={"filename": filename, "length": str(len(html_bytes))})
    upload_url, file_id = up["upload_url"], up["file_id"]
    r = requests.post(upload_url, files={"file": (filename, html_bytes, "text/html")}, timeout=60)
    r.raise_for_status()
    _call("files.completeUploadExternal", token,
          data={"files": json.dumps([{"id": file_id, "title": title}]), "channel_id": channel})
    return file_id


def main():
    ap = argparse.ArgumentParser(description="Post the weekly-analytics digest to Slack.")
    ap.add_argument("--data", required=True, help="Path to the run data JSON (schema.json shape).")
    ap.add_argument("--html", required=True, help="Path to the rendered HTML report.")
    ap.add_argument("--channel", default=os.environ.get("SLACK_ANALYTICS_CHANNEL"),
                    help="Slack channel id (or env SLACK_ANALYTICS_CHANNEL).")
    ap.add_argument("--token", default=os.environ.get("SLACK_ANALYTICS_BOT_TOKEN"),
                    help="Bot token (or env SLACK_ANALYTICS_BOT_TOKEN). Never commit this.")
    ap.add_argument("--dry-run", action="store_true", help="Build + print the payload; do NOT post.")
    args = ap.parse_args()

    # UTF-8 stdout so the dry-run print of emoji/em-dash works on any console (Windows cp1252 included).
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    with open(args.data, encoding="utf-8") as f:
        d = json.load(f)
    with open(args.html, "rb") as f:
        html_bytes = f.read()

    week = d.get("week_start", "report")
    filename = f"weekly-analytics-{week}.html"
    title = f"Weekly Analytics — {d.get('week_label', '')}"
    blocks = build_blocks(d)
    fb = fallback_text(d)

    if len(blocks) > 50:
        blocks = blocks[:49] + [{"type": "context", "elements": [
            {"type": "mrkdwn", "text": "(summary truncated — see the attached report)"}]}]

    if args.dry_run:
        print("=== DRY RUN — nothing posted ===")
        print(f"channel : {args.channel}")
        print(f"file    : {filename} ({len(html_bytes):,} bytes)  title={title!r}")
        print(f"token   : {'set' if args.token else 'MISSING'}")
        print(f"fallback: {fb}")
        print(f"blocks  : {len(blocks)}")
        print(json.dumps(blocks, indent=2, ensure_ascii=False))
        return

    if not args.token:
        sys.exit("ERROR: SLACK_ANALYTICS_BOT_TOKEN not set.")
    if not args.channel:
        sys.exit("ERROR: channel not set (SLACK_ANALYTICS_CHANNEL or --channel).")

    try:
        upload_html(args.token, args.channel, html_bytes, filename, title)
        _call("chat.postMessage", args.token, json_body={"channel": args.channel, "blocks": blocks, "text": fb})
    except (SlackError, requests.RequestException) as e:
        sys.exit(f"ERROR posting to Slack: {e}")
    print(f"Posted weekly-analytics report + summary to {args.channel}.")


if __name__ == "__main__":
    main()
