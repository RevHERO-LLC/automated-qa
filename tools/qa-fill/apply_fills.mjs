#!/usr/bin/env node
// Apply fill maps (<fills>/fill-*.json: { id: { text, evidence, status } }) to the generated registry fragments.
// Usage: node apply_fills.mjs --fills <dir> --frag <fragment.md> [--frag <fragment.md> ...] [--write]
//   default = dry run: validates every entry and reports, writes nothing (exit 3 if anything is rejected).
//   --write   = backs each fragment up (<frag>.pre-fill.<ts>.bak), replaces the case blocks in place, and merges
//               <fills>/fill-status.json (id -> {status, evidence, frag, src}); status "none" => result N/A.
// The validation rules are documented in lib/apply.mjs (unchanged from the 2026-11-07 run).

import { indexFragments, loadFillMaps, validateEntries, applyEntries } from './lib/apply.mjs';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const fills = args[args.indexOf('--fills') + 1];
const frags = args.reduce((acc, a, i) => (args[i - 1] === '--frag' ? [...acc, a] : acc), []);
if (!args.includes('--fills') || !fills || frags.length === 0) {
  console.error('usage: node apply_fills.mjs --fills <dir> --frag <fragment.md> [--frag ...] [--write]');
  process.exit(2);
}

const index = indexFragments(frags);
const { files, entries, loadErrors } = loadFillMaps(fills);
const { accepted, rejected } = validateEntries(entries, index);
const byStatus = {};
for (const a of accepted) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
console.log(`fill maps ${files.length}${loadErrors.length ? ` (unreadable: ${loadErrors.join(', ')})` : ''}; entries ${entries.length}; accepted ${accepted.length} ${JSON.stringify(byStatus)}; rejected ${rejected.length}`);
for (const r of rejected.slice(0, 40)) console.log(`  REJECT ${r.id} [${r.src}] ${r.why}`);
if (rejected.length > 40) console.log(`  ... ${rejected.length - 40} more`);
if (!WRITE) {
  console.log('dry run: nothing written (pass --write to apply)');
  process.exit(rejected.length ? 3 : 0);
}
const r = applyEntries(accepted, index, fills);
console.log(`applied ${accepted.length} to ${r.touched.join(', ') || '(nothing)'} (backups *.pre-fill.${r.ts}.bak); fill-status.json now holds ${r.statusCount} ids`);
