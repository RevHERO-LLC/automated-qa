# RevHero QA Audit Agent

Claude Code agent that runs every 14 days on VPS2, scans all 13 service repos for missing or outdated test coverage, and opens GitHub Issues against `RevHERO-LLC/automated-qa` with `[QA-AUDIT-MISSING]` / `[QA-AUDIT-STALE]` titles.

## Architecture

- **Host:** VPS2 (`147.93.1.174`, the Dokploy manager — outbound API access, no prod data path)
- **User:** `claude-audit` (Linux service user, isolated home)
- **Auth:** Claude Code OAuth signin via the user's regular Claude Pro/Team subscription. **No `ANTHROPIC_API_KEY`.** The agent invokes via `@anthropic-ai/claude-agent-sdk`'s `query()` API (NOT `claude -p`) so it runs unattended without spawning an interactive REPL.
- **Schedule:** systemd timer, `OnUnitActiveSec=14d`, `Persistent=true`
- **Output:** GitHub Issues + a markdown log under `audit/reports/audit-<date>.log`

## One-time setup

Done by a human (you) — the OAuth flow is browser-based and can't be automated. Steps:

```bash
# 1. SSH to VPS2 as root
ssh root@147.93.1.174

# 2. Create the service user
useradd -m -s /bin/bash claude-audit
mkdir -p /home/claude-audit/.ssh
# (no SSH key needed — local only)

# 3. Install Node 20 + pnpm
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git jq
npm install -g pnpm@9.12.3

# 4. Switch to the service user and install Claude Code + the SDK
sudo -iu claude-audit bash <<'EOS'
npm install -g @anthropic-ai/claude-code @anthropic-ai/claude-agent-sdk
EOS

# 5. Run the interactive OAuth signin (one-time, manual)
sudo -iu claude-audit claude
# In the TTY:
#   - Pick "Sign in with Anthropic"
#   - Open the URL in your local browser
#   - Paste the auth code back into the SSH session
#   - Verify with `claude /status` showing your account

# 6. Confirm credentials persisted
sudo -iu claude-audit ls -la /home/claude-audit/.claude/
# Should show .credentials.json with mode 0600

# 7. Clone automated-qa
sudo -iu claude-audit git clone https://github.com/RevHERO-LLC/automated-qa.git /home/claude-audit/automated-qa
sudo -iu claude-audit pnpm -C /home/claude-audit/automated-qa install --frozen-lockfile

# 8. Create /home/claude-audit/.env (mode 0600)
cat > /home/claude-audit/.env <<EOF
GH_TOKEN=<a fine-grained PAT scoped to RevHERO-LLC/automated-qa with issues:write only>
SLACK_WEBHOOK_URL=<the org-level SLACK_WEBHOOK_DEPLOYS value from GitHub org secrets — not stored in source>

GITHUB_REPO=RevHERO-LLC/automated-qa
EOF
chown claude-audit:claude-audit /home/claude-audit/.env
chmod 600 /home/claude-audit/.env

# 9. Install systemd unit + timer
cp /home/claude-audit/automated-qa/audit/systemd/revhero-audit.service /etc/systemd/system/
cp /home/claude-audit/automated-qa/audit/systemd/revhero-audit.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now revhero-audit.timer

# 10. Smoke-test by triggering immediately (don't wait 14 days for the first run)
systemctl start revhero-audit.service
journalctl -u revhero-audit -f
```

The 14-day clock starts ticking from the first `start` invocation.

## What the agent does each cycle

1. **`audit.sh`** clones / pulls all 13 service repos at `staging` HEAD into `/home/claude-audit/repos/`.
2. Invokes `scripts/run-audit.ts` which calls the SDK's `query()` API twice:
   - **Cycle 1: `prompts/coverage-audit.md`** — diff-classifies every changed file in the last 14 days, finds new endpoints / components / DB columns / cron jobs that have ZERO entry in `registry.json`. For each gap, drafts a registry entry + scaffolds a Playwright test file, opens `[QA-AUDIT-MISSING] <id>: <desc>` issue.
   - **Cycle 2: `prompts/stale-detect.md`** — for each existing test in the registry whose `file` field points at a Playwright test, walks the test source and flags any URL / response-shape / button-label / DB-column reference that has changed in the underlying service repo. Emits `[QA-AUDIT-STALE] <id>: <reason>` issue with a redlined diff.
3. Both prompts are capped at **50 issues per run** (overflow → one summary `[QA-AUDIT-OVERFLOW]` issue with the rest).
4. Stamps `last_audited_at: <ISO-date>` on every `registry.json` entry it reviewed.
5. Writes a transcript to `audit/reports/audit-<date>.log` (synced to VPS1's `/mnt/qa-reports` volume by an hourly rsync — see step 11 below if you want it).

## Re-signin runbook

If the OAuth token expires (rare — Claude Pro tokens are long-lived), `journalctl -u revhero-audit` shows an auth-error. Recover:

```bash
sudo -iu claude-audit claude /login
# Walk through OAuth again — same as step 5 above.
```

No code change. The `.credentials.json` is overwritten in place.

## Optional: hourly rsync of audit reports to VPS1

If you want audit logs visible at `https://qa-reports.test.revhero.io/audit/`:

```bash
# On VPS2:
crontab -e -u claude-audit
# Add:
0 * * * * rsync -az /home/claude-audit/automated-qa/audit/reports/ root@62.146.226.197:/var/lib/docker/volumes/qa-reports-volume/_data/audit/
```

Requires SSH-key auth between claude-audit on VPS2 and root on VPS1.

## Security notes

- The `claude-audit` Linux user has **no sudo**, **no SSH** in/out, and the GitHub token in `/home/claude-audit/.env` is scoped to `RevHERO-LLC/automated-qa: issues:write` only — no `repo`, no `workflow:write`, no other repos. If the host is compromised, the blast radius is "open spam Issues on automated-qa".
- The Agent SDK's `allowedTools` whitelist locks the agent to `Read`, `Grep`, `Glob`, and a restricted `Bash` (intended for `gh issue create / list / comment`). It cannot push code, modify the runner, or touch any repo other than the local clones in `/home/claude-audit/repos/`.
- OAuth credentials at mode `0600` in `/home/claude-audit/.claude/.credentials.json`. Revoke at https://claude.ai/account → Sessions if needed.
- `fail2ban` is already installed on VPS2 SSH (per the existing infra).

## Troubleshooting

| Symptom | Diagnosis | Fix |
|---|---|---|
| `journalctl -u revhero-audit` shows `auth: token expired` | OAuth credentials expired | Re-run `sudo -iu claude-audit claude /login` |
| `gh: command not found` in the audit log | gh CLI not installed on VPS2 | `apt-get install gh` and re-run |
| Agent runs but opens 0 issues even when registry is stale | Prompt may need a tuning round | Edit the relevant prompt file, re-commit, the next cycle picks up the change |
| Issues open with permission errors (`HTTP 403: Resource not accessible`) | `GH_TOKEN` PAT lacks `issues:write` | Rotate the PAT with the right scope |
| Timer never fires | systemd unit not enabled | `systemctl status revhero-audit.timer && systemctl enable --now revhero-audit.timer` |

## Manual trigger

```bash
ssh root@147.93.1.174
sudo systemctl start revhero-audit.service
journalctl -u revhero-audit -f
```
