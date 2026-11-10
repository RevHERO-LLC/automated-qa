// The two-layer "nothing relevant changed" check (decided in the grill, 2026-11-10). A prior fill is carried onto a
// regenerated case only if BOTH hold:
//   Layer 1  its SURFACE is not in the extractor's touched set for the code diff since the fill. The extractor's own
//            scoped mode (qa-surface-inventory.js --touched) does this with route line ranges: a re-pointed route or an
//            edit inside a route's range marks that surface; a hunk outside every range of a declaring file marks every
//            route of that file; a component-only source marks file-level. Reused read-only, never modified.
//   Layer 2  every file the fill CITED is byte-identical between the prior snapshot and the current one.
// Both layers compare two snapshot FOLDERS (the archived prior generation vs the current export), so nothing depends
// on old git versions surviving in local clones.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { indexInventory } from './surface-key.mjs';

const hashCache = new Map();

export function fileHash(p) {
  if (hashCache.has(p)) return hashCache.get(p);
  let h = null;
  try { h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { h = null; }
  hashCache.set(p, h);
  return h;
}

/** Layer 2. @returns {{unchanged: boolean, changed: string[], missing: string[]}} */
export function citedFilesUnchanged(files, oldRoot, newRoot) {
  const changed = [];
  const missing = [];
  for (const f of files) {
    const rel = `${f.repo}/${f.path}`;
    const a = fileHash(path.join(oldRoot, f.repo, f.path));
    const b = fileHash(path.join(newRoot, f.repo, f.path));
    if (a === null) missing.push(`${rel} (absent from the prior snapshot)`);
    else if (b === null) changed.push(`${rel} (deleted)`);
    else if (a !== b) changed.push(rel);
  }
  return { unchanged: changed.length === 0 && missing.length === 0 && files.length > 0, changed, missing };
}

const toPosix = (p) => path.resolve(p).replace(/\\/g, '/');

function commonAncestor(a, b) {
  const pa = toPosix(a).split('/');
  const pb = toPosix(b).split('/');
  const out = [];
  for (let i = 0; i < Math.min(pa.length, pb.length) && pa[i].toLowerCase() === pb[i].toLowerCase(); i++) out.push(pa[i]);
  if (!out.length || (out.length === 1 && out[0] === '')) return out.length ? '/' : null;   // POSIX root, or different drives
  return out.join('/');
}

// A bare Windows drive ("C:") as a cwd means "the current directory on C:", not the drive root.
const asCwd = (dir) => (/^[A-Za-z]:$/.test(dir) ? `${dir}/` : dir);

function listFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r); else out.push(r);
    }
  };
  walk(root, '');
  return out;
}

/**
 * Unified diff (zero context) of every repo between two snapshot roots, with paths normalized to "<repo>/<path>":
 * the extractor's --touched boundary match keys on exactly that suffix of its source paths. A repo present on only
 * one side is emitted as flat paths (whole-file touched), the conservative reading.
 */
export function snapshotDiff(oldRoot, newRoot, repos) {
  const anc = commonAncestor(oldRoot, newRoot);
  if (!anc) throw new Error(`snapshots have no common ancestor directory: ${oldRoot} vs ${newRoot}`);
  const strip = (p) => toPosix(p).slice(anc === '/' ? 1 : anc.length + 1);
  const relA = strip(oldRoot);
  const relB = strip(newRoot);
  let out = '';
  for (const repo of repos) {
    const inA = fs.existsSync(path.join(oldRoot, repo));
    const inB = fs.existsSync(path.join(newRoot, repo));
    if (!inA && !inB) continue;
    if (!inA || !inB) {
      for (const f of listFiles(path.join(inB ? newRoot : oldRoot, repo))) out += `${repo}/${f}\n`;
      continue;
    }
    const a = `${relA}/${repo}`;
    const b = `${relB}/${repo}`;
    const r = spawnSync('git', ['diff', '--no-index', '--no-renames', '--no-color', '--no-ext-diff', '-U0', '--', a, b],
      { cwd: asCwd(anc), encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    if (r.error) throw r.error;
    if (r.status !== 0 && r.status !== 1) throw new Error(`git diff --no-index failed for ${repo}: ${r.stderr}`);
    const fixA = `a/${a}/`;
    const fixB = `b/${b}/`;
    const lines = r.stdout.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) {
      out += (/^(diff --git |--- |\+\+\+ |Binary files )/.test(line)
        ? line.split(fixA).join(`a/${repo}/`).split(fixB).join(`b/${repo}/`)
        : line) + '\n';
    }
  }
  return out;
}

/**
 * Layer 1. Run the extractor in its scoped mode against the CURRENT snapshot (via `contract`) with the old->new diff,
 * entirely into scratch outputs, and return the touched surfaces as cross-generation keys.
 * Fails SAFE: if the extractor did not resolve a touched set, or its inventory does not match the expected surface
 * count (an unparseable router exits 0 with an empty floor by design), every surface is treated as touched.
 * @returns {{all: boolean, keys: Set<string>, mode: string|null, reason: string|null}}
 */
export function touchedSurfaceKeys({ extractor, contract, diffText, scratchDir, expectedSurfaceCount = null, node = process.execPath }) {
  fs.mkdirSync(scratchDir, { recursive: true });
  const diffFile = path.join(scratchDir, 'touched.diff');
  const inv = path.join(scratchDir, 'touched-inventory.json');
  const frag = path.join(scratchDir, 'touched-fragment.md');
  fs.writeFileSync(diffFile, diffText);
  const r = spawnSync(node, [extractor, '--contract', contract, '--inventory', inv, '--fragment', frag, '--touched', diffFile],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const fail = (reason) => ({ all: true, keys: new Set(), mode: null, reason });
  if (r.error || r.status !== 0) return fail(`extractor exited ${r.status}: ${(r.stderr || '').slice(0, 300)}`);
  let j;
  try { j = JSON.parse(fs.readFileSync(inv, 'utf8')); } catch (e) { return fail(`no touched inventory: ${e.message}`); }
  if (!j.touchedResolution || !Array.isArray(j.touchedResolution.surfaceIds)) return fail('extractor did not resolve a touched set');
  if (!Array.isArray(j.surfaces) || j.surfaces.length === 0) return fail('touched-run inventory has no surfaces');
  if (expectedSurfaceCount !== null && j.surfaces.length !== expectedSurfaceCount) {
    return fail(`touched-run inventory has ${j.surfaces.length} surfaces, expected ${expectedSurfaceCount}`);
  }
  const idx = indexInventory(j);
  const keys = new Set(j.touchedResolution.surfaceIds.map((id) => idx.bySid.get(id)).filter(Boolean));
  return { all: false, keys, mode: j.touchedResolution.mode || null, reason: null };
}
