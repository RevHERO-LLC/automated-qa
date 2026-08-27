"""
harden-deploy-gate.py

Applies two hardening fixes to the `qa-gate` job that is inline-duplicated in
each RevHero service repo's `.github/workflows/deploy-prod.yml`:

  FIX 1 - Freshness check. Inserts a new "Block on a stale QA report" step
          between "Fetch latest QA report..." and "Fetch QA registry...", so
          a QA report older than MAX_AGE_HOURS (30) blocks the deploy instead
          of silently gating on a stale run.

  FIX 2 - Renames "Block on CRITICAL failures" to "Block on CRITICAL/HIGH
          failures or NOT_EXEC" and replaces its body so the gate blocks on
          severity == critical OR high, and on status == FAIL OR NOT_EXEC
          (previously: only FAIL results, only severity == critical).

The patcher is a pure text/string-splice, anchored on two fragments that are
byte-identical across all 18 repos (verified by a survey on 2026-08-27):
  - "      - name: Fetch QA registry (severity map)\n"  (FIX 1 insertion point)
  - "      - name: Block on CRITICAL failures\n"         (FIX 2 replacement target)

Everything else in the qa-gate job - including `runs-on: self-hosted`,
`curl -fsSLk` in the first step, and the per-repo `| grep -E '<pattern>'` ID
filter used by 5 repos - is left untouched because it sits outside both
targeted fragments.

Filter preservation is DETECTION-based, not a hardcoded lookup: the existing
`grep -E '<pattern>'` (if any) is extracted from each repo's live file via
regex and re-embedded into the new jq line. The REPOS list below carries the
*documented* pattern per repo only as a cross-check against what is actually
found in the file - if they disagree, the live file wins and a warning is
printed, since "detect and preserve" means trusting the source of truth, not
a possibly-stale table.

Idempotent: a repo whose gate already contains "Block on a stale QA report"
or "NOT_EXEC" is left untouched and reported as skip-already.

DEFAULT MODE IS DRY-RUN. Patched output is written only under --out-dir
(default: a scratchpad directory, see DEFAULT_OUT_DIR below) - never to the
real repo. This script never shells out to git, in either mode.

--apply switches the write target to the REAL repo path (still no git
commands - staging/commit/push remain a separate, deliberate human step).
It exists for later human-invoked use only; an agent must not pass it.

Usage:
    python scripts/harden-deploy-gate.py                       # dry-run, all 18 repos
    python scripts/harden-deploy-gate.py --only RevHero-campaign-service,RevHero-sms-service
    python scripts/harden-deploy-gate.py --diff-for RevHero-swarm-service
    python scripts/harden-deploy-gate.py --apply                # writes real repo files (human use only)
"""

import argparse
import difflib
import re
import sys
from pathlib import Path

try:
    import yaml  # PyYAML - used only for a best-effort post-patch structural check
    HAVE_YAML = True
except ImportError:
    HAVE_YAML = False


BASE = Path(r"C:\Users\zsk54")
DEFAULT_OUT_DIR = Path(
    r"C:\Users\zsk54\AppData\Local\Temp\claude\C--Users-zsk54-OneDrive-Desktop-RevHERO"
    r"\a13de84e-6a82-4ecd-9e10-a0dece670191\scratchpad\gate-harden-dryrun"
)

WORKFLOW_REL_PATH = Path(".github") / "workflows" / "deploy-prod.yml"

# (repo name, DOCUMENTED grep -E filter pattern or None). Cross-check only -
# the patch always uses whatever is actually detected in the file.
REPOS = [
    ("RevHero-users-service", None),
    ("RevHero-user-fe-backend", None),
    ("RevHero-FE-New", None),
    ("RevHERO-Super-Admin-Portal", r"^(IA-|SUPER-ADMIN-)"),
    ("RevHero-campaign-service", None),
    ("RevHero-deals-actions-service", r"^(IA-|DEALS-)"),
    ("RevHero-dealmover-v3", None),
    ("Revhero-Generic-Ai-Agent", r"^(IA-|GENERIC-AI-|AI-AGENT-)"),
    ("RevHero-cloud-documents-service", None),
    ("RevHero-Activity-service", None),
    ("RevHero-pipedrive-v3", None),
    ("RevHero-email-ingress", None),
    ("RevHero-sms-service", r"^(IA-|SMS-)"),
    ("RevHero-hubspot-service", None),
    ("RevHero-calendar-service", None),
    ("RevHero-swarm-service", None),
    ("RevHero-swarm-dealmover", None),
    ("RevHero-analytics-service", r"^IA-"),
]

SPOTLIGHT_DIFF_REPOS = ["RevHero-campaign-service", "RevHero-deals-actions-service"]

# ---------------------------------------------------------------------------
# FIX 1 - freshness check. Inserted verbatim before FIX1_ANCHOR.
# ---------------------------------------------------------------------------
FIX1_ANCHOR = "      - name: Fetch QA registry (severity map)\n"

FIX1_BLOCK = r"""      - name: Block on a stale QA report
        run: |
          MAX_AGE_HOURS=30
          finished_at=$(jq -r '.summary.finished_at' /tmp/latest.json)
          if [[ -z "$finished_at" || "$finished_at" == "null" ]]; then
            echo "::error::latest.json has no summary.finished_at - treating as stale. Blocking deploy."
            exit 1
          fi
          finished_epoch=$(date -d "$finished_at" +%s) || { echo "::error::Could not parse finished_at='$finished_at'. Blocking."; exit 1; }
          age_hours=$(( ( $(date -u +%s) - finished_epoch ) / 3600 ))
          echo "QA report finished_at=$finished_at (${age_hours}h old, threshold=${MAX_AGE_HOURS}h)"
          if (( age_hours > MAX_AGE_HOURS )); then
            echo "::error::QA report is ${age_hours}h old (> ${MAX_AGE_HOURS}h) - stale run cannot gate this deploy. Blocking."
            exit 1
          fi
"""

# ---------------------------------------------------------------------------
# FIX 2 - rename + replace body of the "Block on CRITICAL failures" step.
# ---------------------------------------------------------------------------
STEP2_NAME_OLD = "      - name: Block on CRITICAL failures\n"
STEP2_NAME_NEW = "      - name: Block on CRITICAL/HIGH failures or NOT_EXEC\n"
STEP2_RUN_HDR = "        run: |\n"

_JQ_LINE_UNFILTERED = (
    r'''          jq -r '.summary.results[] | select(.status == "FAIL" or .status == "NOT_EXEC") | "\(.id)\t\(.status)"' /tmp/latest.json > /tmp/blocking.tsv'''
    "\n"
)
_JQ_TAIL = " > /tmp/blocking.tsv"  # marker used to splice in the grep filter


def jq_line_for(pattern):
    """Build the FIX-2 jq line, optionally piping through the repo's grep -E filter."""
    base = _JQ_LINE_UNFILTERED.rstrip("\n")
    if not base.endswith(_JQ_TAIL):
        raise RuntimeError("internal template drift: jq line template changed shape")
    head = base[: -len(_JQ_TAIL)]  # "...' /tmp/latest.json"
    if not pattern:
        return head + _JQ_TAIL + "\n"
    return f"{head} | grep -E '{pattern}'{_JQ_TAIL} || true\n"


REST_BODY = r"""          if [[ ! -s /tmp/blocking.tsv ]]; then echo "No FAIL/NOT_EXEC results. Proceeding."; exit 0; fi
          blocking=0
          while IFS=$'\t' read -r id status; do
            [[ -z "$id" ]] && continue
            sev=$(jq -r --arg id "$id" '.entries[] | select(.id == $id) | .severity' /tmp/registry.json)
            echo "  $id (status=$status, severity=$sev)"
            if [[ "$sev" == "critical" || "$sev" == "high" ]]; then
              echo "::error::$sev QA $status blocking deploy: $id"; blocking=$((blocking+1))
            fi
          done < /tmp/blocking.tsv
          if [[ $blocking -gt 0 ]]; then echo "::error::$blocking CRITICAL/HIGH test(s) FAILing or NOT_EXEC - deploy blocked."; exit 1; fi
"""


def build_step2_body(pattern):
    return jq_line_for(pattern) + REST_BODY


GREP_FILTER_RE = re.compile(r"\|\s*grep -E '([^']*)'")
NEXT_JOB_RE = re.compile(r"\n(  [A-Za-z_][A-Za-z0-9_-]*:[ \t]*\n)")
QA_GATE_JOB_RE = re.compile(r"(?m)^  qa-gate:[ \t]*$")

ALREADY_HARDENED_MARKERS = ("Block on a stale QA report", "NOT_EXEC")

EXPECTED_STEP_NAMES = [
    "Fetch latest QA report from automated-qa runner",
    "Block on a stale QA report",
    "Fetch QA registry (severity map)",
    "Block on CRITICAL/HIGH failures or NOT_EXEC",
]

SKIP_LABELS = {
    "already-hardened": "skip-already",
    "no-gate": "skip-nogate",
    "missing-repo-or-file": "skip-missing",
    "decode-error": "skip-decode-error",
}


def apply_fix1(work: str):
    """Insert FIX1_BLOCK immediately before the unique FIX1_ANCHOR line."""
    count = work.count(FIX1_ANCHOR)
    if count != 1:
        return work, False, f"expected exactly 1 occurrence of the Fix-1 anchor, found {count}"
    idx = work.index(FIX1_ANCHOR)
    new_work = work[:idx] + FIX1_BLOCK + work[idx:]
    return new_work, True, None


def apply_fix2(work: str):
    """Replace the name + run body of the 'Block on CRITICAL failures' step."""
    count = work.count(STEP2_NAME_OLD)
    if count != 1:
        return work, False, None, f"expected exactly 1 occurrence of the Fix-2 step name, found {count}"
    name_idx = work.index(STEP2_NAME_OLD)
    after_name = name_idx + len(STEP2_NAME_OLD)
    if not work.startswith(STEP2_RUN_HDR, after_name):
        return work, False, None, "'run: |' header not found immediately after the Fix-2 step name"
    body_start = after_name + len(STEP2_RUN_HDR)
    m = NEXT_JOB_RE.search(work, body_start)
    body_end = m.start() if m else len(work)
    old_body = work[body_start:body_end]

    fm = GREP_FILTER_RE.search(old_body)
    detected_pattern = fm.group(1) if fm else None

    new_body = build_step2_body(detected_pattern)
    new_work = work[:name_idx] + STEP2_NAME_NEW + STEP2_RUN_HDR + new_body + work[body_end:]
    return new_work, True, detected_pattern, None


def _try_parse_yaml(text):
    try:
        return yaml.safe_load(text), None
    except Exception as e:  # PyYAML can raise several exception types; be permissive here.
        return None, str(e)


def validate_structure(old_work: str, new_work: str):
    """
    Best-effort structural check of the patched YAML. Returns (ok, detail).
    If the file wasn't valid strict-YAML to begin with (some GH Actions files
    use syntax quirks PyYAML dislikes), a parse failure that ALSO reproduces
    on the pre-patch text is treated as pre-existing and downgraded to a
    passing warning rather than a hard mismatch, since it isn't something
    this patch introduced.
    """
    if not HAVE_YAML:
        return True, "PyYAML not available - structural validation skipped"

    new_data, new_err = _try_parse_yaml(new_work)
    if new_err:
        _, old_err = _try_parse_yaml(old_work)
        if old_err:
            return True, f"YAML parse warning pre-exists in original (not introduced by patch): {new_err}"
        return False, f"patched file is not valid YAML (original parsed fine): {new_err}"

    jobs = (new_data or {}).get("jobs") or {}
    qa = jobs.get("qa-gate")
    if qa is None:
        return False, "patched YAML has no jobs.qa-gate"
    if qa.get("runs-on") != "self-hosted":
        return False, f"jobs.qa-gate.runs-on = {qa.get('runs-on')!r} (expected 'self-hosted')"
    steps = qa.get("steps") or []
    names = [s.get("name") for s in steps]
    if names != EXPECTED_STEP_NAMES:
        return False, f"jobs.qa-gate.steps names = {names!r} (expected {EXPECTED_STEP_NAMES!r})"
    return True, None


def process_repo(name, expected_pattern, base: Path):
    wf = base / name / WORKFLOW_REL_PATH
    if not wf.exists():
        return {"name": name, "status": "skip", "reason": "missing-repo-or-file", "detail": str(wf)}

    raw = wf.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        return {"name": name, "status": "skip", "reason": "decode-error", "detail": str(e)}

    uses_crlf = "\r\n" in text
    work = text.replace("\r\n", "\n")

    if not QA_GATE_JOB_RE.search(work):
        return {"name": name, "status": "skip", "reason": "no-gate",
                "detail": "no '  qa-gate:' job header found"}

    if any(marker in work for marker in ALREADY_HARDENED_MARKERS):
        return {"name": name, "status": "skip", "reason": "already-hardened", "detail": None}

    work1, ok1, err1 = apply_fix1(work)
    if not ok1:
        return {"name": name, "status": "mismatch", "reason": "fix1", "detail": err1}

    work2, ok2, detected_pattern, err2 = apply_fix2(work1)
    if not ok2:
        return {"name": name, "status": "mismatch", "reason": "fix2", "detail": err2}

    warnings = []
    if "runs-on: self-hosted" not in work2:
        warnings.append("runs-on: self-hosted MISSING post-patch")
    if "curl -fsSLk" not in work2:
        warnings.append("curl -fsSLk MISSING post-patch")
    if expected_pattern is not None and detected_pattern != expected_pattern:
        warnings.append(
            f"filter drift vs. documentation: documented={expected_pattern!r} "
            f"actual-in-file={detected_pattern!r} (used the actual one)"
        )
    if expected_pattern is None and detected_pattern is not None:
        warnings.append(f"undocumented filter found in file: {detected_pattern!r} (preserved anyway)")
    if expected_pattern is not None and detected_pattern is None:
        warnings.append(
            f"documentation expected filter {expected_pattern!r} but none was found in the "
            f"original file - patched as UNFILTERED"
        )

    if detected_pattern is not None:
        refound = GREP_FILTER_RE.search(work2)
        if not refound or refound.group(1) != detected_pattern:
            warnings.append("filter FAILED to round-trip into patched output")

    ok_struct, struct_detail = validate_structure(work, work2)
    if not ok_struct:
        return {
            "name": name, "status": "mismatch", "reason": "post-patch-structure",
            "detail": struct_detail, "filter": detected_pattern,
        }
    if struct_detail:
        warnings.append(struct_detail)

    new_text = work2.replace("\n", "\r\n") if uses_crlf else work2

    diff = list(difflib.unified_diff(
        text.splitlines(keepends=True),
        new_text.splitlines(keepends=True),
        fromfile=f"a/{name}/.github/workflows/deploy-prod.yml",
        tofile=f"b/{name}/.github/workflows/deploy-prod.yml",
    ))

    status = "patched" if not warnings else "patched-with-warnings"
    return {
        "name": name, "status": status, "reason": None, "detail": "; ".join(warnings) or None,
        "filter": detected_pattern, "old_text": text, "new_text": new_text, "diff": diff,
        "source_path": wf,
    }


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--apply", action="store_true",
        help="Write patched files to the REAL repo paths instead of --out-dir. Still never "
             "runs git. For deliberate human-invoked use only - do not pass this from an agent.",
    )
    ap.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR,
                     help="Dry-run output directory (ignored when --apply is set).")
    ap.add_argument("--only", type=str, default=None,
                     help="Comma-separated subset of repo names to process.")
    ap.add_argument("--diff-for", type=str, default=",".join(SPOTLIGHT_DIFF_REPOS),
                     help="Comma-separated repo names to print a full unified diff for.")
    args = ap.parse_args()

    repos = REPOS
    if args.only:
        wanted = {r.strip() for r in args.only.split(",") if r.strip()}
        known = {r[0] for r in REPOS}
        unknown = wanted - known
        if unknown:
            print(f"WARNING: --only named unknown repos (ignored): {sorted(unknown)}")
        repos = [r for r in REPOS if r[0] in wanted]

    spotlight = {r.strip() for r in args.diff_for.split(",") if r.strip()}

    if args.apply:
        print("MODE: --apply -> writing to REAL repo paths. No git commands will run.")
    else:
        print(f"MODE: dry-run -> writing patched copies under {args.out_dir}")
    if not HAVE_YAML:
        print("NOTE: PyYAML not importable - post-patch structural validation will be skipped.")
    print()

    results = []
    for name, expected_pattern in repos:
        res = process_repo(name, expected_pattern, BASE)
        results.append(res)

        if res["status"] == "skip":
            label = SKIP_LABELS.get(res["reason"], f"skip-{res['reason']}")
            suffix = f" - {res['detail']}" if res.get("detail") else ""
            print(f"[{label}] {name}{suffix}")
            continue

        if res["status"] == "mismatch":
            print(f"[mismatch:{res['reason']}] {name} - {res['detail']}  <-- HAND-CHECK NEEDED")
            continue

        filt = res["filter"]
        filt_str = f"filter preserved: {filt!r}" if filt else "filter: none (unfiltered gate)"
        warn = f"  [warnings: {res['detail']}]" if res["detail"] else ""
        print(f"[{res['status']}] {name} - {filt_str}{warn}")

        if args.apply:
            out_path = res["source_path"]
        else:
            out_path = args.out_dir / name / "deploy-prod.yml"
            out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(res["new_text"].encode("utf-8"))

        if not args.apply:
            diff_path = args.out_dir / name / "deploy-prod.yml.diff"
            diff_path.write_text("".join(res["diff"]), encoding="utf-8", newline="")

    patched = [r for r in results if r["status"] in ("patched", "patched-with-warnings")]
    skip_already = [r for r in results if r["status"] == "skip" and r["reason"] == "already-hardened"]
    skip_nogate = [r for r in results if r["status"] == "skip" and r["reason"] == "no-gate"]
    skip_other = [r for r in results if r["status"] == "skip" and r["reason"] not in ("already-hardened", "no-gate")]
    mismatches = [r for r in results if r["status"] == "mismatch"]

    print("\n--- Summary ---")
    print(f"Patched:               {len(patched)}")
    print(f"Skipped (hardened):    {len(skip_already)}")
    print(f"Skipped (no gate):     {len(skip_nogate)}")
    print(f"Skipped (other):       {len(skip_other)}")
    print(f"Mismatch (hand-check): {len(mismatches)}")
    if mismatches:
        for r in mismatches:
            print(f"  ! {r['name']}: [{r['reason']}] {r['detail']}")

    filters_seen = {r["name"]: r["filter"] for r in patched if r["filter"]}
    print(f"\nFilters preserved ({len(filters_seen)} of 5 expected):")
    for n, f in filters_seen.items():
        print(f"  {n}: {f!r}")

    for r in patched:
        if r["name"] in spotlight:
            print(f"\n=== unified diff: {r['name']} ===")
            sys.stdout.write("".join(r["diff"]))
            print(f"=== end diff: {r['name']} ===\n")

    if not args.apply:
        args.out_dir.mkdir(parents=True, exist_ok=True)
        summary_path = args.out_dir / "SUMMARY.txt"
        with summary_path.open("w", encoding="utf-8") as fh:
            for r in results:
                fh.write(
                    f"{r['status']:24s} {r['name']:36s} reason={r.get('reason')} "
                    f"filter={r.get('filter')} detail={r.get('detail')}\n"
                )
        print(f"\nWrote summary to {summary_path}")

    sys.exit(1 if mismatches else 0)


if __name__ == "__main__":
    main()
