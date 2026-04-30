#!/usr/bin/env bash
# systemd entrypoint: refresh all 13 service repos to staging HEAD,
# then invoke the agent via the SDK to scan for missing/outdated tests.
set -euo pipefail

cd "$(dirname "$0")"

mkdir -p reports
mkdir -p /home/claude-audit/repos

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "GH_TOKEN must be set in /home/claude-audit/.env (issues:write + repo:read scope)"
  exit 1
fi

# Embed the token into the clone URL so git can authenticate against the
# private RevHero org repos. The token is env-only — no on-disk credential.
node -e '
const fs = require("node:fs");
const cp = require("node:child_process");
const list = JSON.parse(fs.readFileSync("repos.json","utf8")).repos;
const tok = process.env.GH_TOKEN;
for (const r of list) {
  const authedUrl = r.url.replace("https://", "https://x-access-token:" + tok + "@");
  if (!fs.existsSync(r.path)) {
    console.log("clone", r.name);
    try {
      cp.execSync("git clone --depth=200 -b staging " + authedUrl + " " + r.path, { stdio: "inherit" });
    } catch (e) {
      console.warn("  clone failed for " + r.name + " - skipping");
    }
  } else {
    console.log("pull", r.name);
    try {
      cp.execSync("git -C " + r.path + " fetch " + authedUrl + " staging --depth=200", { stdio: "inherit" });
      cp.execSync("git -C " + r.path + " checkout staging", { stdio: "inherit" });
      cp.execSync("git -C " + r.path + " reset --hard FETCH_HEAD", { stdio: "inherit" });
    } catch (e) {
      console.warn("  pull failed for " + r.name + " - skipping");
    }
  }
}
'

# Run both prompts via the Agent SDK in run-audit.ts.
exec pnpm exec tsx scripts/run-audit.ts
