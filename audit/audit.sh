#!/usr/bin/env bash
# systemd entrypoint: refresh all 13 service repos to staging HEAD,
# then invoke the agent via the SDK to scan for missing/outdated tests.
set -euo pipefail

cd "$(dirname "$0")"

mkdir -p reports
mkdir -p /home/claude-audit/repos

# Pull / clone each service repo at staging HEAD.
node -e "
const fs = require('node:fs');
const cp = require('node:child_process');
const list = JSON.parse(fs.readFileSync('repos.json','utf8')).repos;
for (const r of list) {
  if (!fs.existsSync(r.path)) {
    console.log('clone', r.name);
    cp.execSync(\`git clone --depth=200 -b staging \${r.url} \${r.path}\`, { stdio: 'inherit' });
  } else {
    console.log('pull', r.name);
    cp.execSync(\`git -C \${r.path} fetch origin staging --depth=200\`, { stdio: 'inherit' });
    cp.execSync(\`git -C \${r.path} checkout staging\`, { stdio: 'inherit' });
    cp.execSync(\`git -C \${r.path} reset --hard origin/staging\`, { stdio: 'inherit' });
  }
}
"

# Run both prompts via the Agent SDK in run-audit.ts.
exec pnpm exec tsx scripts/run-audit.ts
