#!/usr/bin/env bash
# Red/green regression test for tier 3 (per-SHA stuck-roll detection, #940) in
# image-freshness-reconciler.sh.
#
# #940: tiers 1/2 only check that the RUNNING image matches the tag Swarm is
# ALREADY pinned to. Neither notices when the pin itself was never advanced
# (Dokploy's dockerImage sits on an old :env-<sha> forever — the "spec never
# told Dokploy" failure). Tier 3 compares the pinned tag's content against
# the branch HEAD it's supposed to track and reports (never heals) a mismatch.
#
# Self-contained: mocks docker/curl/jq on PATH, so it needs no swarm, no
# registry, no network, and no jq/real-docker installed on the box running
# the test. Two services:
#   stuck-svc  — pinned to staging-<OLD sha>; branch HEAD is <HEAD sha>
#                -> MUST be flagged SHA-STUCK + alerted exactly once.
#   fresh-svc  — pinned to staging-<the actual HEAD sha>
#                -> MUST NOT be flagged.
# Also asserts tier 3 never calls `docker service update` (DETECT-ONLY).
#
# Usage: ./test-sha-stuck-roll.sh   (exit 0 = all assertions passed)

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/image-freshness-reconciler.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

MOCKBIN="${WORK}/mockbin"
mkdir -p "${MOCKBIN}" "${WORK}/state"
export MOCK_SERVICES_FILE="${WORK}/services.txt"
export MOCK_HEAL_LOG="${WORK}/heal.log"
export MOCK_CURL_LOG="${WORK}/curl.log"
: > "${MOCK_HEAL_LOG}"
: > "${MOCK_CURL_LOG}"

OLD_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
HEAD_SHA="cccccccccccccccccccccccccccccccccccccccc"
cat > "${MOCK_SERVICES_FILE}" <<EOF
stuck-svc|ghcr.io/revhero-llc/revhero-fake-service:staging-${OLD_SHA}
fresh-svc|ghcr.io/revhero-llc/revhero-fake-service:staging-${HEAD_SHA}
EOF

# --- mock docker: handles every subcommand the reconciler calls -----------
# service ls/inspect/ps/update, image inspect/prune, bare inspect/pull/ps.
# tier 1 and tier 2 are kept deliberately QUIET here (same Created timestamp
# for every tag, no local container) so execution reaches the new tier 3 for
# both services — proving tier 3 fires independently of tiers 1/2.
cat > "${MOCKBIN}/docker" <<'MOCKDOCKER'
#!/usr/bin/env bash
case "$1" in
  service)
    case "$2" in
      ls) cat "${MOCK_SERVICES_FILE}"; exit 0 ;;
      inspect) echo ""; exit 0 ;;                # no update in progress
      ps) echo "task-$3"; exit 0 ;;
      update) echo "HEAL-CALLED $*" >> "${MOCK_HEAL_LOG}"; exit 0 ;;
    esac
    exit 0
    ;;
  image)
    case "$2" in
      inspect)
        tag="$3"; fmt="$5"
        case "${fmt}" in
          *Created*) echo "2026-10-09T00:00:00.000000000Z" ;;
          *Id*)
            case "${tag}" in
              *"staging-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
                echo "sha256:oldoldoldold000000000000000000000000000000000000000000" ;;
              *"staging-cccccccccccccccccccccccccccccccccccccccc")
                echo "sha256:newnewnewnew000000000000000000000000000000000000000000" ;;
              *)
                echo "sha256:unexpectedtag0000000000000000000000000000000000000000" ;;
            esac
            ;;
        esac
        exit 0
        ;;
      prune) exit 0 ;;
    esac
    exit 0
    ;;
  pull) exit 0 ;;                                  # always "succeeds" (no network)
  inspect) echo '[{"CreatedAt":"2026-10-09T00:00:00.000000000Z"}]'; exit 0 ;;
  ps) echo ""; exit 0 ;;                           # no local container -> tier 2 inert
esac
exit 0
MOCKDOCKER
chmod +x "${MOCKBIN}/docker"

# --- mock curl: GitHub API calls return a canned branch-head commit dated
#     2020 (clears any staleness grace period trivially); anything else
#     (Slack webhook posts) is logged instead of hitting the network. ------
cat > "${MOCKBIN}/curl" <<'MOCKCURL'
#!/usr/bin/env bash
argstr="$*"
case "${argstr}" in
  *api.github.com*)
    echo '{"sha":"cccccccccccccccccccccccccccccccccccccccc","commit":{"committer":{"date":"2020-01-01T00:00:00Z"}}}'
    exit 0
    ;;
  *)
    echo "CURL-CALL: $*" >> "${MOCK_CURL_LOG}"
    exit 0
    ;;
esac
MOCKCURL
chmod +x "${MOCKBIN}/curl"

# --- mock jq: not a JSON parser — handles only the exact filter strings
#     image-freshness-reconciler.sh issues, so the test needs no real jq. ---
cat > "${MOCKBIN}/jq" <<'MOCKJQ'
#!/usr/bin/env bash
if [[ "$1" == "-n" && "$2" == "--arg" ]]; then
  # slack(): jq -n --arg t "$TEXT" '{text: $t}' — echo the text verbatim.
  # Not valid JSON, but the mock curl only needs the text to grep on.
  echo "$4"
  exit 0
fi
args="$*"
input="$(cat 2>/dev/null)"
case "${args}" in
  *'.[0].CreatedAt // empty'*)
    echo "${input}" | grep -o '"CreatedAt":"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)"/\1/' ;;
  *'.sha // empty'*)
    echo "${input}" | grep -o '"sha":"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)"/\1/' ;;
  *'.commit.committer.date // empty'*)
    echo "${input}" | grep -o '"date":"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)"/\1/' ;;
  *)
    echo "{}" ;;
esac
exit 0
MOCKJQ
chmod +x "${MOCKBIN}/jq"

export PATH="${MOCKBIN}:${PATH}"
export STATE_DIR="${WORK}/state"
export SLACK_WEBHOOK="https://example.invalid/mock-slack"
export GITHUB_READ_TOKEN="mock-token-not-a-real-secret"

out="$(bash "${SCRIPT}" 2>&1)"
status=$?

echo "----- reconciler output -----"
echo "${out}"
echo "------------------------------"

fail=0
assert() {
  local desc="$1" cond="$2"
  if eval "${cond}"; then
    echo "PASS: ${desc}"
  else
    echo "FAIL: ${desc}"
    fail=1
  fi
}

assert "script exits 0"                                '[[ ${status} -eq 0 ]]'
assert "stuck-svc IS flagged SHA-STUCK"                 'echo "${out}" | grep -q "stuck-svc: SHA-STUCK"'
assert "fresh-svc is NOT flagged SHA-STUCK"              '! echo "${out}" | grep -q "fresh-svc: SHA-STUCK"'
assert "a Slack alert was posted for stuck-svc"          'grep -q "stuck-svc" "${MOCK_CURL_LOG}"'
assert "no Slack alert was posted for fresh-svc"         '! grep -q "fresh-svc" "${MOCK_CURL_LOG}"'
assert "detect-only: docker service update NEVER called" '[[ ! -s "${MOCK_HEAL_LOG}" ]]'

if [[ ${fail} -eq 0 ]]; then
  echo "ALL ASSERTIONS PASSED"
  exit 0
else
  echo "SOME ASSERTIONS FAILED"
  exit 1
fi
