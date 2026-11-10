// Validate and apply fill maps ({id: {text, evidence, status}}) to registry fragments.
//
// Promoted from the 2026-11-07 run's apply_fills.mjs (kept unchanged in legacy-2026-11-07/) with the SAME rules, made
// importable so carry-forward can pre-check its own entries and route any rejection to residual instead of losing it.
// A case block = its "- **<id>** — ..." line plus any following lines indented with two spaces (sub-bullets).
// Validation per entry (all must hold, else the entry is REJECTED and the original stays):
//   1. the id exists exactly once in the fragments;
//   2. the text starts with "- **<id>** — ";
//   3. it keeps the original's "[S### path]" tag and its "_type: X_" marker;
//   4. it contains none of the ORIGINAL line's own placeholder tokens (taken from the original, so legitimate angle
//      brackets in filled text such as an <li> or Array<string> are not flagged);
//   5. status is filled | none | finding, and a "none" case says "none — <reason>".

import fs from 'node:fs';
import path from 'node:path';

const ID_LINE = /^- \*\*([A-Z0-9][A-Z0-9-]*)\*\* — /;
const tagOf = (s) => (/\[S\d+ [^\]]*\]/.exec(s) || [''])[0];
const typeOf = (s) => (/_type:\s*[a-z-]+_\s*$/.exec(s) || [''])[0].trim();
const placeholdersOf = (s) => [...new Set(s.match(/<[^<>\n]{3,120}>/g) ?? [])];

export function indexFragments(fragFiles) {
  const docs = fragFiles.map((f) => {
    const raw = fs.readFileSync(f, 'utf8');
    return { file: f, eol: raw.includes('\r\n') ? '\r\n' : '\n', lines: raw.split(/\r?\n/) };
  });
  const where = new Map(); // id -> [{doc, start, end}]  (end exclusive)
  for (const d of docs) {
    for (let i = 0; i < d.lines.length; i += 1) {
      const m = ID_LINE.exec(d.lines[i]);
      if (!m) continue;
      let end = i + 1;
      while (end < d.lines.length && /^ {2}\S/.test(d.lines[end])) end += 1;
      const list = where.get(m[1]) ?? [];
      list.push({ doc: d, start: i, end });
      where.set(m[1], list);
    }
  }
  return { docs, where };
}

export function loadFillMaps(fillsDir) {
  const files = fs.readdirSync(fillsDir).filter((f) => /^fill-.*\.json$/.test(f) && f !== 'fill-status.json').sort();
  const entries = [];
  const loadErrors = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(fillsDir, f), 'utf8'));
      for (const [id, v] of Object.entries(j)) entries.push({ id, ...v, src: f });
    } catch (e) {
      loadErrors.push(`${f}: ${e.message.slice(0, 80)}`);
    }
  }
  return { files, entries, loadErrors };
}

export function validateEntries(entries, index) {
  const rejected = [];
  const accepted = [];
  const seen = new Set();
  for (const e of entries) {
    const why = [];
    if (seen.has(e.id)) why.push('duplicate entry across fill maps');
    seen.add(e.id);
    const locs = index.where.get(e.id) ?? [];
    if (locs.length !== 1) why.push(`id found ${locs.length} times in the fragments`);
    const text = String(e.text ?? '');
    const first = text.split('\n')[0];
    if (!first.startsWith(`- **${e.id}** — `)) why.push('text does not start with "- **<id>** — "');
    if (!['filled', 'none', 'finding'].includes(e.status)) why.push(`bad status "${e.status}"`);
    if (locs.length === 1) {
      const orig = locs[0].doc.lines[locs[0].start];
      if (tagOf(orig) && tagOf(first) !== tagOf(orig)) why.push(`surface tag changed (${tagOf(orig)} -> ${tagOf(first) || 'none'})`);
      if (typeOf(orig) && typeOf(first) !== typeOf(orig)) why.push(`type marker changed (${typeOf(orig)} -> ${typeOf(first) || 'none'})`);
      const left = placeholdersOf(orig).filter((p) => text.includes(p));
      if (left.length) why.push(`placeholders left: ${left.slice(0, 3).join(' ')}`);
    }
    if (e.status === 'none' && !/\bnone\s+—\s+\S/.test(first)) why.push('status none but no "none — <reason>"');
    if (why.length) rejected.push({ id: e.id, src: e.src, why: why.join('; ') });
    else accepted.push({ ...e, loc: locs[0] });
  }
  return { accepted, rejected };
}

/** Replace blocks bottom-up per document (earlier indexes stay valid), back each document up first, merge statuses. */
export function applyEntries(accepted, index, fillsDir) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const touched = [];
  for (const d of index.docs) {
    const mine = accepted.filter((a) => a.loc.doc === d).sort((x, y) => y.loc.start - x.loc.start);
    if (!mine.length) continue;
    fs.copyFileSync(d.file, `${d.file}.pre-fill.${ts}.bak`);
    for (const a of mine) d.lines.splice(a.loc.start, a.loc.end - a.loc.start, ...String(a.text).split('\n'));
    fs.writeFileSync(d.file, d.lines.join(d.eol));
    touched.push(path.basename(d.file));
  }
  const statusFile = path.join(fillsDir, 'fill-status.json');
  const prev = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : {};
  for (const a of accepted) {
    prev[a.id] = { status: a.status, evidence: a.evidence ?? '', frag: path.basename(a.loc.doc.file), src: a.src, ...(a.carriedFrom ? { carriedFrom: a.carriedFrom } : {}) };
  }
  fs.writeFileSync(statusFile, JSON.stringify(prev, null, 1));
  return { ts, touched, statusCount: Object.keys(prev).length };
}
