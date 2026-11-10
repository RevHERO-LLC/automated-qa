#!/usr/bin/env node
// Archive a completed fill generation so the NEXT full regeneration has a prior to carry from.
//
// Run after the carried entries AND the agent residual have been applied. Writes
// <registry>/fill-archive/<date>/ in the layout carry-forward.mjs reads:
//   surface-inventory.json, zz-surfaces.md.pre-fill.bak (the raw scaffold), zz-surfaces.md.filled (final text),
//   run/fills/{fill-*.json, fill-status.json}, snapshot/ (the FULL code snapshot the fills were derived from),
//   carry-report.json / residual.json.
// Guard (gap audit P1): refuses unless the shared snapshot's _manifest.tsv still matches the hash recorded in the run's
// carry report -- another QA session refreshing the snapshot in between would otherwise archive code the fills were
// NOT derived from, and the next carry-forward would compare against the wrong baseline, silently.
// Retention: keeps the newest --keep generations (default 3).
//
// Usage: node archive.mjs --registry <qa-test-cases> --run <run dir> --snapshot <root> [--date YYYY-MM-DD] [--keep 3]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readBlocks, needsFill } from './lib/signature.mjs';

const GEN = /^\d{4}-\d{2}-\d{2}(-\d+)?$/;
export const byGen = (x, y) => x.localeCompare(y, 'en', { numeric: true });
const sha =(f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

export function archiveGeneration({ registry, run, snapshot, date = new Date().toISOString().slice(0, 10), keep = 3 }) {
  const reportFile = path.join(run, 'carry-report.json');
  if (!fs.existsSync(reportFile)) throw new Error(`no carry report in ${run}`);
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const now = sha(path.join(snapshot, '_manifest.tsv'));
  if (report.hashes.snapshotManifest !== now) {
    const e = new Error(`snapshot changed since the carry-forward ran (manifest ${now.slice(0, 12)} != ${report.hashes.snapshotManifest.slice(0, 12)}); refusing to archive code the fills were not derived from`);
    e.code = 'SNAPSHOT_CHANGED';
    throw e;
  }
  if (!fs.existsSync(path.join(run, 'fill-status.json'))) {
    throw new Error(`no fill-status.json in ${run}: nothing has been applied with --fills <run dir> yet, so there is nothing to archive`);
  }
  const finalText = fs.readFileSync(report.paths.frag, 'utf8');
  const remaining = [...readBlocks(finalText).values()].filter((b) => needsFill(b.block.join('\n'))).map((b) => b.id);
  const root = path.join(registry, 'fill-archive');
  fs.mkdirSync(root, { recursive: true });
  // The newest generation is what the next regeneration carries from, so a new one must sort after every existing
  // one: same-day generations are numbered past the highest existing suffix (never reusing a pruned name), and an
  // older date than an existing generation is refused.
  const existing = fs.readdirSync(root).filter((d) => GEN.test(d)).sort(byGen);
  const sameDay = existing.filter((d) => d === date || d.startsWith(`${date}-`)).map((d) => (d === date ? 1 : Number(d.slice(date.length + 1))));
  const name = sameDay.length ? `${date}-${Math.max(...sameDay) + 1}` : date;
  const newer = existing.filter((d) => byGen(d, name) > 0);
  if (newer.length) throw new Error(`a newer generation ${newer[newer.length - 1]} already exists; archive under a date on or after it`);
  const gen = path.join(root, name);
  const fills = path.join(gen, 'run', 'fills');
  fs.mkdirSync(fills, { recursive: true });
  fs.copyFileSync(path.join(run, 'surface-inventory.json'), path.join(gen, 'surface-inventory.json'));
  fs.copyFileSync(path.join(run, 'scaffold.raw.md'), path.join(gen, 'zz-surfaces.md.pre-fill.bak'));
  fs.copyFileSync(report.paths.frag, path.join(gen, 'zz-surfaces.md.filled'));
  for (const f of fs.readdirSync(run)) {
    if (/^fill-.*\.json$/.test(f)) fs.copyFileSync(path.join(run, f), path.join(fills, f));
    if (/^(carry-report\.(json|md)|residual\.json)$/.test(f)) fs.copyFileSync(path.join(run, f), path.join(gen, f));
  }
  fs.cpSync(snapshot, path.join(gen, 'snapshot'), { recursive: true });
  const pruned = [];
  const gens = fs.readdirSync(root).filter((d) => GEN.test(d)).sort(byGen);
  for (const old of gens.slice(0, Math.max(0, gens.length - keep))) {
    if (old === name) continue;
    fs.rmSync(path.join(root, old), { recursive: true, force: true });
    pruned.push(old);
  }
  return { generation: gen, pruned, remaining };
}

function main() {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const o = { registry: get('--registry'), run: get('--run'), snapshot: get('--snapshot'), date: get('--date'), keep: get('--keep') ? Number(get('--keep')) : 3 };
  if (!o.registry || !o.run || !o.snapshot) {
    console.error('usage: node archive.mjs --registry <qa-test-cases> --run <run dir> --snapshot <root> [--date YYYY-MM-DD] [--keep 3]');
    process.exit(2);
  }
  if (!o.date) delete o.date;
  try {
    const r = archiveGeneration(o);
    console.log(`archived -> ${r.generation}${r.pruned.length ? `; pruned ${r.pruned.join(', ')}` : ''}`);
    if (r.remaining.length) console.log(`WARNING: ${r.remaining.length} case(s) still hold fill placeholders (e.g. ${r.remaining.slice(0, 5).join(', ')}); they have no fill to carry next time`);
  } catch (e) {
    console.error(`REFUSED: ${e.message}`);
    process.exit(e.code === 'SNAPSHOT_CHANGED' ? 3 : 1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
