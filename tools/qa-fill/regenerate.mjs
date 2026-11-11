#!/usr/bin/env node
// THE single RevHero entry point for registry step 3b (decided in the grill): regenerate the surface scaffold with the
// shared extractor, then carry prior fills forward so the agent fill only sees the residual.
//
// Full run (no --touched):
//   1. qa-surface-inventory.js --contract <c> --inventory <inv> --fragment <frag>
//   2. keep the RAW scaffold (<out>/scaffold.raw.md) and the inventory copy in the run dir
//   3. carry-forward against the newest generation in <registry>/fill-archive/ (or --prior)
//   --write: <inv>/<frag> are the registry's own (<registry>/surface-inventory.json, fragments/zz-surfaces.md), and the
//            validated carried fills are applied to that fragment.
//   default (dry run): <inv>/<frag> live in the run dir, so the registry is NOT touched. A full extraction replaces
//            every fill with a placeholder; doing that to the live fragment on a "dry run" would leave exactly the
//            unfilled registry that sends everything to agents. The slicer refuses a dry-run report (its inventory
//            hash is not the registry's).
// Scoped run (--touched <diff>): passes straight through to the extractor with the registry paths, which is exactly
// the protocol's own step-3b command; the extractor carries untouched surfaces forward itself
// (qa-surface-inventory.js:527-531), so there is no carry-forward.
//
// Usage: node regenerate.mjs --contract <qa-contract.json> --registry <qa-test-cases dir> --out <run dir>
//          [--snapshot <root>] [--prior <generation dir>] [--extractor <js>] [--strict-router] [--write] [--touched <diff file>]

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { carryForward, DEFAULT_EXTRACTOR } from './carry-forward.mjs';
import { byGen } from './archive.mjs';

const GEN = /^\d{4}-\d{2}-\d{2}(-\d+)?$/;
const REQUIRED = ['surface-inventory.json', 'zz-surfaces.md.pre-fill.bak', 'zz-surfaces.md.filled', 'run/fills/fill-status.json', 'snapshot/_manifest.tsv'];

export function latestGeneration(registry) {
  const root = path.join(registry, 'fill-archive');
  if (!fs.existsSync(root)) return null;
  const gens = fs.readdirSync(root).filter((d) => GEN.test(d)).sort(byGen);
  for (let i = gens.length - 1; i >= 0; i--) {
    const dir = path.join(root, gens[i]);
    if (REQUIRED.every((f) => fs.existsSync(path.join(dir, f)))) return dir;
  }
  return null;
}

/** Walk up from the contract's first declared source to the directory holding _manifest.tsv. */
export function snapshotRootFromContract(contractPath) {
  const c = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const first = (c.surfaces && c.surfaces.source && c.surfaces.source[0]) || '';
  let dir = path.dirname(first.replace(/\*\*.*$/, 'x'));
  for (let i = 0; i < 12 && dir && dir !== path.dirname(dir); i++) {
    if (fs.existsSync(path.join(dir, '_manifest.tsv'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function main() {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const contract = get('--contract');
  const registry = get('--registry');
  const out = get('--out');
  const extractor = get('--extractor') || DEFAULT_EXTRACTOR;
  const touched = get('--touched');
  if (!contract || !registry || (!out && !touched)) {
    console.error('usage: node regenerate.mjs --contract <qa-contract.json> --registry <qa-test-cases> --out <run dir> [--snapshot <root>] [--prior <gen>] [--extractor <js>] [--strict-router] [--write] [--touched <diff>]');
    process.exit(2);
  }
  const write = a.includes('--write');
  const strictRouter = a.includes('--strict-router'); // carry-forward: whole-file routes.go rule (no option C)
  const regInventory = path.join(registry, 'surface-inventory.json');
  const regFragment = path.join(registry, 'fragments', 'zz-surfaces.md');
  if (touched) {
    console.log('SCOPED run: the extractor carries untouched surfaces forward itself; carry-forward is skipped.');
    const r = spawnSync(process.execPath, [extractor, '--contract', contract, '--inventory', regInventory, '--fragment', regFragment, '--touched', touched], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  fs.mkdirSync(out, { recursive: true });
  const inventory = write ? regInventory : path.join(out, 'surface-inventory.json');
  const fragment = write ? regFragment : path.join(out, 'zz-surfaces.md');
  if (!write) console.log(`DRY RUN: regenerating into ${out}; the registry is not touched (pass --write to regenerate it and apply the carry)`);
  const r = spawnSync(process.execPath, [extractor, '--contract', contract, '--inventory', inventory, '--fragment', fragment], { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`extractor exited ${r.status}`); process.exit(r.status ?? 1); }
  const raw = path.join(out, 'scaffold.raw.md');
  fs.copyFileSync(fragment, raw);
  if (write) fs.copyFileSync(inventory, path.join(out, 'surface-inventory.json'));
  const snapshot = get('--snapshot') || snapshotRootFromContract(contract);
  if (!snapshot) { console.error('cannot infer the snapshot root from the contract; pass --snapshot'); process.exit(2); }
  const prior = get('--prior') || latestGeneration(registry);
  console.log(`prior generation: ${prior || 'NONE (everything goes to residual)'}`);
  const res = carryForward({ prior, scaffold: raw, inventory, snapshot, contract, out, frag: fragment, extractor, write, strictRouter });
  console.log(fs.readFileSync(path.join(out, 'carry-report.md'), 'utf8'));
  if (res.applied) console.log(`applied ${res.accepted.length} carried entries to ${fragment}`);
  else if (!write) console.log('dry run: nothing applied and the registry untouched (pass --write)');
  if (res.report.selfCheckProblems.length) process.exit(4);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
