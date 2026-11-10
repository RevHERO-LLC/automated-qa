#!/usr/bin/env node
// Slice the RESIDUAL of a carry-forward run for the bounded fill agents. Promoted from the 2026-11-07 run's
// make_slices.mjs (kept unchanged in legacy-2026-11-07/): same feature grouping, same case record, plus what the plan
// decided for the residual handoff:
//   - only residual.json ids are sliced (carried cases are already filled), each with its reason and addressing hint;
//   - it REFUSES unless the run's carry report matches the CURRENT registry inventory and the raw scaffold it ran on,
//     and the live fragment holds the same case ids as that scaffold. A full regeneration that skipped regenerate.mjs
//     therefore cannot hand the whole registry to agents by accident;
//   - --no-carry "<reason>" is the no-wedge override: it slices every case of the live fragment that still holds a fill
//     placeholder and records the reason in <run>/no-carry.json, so a broken carry-forward never blocks a deliberate run;
//   - slices are chunked (default 30 cases, one fresh short-lived agent each) and a PROJECTION line is printed before
//     anything is launched (agents x est-steps x est-context ~= tokens).
// Re-slicing is idempotent: cases that already hold a fill are skipped, and slice files from an earlier run are replaced.
//
// Usage: node make_slices.mjs --registry <qa-test-cases> --run <run dir> --out <slices dir>
//          [--size 30] [--ctx 60000] [--frag <live fragment>] [--no-carry "<reason>"]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readBlocks, needsFill } from './lib/signature.mjs';

// The 2026-11-07 feature grouping, unchanged (first match wins; the catch-all comes last).
export const SLICES = [
  ['inbox', /inbox|linkedin|unipile/i],
  ['campaign-deal', /campaign|deal|stage|csv|pipeline|import|merge-tag|template|workflow|sequence|outcome/i],
  ['messaging', /email|mailbox|sms|phone|voicemail|toky|twilio|signature|message|conversation|takeover|draft/i],
  ['account-settings', /auth|login|signup|register|password|onboarding|setup|settings|user|account|member|seat|billing|credit|plan|subscription|payment|notification|profile|api-key|impersonate|getting-started|welcome/i],
  ['growth-ai', /booking|calendar|judy|knowledge|kb|optimization|analytics|swarm|leadgen|lead|buy|siteforge|dashboard|metric|insight|report|ai|agent|prompt|purchase/i],
  ['integrations-admin', /.*/],
];

export function sliceOf(s) {
  const srcs = (s?.sources ?? []).filter((p) => !/user-fe-backend/i.test(p));
  const hay = `${s?.path ?? ''} ${srcs.join(' ')}`;
  if (/Super-Admin/i.test(hay)) return 'integrations-admin';
  for (const [name, re] of SLICES) if (re.test(hay)) return name;
  return 'integrations-admin';
}

// An untagged case (the per-entity write-consistency cases) has no surface; route it by its ENTITY NAME so it lands
// with the feature that owns the entity. Not by the whole text: the template's own boilerplate ("form, invite, import,
// admin action, ETL") would send every entity to campaign-deal (measured on the 11-07 residual: 134 of 134).
const ENTITY = /writes `([^`]+)`/;
const sliceOfCase = (b, surface) => {
  if (surface) return sliceOf(surface);
  const m = ENTITY.exec(b.body);
  return sliceOf({ path: m ? m[1] : b.body, sources: [] });
};

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const OWN = /^(?:[a-z-]+-\d+\.json|slices-index\.json)$/;

/** The guard: does the run's carry report describe the registry as it is NOW? */
export function checkCarryReport({ registry, run, frag }) {
  const problems = [];
  const reportFile = path.join(run, 'carry-report.json');
  if (!fs.existsSync(reportFile)) return { ok: false, problems: [`no carry report at ${reportFile}: run regenerate.mjs first`] };
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const inventory = path.join(registry, 'surface-inventory.json');
  if (!fs.existsSync(inventory)) problems.push(`no inventory at ${inventory}`);
  else if (sha(inventory) !== report.hashes.inventory) problems.push('the registry inventory changed after the carry-forward ran (was the extractor re-run on its own?)');
  const scaffold = report.paths && report.paths.scaffold;
  if (!scaffold || !fs.existsSync(scaffold)) problems.push(`the raw scaffold the carry-forward ran on is gone (${scaffold})`);
  else if (sha(scaffold) !== report.hashes.scaffold) problems.push(`the raw scaffold changed after the carry-forward ran (${scaffold})`);
  const live = frag || (report.paths && report.paths.frag);
  if (!problems.length) {
    const want = [...readBlocks(fs.readFileSync(scaffold, 'utf8')).keys()].sort().join('\n');
    const have = [...readBlocks(fs.readFileSync(live, 'utf8')).keys()].sort().join('\n');
    if (want !== have) problems.push(`the live fragment (${live}) does not hold the same case ids as the scaffold the carry-forward ran on`);
  }
  if (report.selfCheckProblems && report.selfCheckProblems.length) {
    // Not a refusal: a failed self-check already sent every case to residual, which is the safe outcome.
    report.warning = `the carry-forward self-check failed, so nothing was carried: ${report.selfCheckProblems[0]}`;
  }
  return { ok: !problems.length, problems, report, live };
}

export function projection(counts, ctx = 60000) {
  const steps = counts.map((n) => 2 * n + 10);
  const tokens = steps.reduce((a, s) => a + s * ctx, 0);
  const avg = counts.length ? Math.round(steps.reduce((a, s) => a + s, 0) / counts.length) : 0;
  const human = tokens >= 1e9 ? `${(tokens / 1e9).toFixed(2)}B` : `${(tokens / 1e6).toFixed(1)}M`;
  return { agents: counts.length, avgSteps: avg, ctx, tokens, line: `PROJECTION: ${counts.length} agents x ~${avg} steps x ~${Math.round(ctx / 1000)}K context ~= ${human} tokens (estimate; cache reads dominate)` };
}

export function makeSlices({ registry, run, out, size = 30, ctx = 60000, frag = null, noCarry = null }) {
  if (!Number.isInteger(size) || size < 1) throw new Error(`--size must be a positive integer (got ${size})`);
  let live = frag;
  let residual = null;
  let warning = null;
  if (noCarry === null) {
    const chk = checkCarryReport({ registry, run, frag });
    if (!chk.ok) {
      const e = new Error(`refusing to slice:\n  - ${chk.problems.join('\n  - ')}\nRun regenerate.mjs (it writes the carry report), or pass --no-carry "<reason>" to slice everything that still needs a fill.`);
      e.code = 'NO_MATCHING_CARRY_REPORT';
      throw e;
    }
    live = chk.live;
    warning = chk.report.warning || null;
    residual = JSON.parse(fs.readFileSync(path.join(run, 'residual.json'), 'utf8')).cases;
  } else {
    if (!String(noCarry).trim()) throw new Error('--no-carry needs a reason');
    live = live || path.join(registry, 'fragments', 'zz-surfaces.md');
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, 'no-carry.json'), JSON.stringify({ at: new Date().toISOString(), reason: String(noCarry), fragment: path.resolve(live) }, null, 1));
  }

  const inv = JSON.parse(fs.readFileSync(path.join(registry, 'surface-inventory.json'), 'utf8')).surfaces;
  const byId = new Map(inv.map((s) => [s.id, s]));
  const blocks = readBlocks(fs.readFileSync(live, 'utf8'));
  const wanted = residual
    ? residual.map((r) => ({ id: r.id, reason: r.reason, hint: r.hint || null }))
    : [...blocks.keys()].map((id) => ({ id, reason: 'no-carry', hint: null }));
  const groups = Object.fromEntries(SLICES.map(([n]) => [n, []]));
  let alreadyFilled = 0;
  for (const w of wanted) {
    const b = blocks.get(w.id);
    if (!b) throw new Error(`residual case ${w.id} is not in the live fragment ${live}`);
    const text = b.block.join('\n');
    if (!needsFill(text)) { if (residual) alreadyFilled += 1; continue; }
    const s = b.tag ? byId.get(b.tag.sid) : null;
    groups[sliceOfCase(b, s)].push({
      id: b.id, surface: b.tag ? b.tag.sid : null, path: b.tag ? b.tag.path : null, rendering: !!s?.rendering,
      sources: s?.sources ?? [], kinds: s?.kinds ?? [], text, reason: w.reason, hint: w.hint,
    });
  }

  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(out)) if (OWN.test(f)) fs.rmSync(path.join(out, f));
  const files = [];
  for (const [name, cases] of Object.entries(groups)) {
    for (let i = 0; i * size < cases.length; i += 1) {
      const part = cases.slice(i * size, (i + 1) * size);
      const file = `${name}-${i + 1}.json`;
      fs.writeFileSync(path.join(out, file), JSON.stringify({ slice: name, part: i + 1, count: part.length, cases: part }, null, 1));
      files.push({ file, slice: name, count: part.length });
    }
  }
  const total = files.reduce((a, f) => a + f.count, 0);
  const proj = projection(files.map((f) => f.count), ctx);
  const index = { generatedAt: new Date().toISOString(), mode: residual ? 'residual' : 'no-carry', noCarryReason: noCarry, fragment: path.resolve(live), size, total, alreadyFilled, warning, files, projection: proj };
  fs.writeFileSync(path.join(out, 'slices-index.json'), JSON.stringify(index, null, 1));
  return index;
}

function main() {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const o = { registry: get('--registry'), run: get('--run'), out: get('--out'), frag: get('--frag') || null, noCarry: a.includes('--no-carry') ? (get('--no-carry') ?? '') : null };
  if (get('--size')) o.size = Number(get('--size'));
  if (get('--ctx')) o.ctx = Number(get('--ctx'));
  if (!o.registry || !o.run || !o.out) {
    console.error('usage: node make_slices.mjs --registry <qa-test-cases> --run <run dir> --out <slices dir> [--size 30] [--ctx 60000] [--frag <live fragment>] [--no-carry "<reason>"]');
    process.exit(2);
  }
  try {
    const r = makeSlices(o);
    if (r.warning) console.log(`WARNING: ${r.warning}`);
    console.log(`${r.mode}: ${r.total} case(s) in ${r.files.length} slice(s) of <= ${r.size}${r.alreadyFilled ? `; ${r.alreadyFilled} residual case(s) already filled, skipped` : ''}`);
    for (const f of r.files) console.log(`  ${f.file} ${f.count}`);
    console.log(r.projection.line);
  } catch (e) {
    console.error(e.code === 'NO_MATCHING_CARRY_REPORT' ? `REFUSED: ${e.message}` : e.message);
    process.exit(e.code === 'NO_MATCHING_CARRY_REPORT' ? 3 : 1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
