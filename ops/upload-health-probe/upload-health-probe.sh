#!/usr/bin/env bash
# Active round-trip probe for cloud-documents-service: upload a file, then FETCH IT BACK.
#
# Why an active probe and not a heartbeat entry:
# periodic-job-heartbeat.sh watches for a recurring LOG MARKER emitted by a periodic background job
# ("retention sweep removed", "siteforge-dispatcher", ...). cloud-documents is a request-serving HTTP
# service with no periodic job, so it emits no such marker — an entry in that JOBS array would either
# never fire or always alarm. It needs a probe that generates its own traffic.
#
# Why the FETCH is the point:
# After the 2026-09 move from Cloudinary to S3, the dangerous failures are silent on the READ side.
# Public read is granted by a BUCKET POLICY, not per-object ACLs (the buckets are
# ObjectOwnership=BucketOwnerEnforced, which rejects ACLs outright). So if someone re-enables Block
# Public Access, edits the policy, or rotates the IAM key, uploads keep returning 200 while every
# stored URL 403s for the reader. A write-only check would stay green through all of it and reproduce
# exactly the blind spot this exists to close.
#
# This is the same failure shape as the 2026-06 mailbox-watch lapse: the health flag kept saying
# connected while the thing it measured had stopped working. Hence: fail loud.
#
# Install: see README.md. Env: /etc/revhero/upload-health-probe.env
set -uo pipefail

ENV_FILE=/etc/revhero/upload-health-probe.env
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

BASE="${CLOUD_DOCS_BASE:-https://cloud-documents-service.revhero.io}"
PROVIDER="${UPLOAD_PROVIDER:-aws}"
FOLDER="${UPLOAD_FOLDER:-health-probe}"
TAG=upload-health-probe
fail=0

note() { echo "[$TAG] $*"; }

alert() {
  note "FAIL: $*"
  if [ -n "${SLACK_WEBHOOK_DEPLOYS:-}" ]; then
    curl -s -m 15 -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\":rotating_light: *upload-health-probe* — $1\"}" \
      "$SLACK_WEBHOOK_DEPLOYS" >/dev/null || true
  fi
  fail=1
}

TMP="$(mktemp -t uploadprobe.XXXXXX)" || { note "mktemp failed"; exit 1; }
trap 'rm -f "$TMP" "$TMP.out"' EXIT

# A unique body, so a stale/cached object cannot pass for a fresh one.
STAMP="upload-health-probe $(date -u +%Y-%m-%dT%H:%M:%SZ) $$-$RANDOM"
printf '%s\n' "$STAMP" > "$TMP"

# ---- 1. upload -------------------------------------------------------------
HTTP=$(curl -s -m 60 -o "$TMP.out" -w '%{http_code}' \
  -X POST "$BASE/v1/upload/" \
  -F "provider=$PROVIDER" \
  -F "folder=$FOLDER" \
  -F "file=@$TMP;filename=probe-$(date +%s).txt" 2>/dev/null)

if [ "$HTTP" != "200" ] && [ "$HTTP" != "201" ]; then
  alert "upload returned HTTP $HTTP (base=$BASE provider=$PROVIDER). Body: $(head -c 300 "$TMP.out" 2>/dev/null | tr -d '\n')"
  exit $fail
fi

URL=$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP.out" | head -1)
if [ -z "$URL" ]; then
  alert "upload succeeded but no url in the response: $(head -c 300 "$TMP.out" | tr -d '\n')"
  exit $fail
fi
note "uploaded: $URL"

# The provider is meant to be S3 now. A Cloudinary URL here means something still routes there.
case "$URL" in
  *cloudinary*) alert "upload returned a CLOUDINARY url after the S3 cutover: $URL" ;;
esac

# ---- 2. fetch it back ANONYMOUSLY — the assertion that actually matters -----
GET_HTTP=$(curl -s -m 45 -o "$TMP.get" -w '%{http_code}' "$URL" 2>/dev/null)
if [ "$GET_HTTP" != "200" ]; then
  alert "uploaded OK but the object is NOT publicly readable: GET $URL -> $GET_HTTP. \
Bucket policy or Block Public Access changed, or the key is wrong. Uploads will keep succeeding \
while every stored link is dead for the reader."
  rm -f "$TMP.get"
  exit $fail
fi

if ! grep -qF "$STAMP" "$TMP.get" 2>/dev/null; then
  alert "fetched $URL but the content did not match what was uploaded (stale object or wrong key)"
fi
rm -f "$TMP.get"

[ "$fail" -eq 0 ] && note "OK — upload + public fetch round trip healthy"
exit $fail
