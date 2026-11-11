#!/usr/bin/env node
// Carry prior QA fills onto a freshly regenerated scaffold (decided in the grill, plan foamy-petting-comet.md).
//
// A full inventory regeneration renumbers every FE-SURF case. For each regenerated case that needs a fill, find the
// same question about the same surface in the prior generation (surface path+verbs+kinds + template signature) and
// reuse its fill ONLY if nothing relevant changed:
//   layer 1  the surface is not in the extractor's touched set for the prior-vs-current snapshot diff, AND
//   layer 2  every file the prior fill cited is byte-identical between the prior and current snapshots.
// Everything else goes to RESIDUAL with a reason, for the bounded agent pass. A carried "finding" stays a finding.
//
// Usage:
//   node carry-forward.mjs --prior <fill-archive/<generation>> --scaffold <raw scaffold .md> --inventory <inventory.json>
//        --snapshot <current snapshot root> --contract <qa-contract.json> --out <run dir>
//        [--frag <live fragment.md>] [--extractor <qa-surface-inventory.js>] [--strict-router] [--write]
// Outputs in <run dir>: fill-carry.json (apply_fills format), residual.json, carry-report.json, carry-report.md.
// --write also applies the carried entries to --frag (default: the scaffold) through the same validator.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readBlocks, rehome, needsFill, MARKERS } from './lib/signature.mjs';
import { indexInventory, caseKey } from './lib/surface-key.mjs';
import { parseEvidence, resolveAgainstSnapshot, reposFromManifest, rewriteCitedLines } from './lib/evidence.mjs';
import { citedFilesUnchanged, snapshotDiff, touchedSurfaceKeys, relaxRouterDiff, remapCitedLines } from './lib/unchanged.mjs';
import { parseGinRoutes, hintFor } from './lib/routes.mjs';
import { checkExtractorSource, checkInventory, checkFragment } from './lib/selfcheck.mjs';
import { indexFragments, validateEntries, applyEntries } from './lib/apply.mjs';

export const DEFAULT_EXTRACTOR = path.join(os.homedir(), '.claude', 'scripts', 'qa-surface-inventory.js');
const BFF_ROUTER = 'RevHero-user-fe-backend/internal/routes/routes.go';
// Shared request plumbing of the BFF: every BFF route goes through it, and fills rarely cite it. If any non-test Go
// file here changed, every BFF route surface is residual (`plumbing-changed`). Found by the option C audit
// (2026-11-10): the 11-07 -> 11-10 drift changed the error helper (5xx data.error genericized) and added auth
// middleware; the whole-file router rule had re-asked those routes only because routes.go happened to change too.
export const BFF_PLUMBING = ['RevHero-user-fe-backend/internal/middleware/', 'RevHero-user-fe-backend/internal/helpers/',
  'RevHero-user-fe-backend/internal/config/', 'RevHero-user-fe-backend/cmd/'];

/** Changed non-test Go files under BFF_PLUMBING, read off the (unfiltered) snapshot diff. */
export function changedPlumbing(diffText) {
  const out = new Set();
  for (const line of diffText.split('\n')) {
    const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(line) || /^([^\s@+-][^\s]*\.go)$/.exec(line); // flat path = one-sided repo
    const p = m ? (m[2] || m[1]) : null;
    if (p && /\.go$/.test(p) && !/_test\.go$/.test(p) && BFF_PLUMBING.some((d) => p.startsWith(d))) out.add(p);
  }
  return [...out].sort();
}

export const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

/** The prior generation's files, or null when there is no usable prior generation. */
export function loadPrior(dir) {
  if (!dir) return null;
  const f = {
    inventory: path.join(dir, 'surface-inventory.json'),
    prefill: path.join(dir, 'zz-surfaces.md.pre-fill.bak'),
    filled: path.join(dir, 'zz-surfaces.md.filled'),
    status: path.join(dir, 'run', 'fills', 'fill-status.json'),
    snapshot: path.join(dir, 'snapshot'),
    manifest: path.join(dir, 'snapshot', '_manifest.tsv'),
  };
  const missing = Object.entries(f).filter(([, p]) => !fs.existsSync(p)).map(([k]) => k);
  if (missing.length) return { dir, missing };
  return {
    dir,
    generation: path.basename(dir),
    files: f,
    inventory: JSON.parse(fs.readFileSync(f.inventory, 'utf8')),
    prefill: readBlocks(fs.readFileSync(f.prefill, 'utf8')),
    filled: readBlocks(fs.readFileSync(f.filled, 'utf8')),
    status: JSON.parse(fs.readFileSync(f.status, 'utf8')),
    repos: reposFromManifest(f.manifest),
  };
}

function pageUrl(p) {
  return p.replace(/\/\([^)]*\)/g, '') || '/';
}

export function carryForward(o) {
  const extractor = o.extractor || DEFAULT_EXTRACTOR;
  const problems = [];
  const hashCache = new Map(); // layer-2 hashes, valid for THIS run only (see lib/unchanged.mjs fileHash)
  // ---- interface self-check: refuse loudly rather than mis-key silently
  const sx = checkExtractorSource(extractor);
  if (!sx.ok) problems.push(...sx.problems);
  const inventory = JSON.parse(fs.readFileSync(o.inventory, 'utf8'));
  const si = checkInventory(inventory);
  if (!si.ok) problems.push(...si.problems.map((p) => `inventory: ${p}`));
  const scaffoldText = fs.readFileSync(o.scaffold, 'utf8');
  const sf = checkFragment(scaffoldText);
  if (!sf.ok) problems.push(...sf.problems.map((p) => `scaffold: ${p}`));
  const contract = JSON.parse(fs.readFileSync(o.contract, 'utf8'));
  const sources = (contract.surfaces && contract.surfaces.source) || [];
  const offSnapshot = sources.filter((s) => !norm(s).startsWith(`${norm(o.snapshot)}/`));
  if (!sources.length || offSnapshot.length) problems.push(`contract surfaces.source must all live under --snapshot (${o.snapshot}); off: ${offSnapshot.slice(0, 2).join(', ') || '(none declared)'}`);
  const manifest = path.join(o.snapshot, '_manifest.tsv');
  const haveManifest = fs.existsSync(manifest);
  if (!haveManifest) problems.push(`the current snapshot has no _manifest.tsv (${manifest}); export it with snapshot-export.mjs`);

  const idx = indexInventory(inventory);
  const blocks = readBlocks(scaffoldText);
  const prior = loadPrior(o.prior);
  const priorUsable = prior && !prior.missing;
  const residual = [];
  const carried = [];
  let notFillTargets = 0;

  // ---- layer 1: the touched set (once for the whole scaffold). Option C (2026-11-10): inert hunks of the BFF router
  // (comments, outbound client wiring that feeds no security code) are dropped before the extractor sees the diff, and
  // a fill citing router LINES carries when no hunk overlaps them. --strict-router restores whole-file behavior.
  let touched = { all: true, keys: new Set(), mode: null, reason: 'not computed' };
  let relax = { info: {} };
  let plumbing = [];
  if (!problems.length && priorUsable) {
    const repos = new Set([...prior.repos, ...reposFromManifest(manifest)]);
    const diff = snapshotDiff(prior.files.snapshot, o.snapshot, [...repos]);
    plumbing = changedPlumbing(diff);
    relax = o.strictRouter ? { diffText: diff, info: {} } : relaxRouterDiff(diff, [BFF_ROUTER], prior.files.snapshot, o.snapshot);
    touched = touchedSurfaceKeys({ extractor, contract: o.contract, diffText: relax.diffText, scratchDir: path.join(o.out, 'touched'), expectedSurfaceCount: inventory.surfaces.length });
  }
  const routerInfo = relax.info[BFF_ROUTER] || null; // present only when the router changed and was relaxed
  const lineLevel = routerInfo ? { [BFF_ROUTER]: routerInfo } : null;
  const routerStats = { carriedViaLines: 0, evidenceRemapped: 0, textGuarded: 0, remapRefused: 0 };

  // ---- prior index: key -> prior case id; and which surfaces the prior generation had at all, so a case on a known
  // surface whose wording matches nothing there is reported as a template change rather than as a new case
  const priorByKey = new Map();
  const priorSurfaces = new Set();
  if (priorUsable) {
    const pidx = indexInventory(prior.inventory);
    for (const b of prior.prefill.values()) {
      const k = caseKey(b, pidx);
      if (k.key) priorByKey.set(k.key, priorByKey.has(k.key) ? null : b.id); // null = ambiguous
      if (k.key) priorSurfaces.add(k.surfaceKey);
    }
  }

  const routerPath = path.join(o.snapshot, BFF_ROUTER);
  const routes = fs.existsSync(routerPath) ? parseGinRoutes(fs.readFileSync(routerPath, 'utf8')) : { routes: [] };
  const hint = (sk) => {
    if (!sk) return null;
    const s = idx.byKey.get(sk);
    if (!s) return null;
    if (/^[^:/]+:\//.test(s.path)) return hintFor(s, routes);
    return { resolved: pageUrl(s.path), candidates: [pageUrl(s.path)] };
  };
  const isBffRoute = (sk) => {
    const s = sk ? idx.byKey.get(sk) : null;
    return !!s && (s.sources || []).some((p) => String(p).replace(/\\/g, '/').endsWith(BFF_ROUTER));
  };
  const toResidual = (b, k, reason, detail = '') => residual.push({ id: b.id, reason, detail, surfaceKey: k ? k.surfaceKey : null, hint: hint(k && k.surfaceKey) });

  for (const b of blocks.values()) {
    const blockText = b.block.join('\n');
    if (!needsFill(blockText)) {
      if (/<[^<>\n]+>/.test(blockText)) notFillTargets += 1; // template boilerplate such as "by-design: <reason>"
      continue;
    }
    const k = caseKey(b, idx);
    if (problems.length) { toResidual(b, k, 'self-check-failed', problems[0]); continue; }
    if (!priorUsable) { toResidual(b, k, 'no-prior-generation', prior ? `missing ${prior.missing.join(', ')}` : 'none given'); continue; }
    if (!k.key) { toResidual(b, k, k.reason); continue; }
    const priorId = priorByKey.get(k.key);
    if (priorId === undefined) { toResidual(b, k, priorSurfaces.has(k.surfaceKey) ? 'template-changed' : 'no-match'); continue; }
    if (priorId === null) { toResidual(b, k, 'ambiguous-match'); continue; }
    const st = prior.status[priorId];
    if (!st || !['filled', 'none', 'finding'].includes(st.status)) { toResidual(b, k, 'no-prior-fill', priorId); continue; }
    if (touched.all) { toResidual(b, k, 'surface-touched', touched.reason || 'touched set unavailable'); continue; }
    if (touched.keys.has(k.surfaceKey)) { toResidual(b, k, 'surface-touched'); continue; }
    if (plumbing.length && isBffRoute(k.surfaceKey)) { toResidual(b, k, 'plumbing-changed', plumbing.slice(0, 3).join(' | ')); continue; }
    const parsed = parseEvidence(st.evidence, prior.repos);
    if (parsed.uncited) { toResidual(b, k, 'no-evidence', priorId); continue; }
    const resolved = resolveAgainstSnapshot(parsed, prior.files.snapshot);
    if (resolved.unresolved.length) { toResidual(b, k, 'evidence-unresolved', resolved.unresolved.slice(0, 3).join(' | ')); continue; }
    const ch = citedFilesUnchanged(resolved.files, prior.files.snapshot, o.snapshot, hashCache, lineLevel);
    if (!ch.unchanged) { toResidual(b, k, 'source-changed', [...ch.changed, ...ch.missing].slice(0, 3).join(' | ')); continue; }
    const pf = prior.filled.get(priorId);
    if (!pf) { toResidual(b, k, 'no-prior-fill', `${priorId} absent from the filled fragment`); continue; }
    const priorText = pf.block.join('\n');
    let evidence = st.evidence;
    if (routerInfo && resolved.files.some((f) => `${f.repo}/${f.path}` === BFF_ROUTER)) {
      // Carried on router LINES although the file changed: the cited lines may have moved. Rewrite the citation to
      // the current file so the next generation checks the right lines; refuse when that cannot be done exactly.
      if (/routes\.go:\d/.test(priorText)) { routerStats.textGuarded += 1; toResidual(b, k, 'source-changed', `${BFF_ROUTER} (line numbers in the case text would go stale)`); continue; }
      const ev = rewriteCitedLines(st.evidence, prior.repos, prior.files.snapshot, BFF_ROUTER, (s) => remapCitedLines(s, routerInfo));
      if (ev === null) { routerStats.remapRefused += 1; toResidual(b, k, 'source-changed', `${BFF_ROUTER} (citation could not be remapped)`); continue; }
      routerStats.carriedViaLines += 1;
      if (ev !== st.evidence) routerStats.evidenceRemapped += 1;
      evidence = ev;
    }
    carried.push({ id: b.id, text: rehome(priorText, b.id, b.tag ? b.tag.raw : null, (MARKERS.exec(b.line) || [])[1] || null), evidence, status: st.status, carriedFrom: `${prior.generation}:${priorId}`, src: 'fill-carry.json' });
  }

  // ---- the apply validator decides; a rejection is residual, never a silent drop
  const frag = o.frag || o.scaffold;
  const fidx = indexFragments([frag]);
  const { accepted, rejected } = validateEntries(carried, fidx);
  for (const r of rejected) {
    const b = blocks.get(r.id);
    toResidual(b, caseKey(b, idx), 'apply-rejected', r.why);
  }

  fs.mkdirSync(o.out, { recursive: true });
  const fillMap = {};
  for (const a of accepted) fillMap[a.id] = { text: a.text, evidence: a.evidence, status: a.status, carriedFrom: a.carriedFrom };
  fs.writeFileSync(path.join(o.out, 'fill-carry.json'), JSON.stringify(fillMap, null, 1));
  residual.sort((x, y) => x.id.localeCompare(y.id, 'en', { numeric: true }));
  fs.writeFileSync(path.join(o.out, 'residual.json'), JSON.stringify({ generatedAt: new Date().toISOString(), count: residual.length, cases: residual }, null, 1));

  const byStatus = {};
  for (const a of accepted) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  const byReason = {};
  for (const r of residual) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
  const fillTargets = accepted.length + residual.length;
  const report = {
    generatedAt: new Date().toISOString(),
    prior: priorUsable ? prior.generation : null,
    selfCheckProblems: problems,
    hashes: {
      scaffold: sha256File(o.scaffold),
      inventory: sha256File(o.inventory),
      snapshotManifest: haveManifest ? sha256File(manifest) : null,
    },
    paths: { scaffold: path.resolve(o.scaffold), inventory: path.resolve(o.inventory), snapshot: path.resolve(o.snapshot), frag: path.resolve(frag) },
    touched: { all: touched.all, count: touched.keys.size, mode: touched.mode, reason: touched.reason },
    routerRelaxation: {
      file: BFF_ROUTER,
      strict: !!o.strictRouter,
      changed: !!routerInfo,
      reliable: routerInfo ? routerInfo.reliable : null,
      hunks: routerInfo ? routerInfo.hunks : 0,
      dropped: routerInfo ? routerInfo.dropped : 0,
      kept: routerInfo ? routerInfo.kept : 0,
      droppedHunks: routerInfo ? routerInfo.droppedHunks : [],
      keptHunks: routerInfo ? routerInfo.keptHunks : [],
      ...routerStats,
    },
    plumbingGuard: { dirs: BFF_PLUMBING, changedFiles: plumbing, residual: residual.filter((r) => r.reason === 'plumbing-changed').length },
    counts: { fillTargets, carried: accepted.length, carriedByStatus: byStatus, residual: residual.length, residualByReason: byReason, notFillTargets },
    carryRate: fillTargets ? Number((accepted.length / fillTargets).toFixed(4)) : 0,
  };
  fs.writeFileSync(path.join(o.out, 'carry-report.json'), JSON.stringify(report, null, 1));
  const md = [
    `# Carry-forward report (${report.generatedAt})`,
    '',
    `- Prior generation: ${report.prior || 'none'}`,
    `- Fill targets: ${fillTargets}; carried: ${accepted.length} (${(report.carryRate * 100).toFixed(1)}%) ${JSON.stringify(byStatus)}; residual: ${residual.length}`,
    `- Residual by reason: ${JSON.stringify(byReason)}`,
    `- Touched surfaces: ${touched.all ? `ALL (${touched.reason})` : `${touched.keys.size} (mode ${touched.mode})`}`,
    `- Router relaxation (routes.go): ${o.strictRouter ? 'OFF (--strict-router)' : !routerInfo ? 'router unchanged' : `${routerInfo.reliable ? '' : 'UNRELIABLE diff, nothing relaxed; '}${routerInfo.hunks} hunks, ${routerInfo.dropped} dropped as inert, ${routerInfo.kept} kept; carried on cited lines ${routerStats.carriedViaLines} (evidence remapped ${routerStats.evidenceRemapped}); refused: ${routerStats.textGuarded} text line refs, ${routerStats.remapRefused} unremappable`}`,
    ...(routerInfo && routerInfo.keptHunks.length ? routerInfo.keptHunks.slice(0, 10).map((h) => `  - kept: ${h}`) : []),
    `- BFF shared plumbing: ${plumbing.length ? `${plumbing.length} file(s) changed, so every BFF route case is residual (plumbing-changed): ${plumbing.slice(0, 6).join(', ')}${plumbing.length > 6 ? ', ...' : ''}` : 'unchanged'}`,
    problems.length ? `- SELF-CHECK FAILED: ${problems.join('; ')}` : '- Self-check: ok',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(o.out, 'carry-report.md'), md);

  let applied = null;
  if (o.write && accepted.length) applied = applyEntries(accepted, fidx, o.out);
  return { report, accepted, residual, applied };
}

function main() {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const o = {
    prior: get('--prior'), scaffold: get('--scaffold'), inventory: get('--inventory'), snapshot: get('--snapshot'),
    contract: get('--contract'), out: get('--out'), frag: get('--frag'), extractor: get('--extractor'), write: a.includes('--write'),
    strictRouter: a.includes('--strict-router'),
  };
  const need = ['scaffold', 'inventory', 'snapshot', 'contract', 'out'].filter((k) => !o[k]);
  if (need.length) {
    console.error(`missing ${need.map((k) => `--${k}`).join(' ')}\nusage: node carry-forward.mjs --prior <gen> --scaffold <raw.md> --inventory <inv.json> --snapshot <root> --contract <qa-contract.json> --out <dir> [--frag <live.md>] [--extractor <js>] [--strict-router] [--write]`);
    process.exit(2);
  }
  const r = carryForward(o);
  console.log(fs.readFileSync(path.join(o.out, 'carry-report.md'), 'utf8'));
  if (r.applied) console.log(`applied ${r.accepted.length} carried entries (backup *.pre-fill.${r.applied.ts}.bak)`);
  else if (o.write) console.log('nothing to apply');
  else console.log('dry run: nothing applied (pass --write)');
  if (r.report.selfCheckProblems.length) process.exit(4);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
