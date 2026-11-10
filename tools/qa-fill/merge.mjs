#!/usr/bin/env node
// Merge the fill agents' part files (block format) into ONE apply_fills map. Generalized from the three 2026-11-07
// merge scripts (legacy-2026-11-07/merge*.mjs), which differed only in hardcoded paths and in how many checks each
// ran: the paths are arguments here, and every check any of them ran is run.
//
// Block format (no JSON escaping needed):
//   === FE-SURF-131 | filled|none|finding
//   EV: file:line; file:line
//   TX: the middle of the bullet (may continue over following lines until the next "=== ")
// The case prefix ("- **ID** — [S### path]") and suffix ("_type: x_", plus "_actor: ..._" when present) are re-attached
// verbatim from the slice files, so an agent can never alter a surface tag or a type marker. A case without a surface
// tag (the per-entity write-consistency cases) keeps just "- **ID** —".
// Part files whose name starts with "_" are ignored (scratch). Safe to re-run any time; partial progress is written.
//
// Usage: node merge.mjs --slices <dir> --parts <dir> --out <run dir>/fill-<name>.json [--snapshot <root>] [--missing]
//   --snapshot   repo-qualify every evidence reference (a token whose first path segment is not a snapshot repo dir
//                inherits the last repo named before it), so the evidence needs no context to resolve.
// Exit 0 = clean; 3 = problems were listed (the entries that parsed are still written, and apply_fills validates again).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCaseLine, placeholders, FILL_PLACEHOLDER, MARKERS as SUFFIX } from './lib/signature.mjs';

/** Every case of every slice file in a directory (files without a cases[] array, such as slices-index.json, are skipped). */
export function loadSliceCases(dir) {
  const cases = [];
  const seen = new Map();
  const problems = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { problems.push(`${f}: unreadable (${e.message.slice(0, 60)})`); continue; }
    if (!Array.isArray(j.cases)) continue;
    for (const c of j.cases) {
      if (seen.has(c.id)) { problems.push(`${f}: ${c.id}: also in ${seen.get(c.id)}`); continue; }
      seen.set(c.id, f);
      cases.push(c);
    }
  }
  return { cases, problems };
}

/** The verbatim prefix and suffix of a case's first line. */
export function splitCase(text) {
  const first = String(text).split(/\r?\n/)[0];
  const c = parseCaseLine(first);
  if (!c) throw new Error(`not a case line: ${first.slice(0, 80)}`);
  const sm = SUFFIX.exec(first);
  if (!sm) throw new Error(`no _type marker: ${first.slice(-80)}`);
  return { prefix: `- **${c.id}** —${c.tag ? ` ${c.tag.raw}` : ''}`, suffix: sm[1] };
}

export function repoQualifier(snapshotRoot) {
  const repos = new Set(fs.readdirSync(snapshotRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));
  return (ev) => {
    let cur = null;
    return ev.split(';').map((tok) => {
      const t = tok.trim();
      if (!t) return t;
      const first = t.split('/')[0];
      if (repos.has(first)) { cur = first; return t; }
      return cur ? `${cur}/${t}` : t;
    }).filter(Boolean).join('; ');
  };
}

/** Parse every part file and check each block against the case it fills. */
export function parseParts(partsDir, byId, normEv = (x) => x) {
  const fills = new Map();
  const problems = [];
  const files = fs.existsSync(partsDir) ? fs.readdirSync(partsDir).filter((f) => f.endsWith('.txt') && !f.startsWith('_')).sort() : [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(partsDir, file), 'utf8').replace(/\r\n/g, '\n');
    for (const b of raw.split(/^=== /m).slice(1)) {
      const nl = b.indexOf('\n');
      const head = (nl < 0 ? b : b.slice(0, nl)).trim();
      const [id, status] = head.split('|').map((s) => s.trim());
      const body = nl < 0 ? '' : b.slice(nl + 1);
      const evM = body.match(/^EV:([\s\S]*?)^TX:/m);
      const txM = body.match(/^TX:([\s\S]*)$/m);
      if (!evM || !txM) { problems.push(`${file}: ${id}: missing EV:/TX:`); continue; }
      if (!byId.has(id)) { problems.push(`${file}: ${id}: unknown case id`); continue; }
      const ev = normEv(evM[1].replace(/\s*\n\s*/g, ' ').trim());
      const mid = txM[1].replace(/\s*\n\s*/g, ' ').trim();
      const own = placeholders(byId.get(id).text).filter((p) => mid.includes(p));
      if (!['filled', 'none', 'finding'].includes(status)) problems.push(`${file}: ${id}: bad status "${status}"`);
      if (status === 'none') {
        if (!/^none — /.test(mid)) problems.push(`${file}: ${id}: none must start with "none — "`);
        else {
          const words = mid.replace(/^none — /, '').trim().split(/\s+/).length;
          if (words > 8) problems.push(`${file}: ${id}: none reason has ${words} words (>8)`);
        }
      }
      if (status !== 'none' && /^none — /.test(mid)) problems.push(`${file}: ${id}: status ${status} but text starts with none`);
      if (own.length) problems.push(`${file}: ${id}: still holds the scaffold's own placeholder ${own[0]}`);
      else if (FILL_PLACEHOLDER.test(mid)) problems.push(`${file}: ${id}: still holds a placeholder-looking token ${(mid.match(FILL_PLACEHOLDER) || [])[0]}`);
      if (/UNKNOWN/.test(mid)) problems.push(`${file}: ${id}: contains UNKNOWN`);
      if (mid.length < 40 && status !== 'none') problems.push(`${file}: ${id}: suspiciously short`);
      if (!ev) problems.push(`${file}: ${id}: empty evidence`);
      if (fills.has(id)) problems.push(`${file}: ${id}: duplicate (later wins)`);
      fills.set(id, { mid, evidence: ev, status });
    }
  }
  return { fills, problems, files };
}

export function mergeParts({ slicesDir, partsDir, out, snapshot = null }) {
  const { cases, problems: sliceProblems } = loadSliceCases(slicesDir);
  const byId = new Map(cases.map((c) => [c.id, c]));
  const normEv = snapshot ? repoQualifier(snapshot) : (x) => x;
  const { fills, problems } = parseParts(partsDir, byId, normEv);
  problems.unshift(...sliceProblems);
  const ordered = {};
  for (const c of cases) {
    const f = fills.get(c.id);
    if (!f) continue;
    try {
      const { prefix, suffix } = splitCase(c.text);
      ordered[c.id] = { text: `${prefix} ${f.mid} ${suffix}`, evidence: f.evidence, status: f.status };
    } catch (e) {
      problems.push(`${c.id}: ${e.message}`);
    }
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(ordered, null, 1), 'utf8');
  const counts = { filled: 0, none: 0, finding: 0 };
  for (const v of Object.values(ordered)) if (v.status in counts) counts[v.status] += 1;
  const missing = cases.filter((c) => !ordered[c.id]).map((c) => c.id);
  return { written: Object.keys(ordered).length, total: cases.length, counts, missing, problems };
}

function main() {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const o = { slicesDir: get('--slices'), partsDir: get('--parts'), out: get('--out'), snapshot: get('--snapshot') || null };
  if (!o.slicesDir || !o.partsDir || !o.out) {
    console.error('usage: node merge.mjs --slices <dir> --parts <dir> --out <run dir>/fill-<name>.json [--snapshot <root>] [--missing]');
    process.exit(2);
  }
  const r = mergeParts(o);
  console.log(`written ${r.written}/${r.total}`, JSON.stringify(r.counts), `missing=${r.missing.length}`);
  if (a.includes('--missing')) console.log('MISSING:', r.missing.join(','));
  if (r.problems.length) {
    console.log('PROBLEMS:');
    for (const p of r.problems) console.log(`  ${p}`);
    process.exit(3);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
