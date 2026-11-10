#!/usr/bin/env node
// Export a code snapshot (one folder per repo, plus _manifest.tsv) from local clones -- the scripted replacement for
// the unsaved inline loop the 2026-11 runs used. Used for SCRATCH snapshots (e.g. the acceptance run); the shared
// qa-staging-snapshot refresh stays the QA protocol's business.
//
// Usage: node snapshot-export.mjs --repos-root <dir holding the clones> --out <dir>
//          [--repos a,b,c | --manifest <existing _manifest.tsv to copy the repo list from>]
//          [--ref origin/staging] [--fallback-ref origin/main] [--fetch] [--eol crlf|as-committed]
// Each repo is exported with `git archive <sha>`: the full tracked tree of that commit, no working-tree drift. The
// manifest records repo / ref actually used / sha (10 chars) / commit date / file count -- the existing format.
// Line endings: `git archive` applies core.autocrlf. The shared qa-staging-snapshot and the 2026-11-07 archive are
// CRLF throughout (verified 2026-11-10: every text file, including LF-committed ones), so the default pins
// core.autocrlf=true and a scratch export compares byte-for-byte with them on any machine. --eol as-committed pins
// core.autocrlf=false instead. Mixing the two conventions makes every text file "changed", so nothing would carry.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const git = (dir, args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  return n;
}

const EOL = { crlf: 'true', 'as-committed': 'false' };

function exportOne(repoDir, sha, dest, eol) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dest, { recursive: true });
    const ga = spawn('git', ['-c', `core.autocrlf=${EOL[eol]}`, '-C', repoDir, 'archive', '--format=tar', sha]);
    const tx = spawn('tar', ['-x', '-f', '-', '-C', dest]);
    let err = '';
    ga.stderr.on('data', (d) => { err += d; });
    tx.stderr.on('data', (d) => { err += d; });
    ga.stdout.pipe(tx.stdin);
    let codes = 0;
    const done = (c) => { if (c !== 0) return reject(new Error(`export failed (${c}): ${err.slice(0, 300)}`)); if (++codes === 2) resolve(); };
    ga.on('close', done);
    tx.on('close', done);
    ga.on('error', reject);
    tx.on('error', reject);
  });
}

export async function exportSnapshot({ reposRoot, out, repos, ref = 'origin/staging', fallbackRef = null, fetch = false, eol = 'crlf' }) {
  if (!EOL[eol]) throw new Error(`--eol must be crlf or as-committed (got ${eol})`);
  fs.mkdirSync(out, { recursive: true });
  const rows = [];
  const errors = [];
  for (const repo of repos) {
    const dir = path.join(reposRoot, repo);
    if (!fs.existsSync(path.join(dir, '.git'))) { errors.push(`${repo}: no clone at ${dir}`); continue; }
    if (fetch) {
      const f = git(dir, ['fetch', '-q', 'origin']);
      if (f.status !== 0) { errors.push(`${repo}: fetch failed: ${f.stderr.trim().slice(0, 200)}`); continue; }
    }
    let used = ref;
    let rv = git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (rv.status !== 0 && fallbackRef) { used = fallbackRef; rv = git(dir, ['rev-parse', '--verify', '--quiet', `${fallbackRef}^{commit}`]); }
    if (rv.status !== 0) { errors.push(`${repo}: ref ${ref}${fallbackRef ? ` / ${fallbackRef}` : ''} not found`); continue; }
    const sha = rv.stdout.trim();
    const dest = path.join(out, repo);
    fs.rmSync(dest, { recursive: true, force: true });
    await exportOne(dir, sha, dest, eol);
    const date = git(dir, ['log', '-1', '--format=%cI', sha]).stdout.trim();
    rows.push([repo, used, sha.slice(0, 10), date, String(countFiles(dest))]);
  }
  const manifest = ['repo\tref\tsha\tcommit_date\tfiles', ...rows.map((r) => r.join('\t'))].join('\n') + '\n';
  fs.writeFileSync(path.join(out, '_manifest.tsv'), manifest);
  return { rows, errors };
}

async function main() {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const reposRoot = get('--repos-root');
  const out = get('--out');
  let repos = get('--repos') ? get('--repos').split(',').map((s) => s.trim()).filter(Boolean) : null;
  if (!repos && get('--manifest')) {
    repos = fs.readFileSync(get('--manifest'), 'utf8').split(/\r?\n/).slice(1).map((l) => l.split('\t')[0]).filter(Boolean);
  }
  if (!reposRoot || !out || !repos || !repos.length) {
    console.error('usage: node snapshot-export.mjs --repos-root <dir> --out <dir> (--repos a,b | --manifest <tsv>) [--ref origin/staging] [--fallback-ref origin/main] [--fetch] [--eol crlf|as-committed]');
    process.exit(2);
  }
  const r = await exportSnapshot({ reposRoot, out, repos, ref: get('--ref') || 'origin/staging', fallbackRef: get('--fallback-ref') || null, fetch: a.includes('--fetch'), eol: get('--eol') || 'crlf' });
  for (const row of r.rows) console.log(row.join('\t'));
  for (const e of r.errors) console.error(`ERROR ${e}`);
  console.log(`exported ${r.rows.length}/${repos.length} repos -> ${out}`);
  process.exit(r.errors.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((e) => { console.error(e.message); process.exit(1); });
