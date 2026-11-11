// Parse the free-text `evidence` field of a QA fill (fill-status.json / fill-*.json) into the source files it cites.
//
// Format produced by the 2026-11-07 fill agents, e.g.
//   "RevHero-FE-New/components/invite/InvitePage.tsx:43-60,66-88; components/invite/InviteDetails.tsx:160-205;
//    RevHero-users-service/internal/resources/account_resource/account.service.go:388-411 (response shape data.invitation)"
// - A path whose first segment is a known repo starts a new repo context.
// - A path without a repo prefix inherits the most recent repo context.
// - A bare file name (no "/") is resolved later against the snapshot, and only if exactly one file has that name.
// - Notes in parentheses and anything that is not a source-file path are ignored.
// A fill with no resolvable code citation can never be validated as unchanged, so it is never carried forward.

import fs from 'node:fs';
import path from 'node:path';

// GitHub renames whose local clone and snapshot directory keep the old name.
export const REPO_ALIASES = Object.freeze({
  'RevHero-booking-service': 'RevHero-calendar-service',
});

const EXT = 'go|tsx?|jsx?|mjs|cjs|json|sql|ya?ml|py|sh|md|css|scss|html|toml|proto';
const SOURCE_EXT = new RegExp(`\\.(${EXT})$`, 'i');
// ":43-60,66-88" after a path; one named group per branch so each branch reads its own.
const lines = (name) => `(?::(?<${name}>\\d+(?:\\s*[-–]\\s*\\d+)?(?:\\s*,\\s*\\d+(?:\\s*[-–]\\s*\\d+)?)*))?`;
// A plain path token (no spaces). Segment characters include the parentheses and brackets of Next.js route groups
// and dynamic segments ("app/(dashboard)/deals/[id]/page.tsx").
const SEG = '[A-Za-z0-9_.()\\[\\]@+~-]+';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Patterns seen in the 2026-11-07 evidence (1,799 fills):
 *   "Repo/dir/file.go:1-9"            repo-anchored path, may contain spaces in folder names ("Stage Actions")
 *   "Repo dir/file.go:1-9", "Repo file.go"   repo named on its own, then a path: sets the repo context
 *   "dir/file.go:1-9", "file.go"      no repo: inherits the most recent repo context
 * @param {string} evidence  the raw evidence string
 * @param {Set<string>} repos  repo directory names present in the snapshot (e.g. from _manifest.tsv)
 * @returns {{files: {repo:string, path:string, lines:string|null}[], unresolved: string[], uncited: boolean}}
 */
export function parseEvidence(evidence, repos) {
  const files = [];
  const unresolved = [];
  if (!evidence || typeof evidence !== 'string') return { files, unresolved, uncited: true };
  // A file cited more than once keeps EVERY range: the line-level router check must see all of them (6 archived fills
  // cite routes.go twice with different lines; keeping only the first would hide an edit to the second).
  const byKey = new Map();
  for (const c of citations(evidence, repos)) {
    if (c.unresolved) { unresolved.push(c.unresolved); continue; }
    const ln = c.lines ? c.lines.replace(/\s+/g, '') : null;
    const key = `${c.repo}/${c.path}`;
    if (byKey.has(key)) { byKey.get(key).lines = mergeLines(byKey.get(key).lines, ln); continue; }
    const f = { repo: c.repo, path: c.path, lines: ln };
    byKey.set(key, f);
    files.push(f);
  }
  return { files, unresolved, uncited: files.length === 0 };
}

/** Two line specs of one file; a mention without lines means the whole file. */
export const mergeLines = (a, b) => (a === null || b === null ? null : `${a},${b}`);

/**
 * Rewrite the line spec of every citation that resolves (in `snapshotRoot`) to `targetRel` ("<repo>/<path>") with
 * `map(spec)`, leaving every other character of the evidence as it was. Same tokenizer and repo-context rules as
 * parseEvidence. Returns null when a citation of the target has no lines or `map` refuses one (returns null).
 */
export function rewriteCitedLines(evidence, repos, snapshotRoot, targetRel, map) {
  if (!evidence || typeof evidence !== 'string') return evidence;
  let out = '';
  let last = 0;
  for (const c of citations(evidence, repos)) {
    if (c.unresolved) continue;
    const r = resolveAgainstSnapshot({ files: [{ repo: c.repo, path: c.path, lines: null }], unresolved: [] }, snapshotRoot);
    if (!r.files.length || `${r.files[0].repo}/${r.files[0].path}` !== targetRel) continue;
    if (!c.at) return null;
    const next = map(c.lines.replace(/\s+/g, ''));
    if (next === null || next === undefined) return null;
    out += evidence.slice(last, c.at[0]) + next;
    last = c.at[1];
  }
  return out + evidence.slice(last);
}

/** Citations in order, with the repo context applied and the [start, end) offsets of each line spec. */
function citations(evidence, repos) {
  const text = evidence.replace(/\\/g, '/'); // same length, so offsets map onto the original string
  const known = [...repos, ...Object.keys(REPO_ALIASES)];
  const names = known.sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  const canon = (r) => REPO_ALIASES[r] || r;
  const re = new RegExp(
    // 1. repo-anchored path; folder names may contain spaces ("Stage Actions"); ends at the first source extension
    `(?<arepo>${names})\\/(?<apath>[^;,()\\n]+?\\.(?:${EXT}))${lines('alines')}(?=$|[:\\s;,()])`
    // 2. a repo named on its own ("RevHero-leadgen-service jobs.service.go") sets the context
    + `|\\b(?<bare>${names})\\b(?!\\/)`
    // 3. a plain path without spaces, inheriting the context
    + `|(?<plain>(?:${SEG}\\/)*${SEG}\\.[A-Za-z0-9]+)${lines('plines')}`,
    'gd');
  const out = [];
  let currentRepo = null;
  const cite = (repo, rel, ln, at) => out.push({ repo, path: rel, lines: ln || null, at: ln && at ? at : null });
  for (const m of text.matchAll(re)) {
    const g = m.groups;
    const ix = m.indices.groups;
    if (g.arepo) {
      currentRepo = canon(g.arepo);
      cite(currentRepo, g.apath.trim(), g.alines, ix.alines);
    } else if (g.bare) {
      currentRepo = canon(g.bare);
    } else if (g.plain) {
      if (!SOURCE_EXT.test(g.plain)) continue;
      const segs = g.plain.split('/');
      if (segs.length > 1 && known.includes(segs[0])) {
        currentRepo = canon(segs[0]);
        cite(currentRepo, segs.slice(1).join('/'), g.plines, ix.plines);
      } else if (currentRepo) cite(currentRepo, g.plain, g.plines, ix.plines);
      else out.push({ unresolved: g.plain });
    }
  }
  return out;
}

const basenameIndex = new Map(); // `${root}|${repo}` -> Map(basename -> [relative paths])

function indexRepo(snapshotRoot, repo) {
  const key = `${snapshotRoot}|${repo}`;
  if (basenameIndex.has(key)) return basenameIndex.get(key);
  const idx = new Map();
  const base = path.join(snapshotRoot, repo);
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else {
        const list = idx.get(e.name) || [];
        list.push(r);
        idx.set(e.name, list);
      }
    }
  };
  walk(base, '');
  basenameIndex.set(key, idx);
  return idx;
}

/**
 * Resolve parsed citations against a snapshot. A cited path must exist there, or be the UNIQUE path in the cited repo
 * that ends with it (agents often dropped leading folders: "tabs/BlockedDomains.tsx", or wrote a bare file name).
 * A citation that is ambiguous, absent, or names the wrong repo stays unresolved, and the caller sends the fill to
 * residual: never guess which file a fill depended on.
 * @returns {{files: {repo:string, path:string, lines:string|null}[], unresolved: string[]}}
 */
export function resolveAgainstSnapshot(parsed, snapshotRoot) {
  const files = [];
  const unresolved = [...parsed.unresolved];
  const byKey = new Map();
  // A file can be cited twice in different spellings (full path, then bare name); dedupe AFTER resolution, keeping
  // every cited range (mergeLines).
  const keep = (f) => {
    const k = `${f.repo}/${f.path}`;
    if (byKey.has(k)) { byKey.get(k).lines = mergeLines(byKey.get(k).lines, f.lines); return; }
    const g = { ...f };
    byKey.set(k, g);
    files.push(g);
  };
  for (const f of parsed.files) {
    const abs = path.join(snapshotRoot, f.repo, f.path);
    if (fs.existsSync(abs)) { keep(f); continue; }
    const base = f.path.split('/').pop();
    const hits = (indexRepo(snapshotRoot, f.repo).get(base) || []).filter((p) => p === f.path || p.endsWith(`/${f.path}`));
    if (hits.length === 1) { keep({ ...f, path: hits[0] }); continue; }
    unresolved.push(`${f.repo}/${f.path}`);
  }
  return { files, unresolved };
}

/** Repo names from a snapshot's _manifest.tsv (first column, header skipped). */
export function reposFromManifest(manifestPath) {
  const lines = fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/).slice(1);
  return new Set(lines.map((l) => l.split('\t')[0]).filter(Boolean));
}
