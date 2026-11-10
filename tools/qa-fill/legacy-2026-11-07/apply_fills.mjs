// Apply fill maps (fills/fill-*.json: { id: { text, evidence, status } }) to the generated registry fragments.
// Usage: node apply_fills.mjs [--write] [--fills <dir>] [--frag <file> ...]
//   default = dry run: validates every entry and reports, writes nothing.
//   --write   = backs each fragment up (<frag>.pre-fill.<ts>.bak) and replaces the case blocks in place; also writes
//               fills/fill-status.json (id -> {status, evidence, frag}) for the ledger (status "none" => result N/A).
// A case block = its "- **<id>** — ..." line plus any following lines indented with two spaces (sub-bullets).
// Validation per entry (all must hold, else the entry is REJECTED and the original stays):
//   1. the id exists exactly once in the fragments;
//   2. the text starts with "- **<id>** — ";
//   3. it keeps the original's "[S### path]" tag and its "_type: X_" marker;
//   4. it contains none of the ORIGINAL line's own placeholder tokens (e.g. "<the real filter>"), taken from the
//      original, so legitimate angle brackets in filled text (an <li>, Array<string>) are not flagged;
//   5. status is filled | none | finding, and a "none" case says "none —" with a reason.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FILLS = argVal('--fills', 'C:/Users/zsk54/AppData/Local/Temp/claude/145938591d8587d9/a13de84e-6a82-4ecd-9e10-a0dece670191/scratchpad/p36/fullqa/fills');
const FRAG_DIR = 'C:/Users/zsk54/OneDrive/Desktop/RevHERO/qa-test-cases/fragments';
const frags = args.reduce((acc, a, i) => (args[i - 1] === '--frag' ? [...acc, a] : acc), []);
const FRAGS = frags.length ? frags : [path.join(FRAG_DIR, 'zz-surfaces.md'), path.join(FRAG_DIR, 'zz-attribution.md')];

// ---- load fragments and index case blocks
const docs = FRAGS.map((f) => {
  const raw = fs.readFileSync(f, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  return { file: f, eol, lines: raw.split(/\r?\n/) };
});
const where = new Map(); // id -> [{doc, start, end}]  (end exclusive)
for (const d of docs) {
  for (let i = 0; i < d.lines.length; i += 1) {
    const m = /^- \*\*([A-Z0-9][A-Z0-9-]*)\*\* — /.exec(d.lines[i]);
    if (!m) continue;
    let end = i + 1;
    while (end < d.lines.length && /^ {2}\S/.test(d.lines[end])) end += 1;
    const list = where.get(m[1]) ?? [];
    list.push({ doc: d, start: i, end });
    where.set(m[1], list);
  }
}

// ---- load fill maps
const fillFiles = fs.readdirSync(FILLS).filter((f) => /^fill-.*\.json$/.test(f) && f !== 'fill-status.json');
const entries = [];
const loadErrors = [];
for (const f of fillFiles) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(FILLS, f), 'utf8'));
    for (const [id, v] of Object.entries(j)) entries.push({ id, ...v, src: f });
  } catch (e) {
    loadErrors.push(`${f}: ${e.message.slice(0, 80)}`);
  }
}

// ---- validate
const tagOf = (s) => (/\[S\d+ [^\]]*\]/.exec(s) || [''])[0];
const typeOf = (s) => (/_type:\s*[a-z-]+_\s*$/.exec(s) || [''])[0].trim();
const placeholdersOf = (s) => [...new Set(s.match(/<[^<>\n]{3,120}>/g) ?? [])];
const rejected = [];
const accepted = [];
const seen = new Set();
for (const e of entries) {
  const why = [];
  if (seen.has(e.id)) why.push('duplicate entry across fill maps');
  seen.add(e.id);
  const locs = where.get(e.id) ?? [];
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

const byStatus = {};
for (const a of accepted) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
console.log(`fill maps ${fillFiles.length}${loadErrors.length ? ` (unreadable: ${loadErrors.join(', ')})` : ''}; entries ${entries.length}; accepted ${accepted.length} ${JSON.stringify(byStatus)}; rejected ${rejected.length}`);
for (const r of rejected.slice(0, 40)) console.log(`  REJECT ${r.id} [${r.src}] ${r.why}`);
if (rejected.length > 40) console.log(`  ... ${rejected.length - 40} more`);

if (!WRITE) {
  console.log('dry run: nothing written (pass --write to apply)');
  process.exit(rejected.length ? 3 : 0);
}

// ---- apply: replace blocks bottom-up per doc so earlier indexes stay valid
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const touched = new Set();
for (const d of docs) {
  const mine = accepted.filter((a) => a.loc.doc === d).sort((x, y) => y.loc.start - x.loc.start);
  if (!mine.length) continue;
  fs.copyFileSync(d.file, `${d.file}.pre-fill.${ts}.bak`);
  for (const a of mine) d.lines.splice(a.loc.start, a.loc.end - a.loc.start, ...String(a.text).split('\n'));
  fs.writeFileSync(d.file, d.lines.join(d.eol));
  touched.add(path.basename(d.file));
}
const statusFile = path.join(FILLS, 'fill-status.json');
const prev = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : {};
for (const a of accepted) prev[a.id] = { status: a.status, evidence: a.evidence ?? '', frag: path.basename(a.loc.doc.file), src: a.src };
fs.writeFileSync(statusFile, JSON.stringify(prev, null, 1));
console.log(`applied ${accepted.length} to ${[...touched].join(', ')} (backups *.pre-fill.${ts}.bak); fill-status.json now holds ${Object.keys(prev).length} ids`);
