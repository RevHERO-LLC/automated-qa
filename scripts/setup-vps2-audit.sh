#!/usr/bin/env bash
# One-shot bootstrap to provision the claude-audit user on VPS2.
# Idempotent — safe to re-run.
set -e

# Run AS the claude-audit user.
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global

# Make the new prefix persistent.
if ! grep -q "npm-global" ~/.bashrc 2>/dev/null; then
  echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> ~/.bashrc
fi
export PATH=$HOME/.npm-global/bin:$PATH

# Install Claude Code + the agent SDK.
npm install -g @anthropic-ai/claude-code @anthropic-ai/claude-agent-sdk

# Verify.
which claude
claude --version || true

# Clone automated-qa if not already.
if [[ ! -d ~/automated-qa ]]; then
  git clone https://github.com/RevHERO-LLC/automated-qa.git ~/automated-qa
fi

# Install workspace deps. The audit/ workspace pulls the SDK locally too —
# that's fine; we use the global one for the `claude` CLI signin and the
# local one for `tsx scripts/run-audit.ts`.
cd ~/automated-qa
pnpm install --frozen-lockfile

mkdir -p ~/automated-qa/audit/reports

echo "DONE: claude-audit bootstrap complete"
echo "Next steps:"
echo "  1. Run 'claude' interactively as claude-audit and complete OAuth signin"
echo "  2. Create /home/claude-audit/.env with GH_TOKEN + SLACK_WEBHOOK_URL"
echo "  3. Install systemd unit + timer (root): cp audit/systemd/* /etc/systemd/system/"
