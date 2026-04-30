"""
Applies the Phase 4 deploy-prod.yml patch (qa-gate + notify-prod-deploy reuse)
to all 13 service repos.

For each repo:
  1. Read the existing .github/workflows/deploy-prod.yml
  2. Inject the qa-gate job before the first job
  3. Add `needs: qa-gate` to the existing build-and-deploy job
  4. Append the notify reusable workflow call
  5. git checkout staging, commit, push

Usage:  python scripts/apply-deploy-gate.py
"""

import os
import re
import subprocess
import sys
from pathlib import Path

REPOS = [
    ("RevHero-users-service", "https://users-service.revhero.io", False),
    ("RevHero-user-fe-backend", "https://user-fe-backend.revhero.io", False),
    ("RevHero-FE-New", "https://portal.revhero.ai", False),  # already patched
    ("RevHERO-Super-Admin-Portal", "https://config.revhero.ai", False),
    ("RevHero-campaign-service", "https://campaign-service.revhero.io", False),
    ("RevHero-deals-actions-service", "https://deals-actions-service.revhero.io", False),
    ("RevHero-dealmover-v3", "https://deal-mover.revhero.io", True),  # dual-image
    ("Revhero-Generic-Ai-Agent", "https://ai-agent.revhero.io", False),
    ("RevHero-cloud-documents-service", "https://cloud-documents-service.revhero.io", False),
    ("RevHero-Activity-service", "https://activity-service.revhero.io", False),
    ("RevHero-pipedrive-v3", "https://pipedrive-service.revhero.io", False),
    ("RevHero-email-ingress", "https://email-ingress.revhero.io", False),
    ("RevHero-sms-service", "https://sms-service.revhero.io", False),
]

BASE = Path(r"C:\Users\zsk54")

QA_GATE_BLOCK = """  qa-gate:
    runs-on: ubuntu-latest
    name: QA gate (block on CRITICAL fails)
    steps:
      - name: Fetch latest QA report from automated-qa runner
        run: |
          curl -fsSL --retry 3 https://qa-reports.test.revhero.io/latest.json -o /tmp/latest.json || {
            echo "::error::QA report unreachable - automated-qa runner may be down. Blocking deploy."
            exit 1
          }
      - name: Fetch QA registry (severity map)
        run: |
          curl -fsSL --retry 3 https://raw.githubusercontent.com/RevHERO-LLC/automated-qa/main/registry.json -o /tmp/registry.json
      - name: Block on CRITICAL failures
        run: |
          jq -r '.summary.results[] | select(.status == "FAIL") | .id' /tmp/latest.json > /tmp/failed_ids.txt
          if [[ ! -s /tmp/failed_ids.txt ]]; then
            echo "No QA failures. Proceeding."
            exit 0
          fi
          critical=0
          while IFS= read -r id; do
            [[ -z "$id" ]] && continue
            sev=$(jq -r --arg id "$id" '.entries[] | select(.id == $id) | .severity' /tmp/registry.json)
            echo "  $id (severity=$sev)"
            if [[ "$sev" == "critical" ]]; then
              echo "::error::CRITICAL QA fail blocking deploy: $id"
              critical=$((critical+1))
            fi
          done < /tmp/failed_ids.txt
          if [[ $critical -gt 0 ]]; then
            echo "::error::$critical CRITICAL test(s) failing - deploy blocked. See https://qa-reports.test.revhero.io/latest.md"
            exit 1
          fi
          echo "Non-CRITICAL fails only - deploy may proceed."

"""

NOTIFY_TEMPLATE = """
  notify:
    needs: [{notify_needs}]
    if: always()
    uses: RevHERO-LLC/automated-qa/.github/workflows/notify-prod-deploy.yml@main
    with:
      repo: ${{{{ github.repository }}}}
      sha: ${{{{ github.sha }}}}
      pr_title: ${{{{ github.event.head_commit.message }}}}
      author: ${{{{ github.event.head_commit.author.name }}}}
      image_tag: prod-${{{{ github.sha }}}}
      dokploy_app_id: ${{{{ secrets.DOKPLOY_APP_ID_PROD }}}}
      service_url: {service_url}
      run_url: ${{{{ github.server_url }}}}/${{{{ github.repository }}}}/actions/runs/${{{{ github.run_id }}}}
    secrets:
      DOKPLOY_API_TOKEN: ${{{{ secrets.DOKPLOY_API_TOKEN }}}}
      SLACK_WEBHOOK_DEPLOYS: ${{{{ secrets.SLACK_WEBHOOK_DEPLOYS }}}}
"""


def patch_workflow(repo_dir: Path, service_url: str, dual_image: bool) -> bool:
    wf = repo_dir / ".github" / "workflows" / "deploy-prod.yml"
    if not wf.exists():
        print(f"  SKIP: {wf} not found")
        return False
    text = wf.read_text(encoding="utf-8")
    if "qa-gate:" in text:
        print(f"  SKIP: already patched")
        return False

    # Insert qa-gate before the first job. The "jobs:" line is followed by an
    # indented job name. Find it and inject.
    lines = text.split("\n")
    out = []
    inserted = False
    needs_added = False
    in_jobs = False
    for i, line in enumerate(lines):
        if not in_jobs and re.match(r"^jobs:\s*$", line):
            in_jobs = True
            out.append(line)
            continue
        if in_jobs and not inserted and re.match(r"^  [a-zA-Z][a-zA-Z0-9_-]*:\s*$", line):
            # First job declaration. Insert qa-gate first, then needs: qa-gate.
            out.append(QA_GATE_BLOCK.rstrip("\n"))
            out.append("")
            out.append(line)
            # Insert `needs: qa-gate` right after `runs-on:` line.
            inserted = True
            continue
        if inserted and not needs_added and re.match(r"^    runs-on:\s+", line):
            out.append(line)
            out.append("    needs: qa-gate")
            needs_added = True
            continue
        out.append(line)

    if not inserted:
        print(f"  ERROR: could not find first job to insert qa-gate")
        return False

    body = "\n".join(out).rstrip() + "\n"
    notify = NOTIFY_TEMPLATE.format(notify_needs="build-and-deploy", service_url=service_url)
    body += notify
    wf.write_text(body, encoding="utf-8", newline="\n")
    print(f"  patched {wf}")
    return True


def run(cmd, cwd):
    return subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, shell=False)


def commit_and_push(repo_dir: Path) -> bool:
    # Ensure on staging branch.
    branch = run(["git", "branch", "--show-current"], repo_dir).stdout.strip()
    if branch != "staging":
        print(f"  not on staging (on {branch}); checking out staging")
        sw = run(["git", "checkout", "staging"], repo_dir)
        if sw.returncode != 0:
            print(f"  checkout failed: {sw.stderr}")
            return False
    add = run(["git", "add", ".github/workflows/deploy-prod.yml"], repo_dir)
    if add.returncode != 0:
        print(f"  add failed: {add.stderr}")
        return False
    msg = (
        "ci(deploy): wire automated-qa gate + notify reusable workflow\n\n"
        "Phase 4 of the QA automation rollout. Adds two jobs to deploy-prod.yml:\n"
        "  - qa-gate (runs first): fetches https://qa-reports.test.revhero.io/latest.json\n"
        "    and the registry severity map, blocks the deploy if any test with\n"
        "    severity=critical is FAILing.\n"
        "  - notify (always): calls RevHERO-LLC/automated-qa/.github/workflows/\n"
        "    notify-prod-deploy.yml@main with deploy outcome, posts to Slack.\n\n"
        "Existing build-and-deploy gets `needs: qa-gate` so the deploy waits.\n"
        "No application code changes.\n\n"
        "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>\n"
    )
    cm = run(["git", "commit", "-m", msg], repo_dir)
    if cm.returncode != 0:
        print(f"  commit failed: {cm.stderr}")
        return False
    pu = run(["git", "push", "origin", "staging"], repo_dir)
    if pu.returncode != 0:
        print(f"  push failed: {pu.stderr}")
        return False
    print(f"  pushed staging")
    return True


def main():
    skipped = []
    patched = []
    failed = []
    for name, url, dual in REPOS:
        print(f"\n=== {name} ===")
        repo_dir = BASE / name
        if not repo_dir.exists():
            print(f"  MISSING: {repo_dir}")
            failed.append(name)
            continue
        # Special case: FE-New already manually patched
        if name == "RevHero-FE-New":
            wf = repo_dir / ".github" / "workflows" / "deploy-prod.yml"
            if wf.exists() and "qa-gate:" in wf.read_text(encoding="utf-8"):
                print("  already manually patched; just commit + push")
                ok = commit_and_push(repo_dir)
                if ok:
                    patched.append(name)
                else:
                    skipped.append(name)
                continue
        ok = patch_workflow(repo_dir, url, dual)
        if not ok:
            skipped.append(name)
            continue
        ok2 = commit_and_push(repo_dir)
        if ok2:
            patched.append(name)
        else:
            failed.append(name)

    print("\n--- Summary ---")
    print(f"Patched:  {len(patched)}")
    for n in patched: print(f"  + {n}")
    print(f"Skipped:  {len(skipped)}")
    for n in skipped: print(f"  ~ {n}")
    print(f"Failed:   {len(failed)}")
    for n in failed: print(f"  ! {n}")


if __name__ == "__main__":
    main()
