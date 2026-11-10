// Merge fills/parts-growth-ai/*.txt (block format below) into fills/fill-growth-ai.json, re-attaching each case's
// original prefix ("- **ID** — [S### path]") and suffix ("_type: x_") from slices/growth-ai.json. Safe to re-run any time.
//
// Block format (no escaping needed):
//   === FE-SURF-131 | filled|none|finding
//   EV: file:line; file:line
//   TX: the middle of the bullet (may continue over following lines until the next "=== ")
//
// NOTE: the prefix is the original text up to the bracket that MATCHES the tag's opening '[' (the path may itself
// contain [slug] brackets). (An earlier sibling script started the depth scan one char late and dropped the prefix.)
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/zsk54/AppData/Local/Temp/claude/145938591d8587d9/a13de84e-6a82-4ecd-9e10-a0dece670191/scratchpad/p36/fullqa';
const PARTS = `${ROOT}/fills/parts-growth-ai`;
const OUT = `${ROOT}/fills/fill-growth-ai.json`;
const PH = /<(the|UNKNOWN|a |an |N>|real|exact|value|field|filter|status|product|entity|role|seed|count)[^>]*>/i;
const ANGLE = /<[A-Za-z_][^<>\n]{0,60}>/;

const cases = JSON.parse(fs.readFileSync(`${ROOT}/slices/growth-ai.json`, 'utf8')).cases;
const byId = new Map(cases.map((c) => [c.id, c]));

function split(text) {
  const m = text.match(/^(- \*\*[^*]+\*\* — )\[S\d+ /);
  if (!m) throw new Error('no tag: ' + text.slice(0, 80));
  const open = m[1].length; // index of the tag's '['
  let depth = 0; let end = -1;
  for (let k = open; k < text.length; k++) {
    if (text[k] === '[') depth++;
    else if (text[k] === ']') { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end < 0) throw new Error('unbalanced tag: ' + text.slice(0, 80));
  const prefix = text.slice(0, end + 1);
  const sm = text.match(/(\s)(_type: [^_]+_(?:\s+_actor: [^_]+_)?)\s*$/);
  if (!sm) throw new Error('no suffix: ' + text.slice(-80));
  return { prefix, suffix: sm[2] };
}

const fills = new Map();
const problems = [];
const files = fs.existsSync(PARTS) ? fs.readdirSync(PARTS).filter((f) => f.endsWith('.txt')).sort() : [];
for (const file of files) {
  const raw = fs.readFileSync(path.join(PARTS, file), 'utf8').replace(/\r\n/g, '\n');
  const blocks = raw.split(/^=== /m).slice(1);
  for (const b of blocks) {
    const nl = b.indexOf('\n');
    const head = b.slice(0, nl).trim();
    const [id, status] = head.split('|').map((s) => s.trim());
    const body = b.slice(nl + 1);
    const evM = body.match(/^EV:([\s\S]*?)^TX:/m);
    const txM = body.match(/^TX:([\s\S]*)$/m);
    if (!evM || !txM) { problems.push(`${file}: ${id}: missing EV:/TX:`); continue; }
    const ev = evM[1].replace(/\s*\n\s*/g, ' ').trim();
    const mid = txM[1].replace(/\s*\n\s*/g, ' ').trim();
    if (!byId.has(id)) { problems.push(`${file}: ${id}: unknown case id`); continue; }
    if (!['filled', 'none', 'finding'].includes(status)) problems.push(`${file}: ${id}: bad status "${status}"`);
    if (status === 'none' && !/^none — /.test(mid)) problems.push(`${file}: ${id}: none must start with "none — "`);
    if (status !== 'none' && /^none — /.test(mid)) problems.push(`${file}: ${id}: status ${status} but text starts with none`);
    if (PH.test(mid)) problems.push(`${file}: ${id}: still holds a placeholder-looking <...> token`);
    else if (ANGLE.test(mid)) problems.push(`${file}: ${id}: contains an angle-bracket token ${(mid.match(ANGLE) || [])[0]}`);
    if (/UNKNOWN/.test(mid)) problems.push(`${file}: ${id}: contains UNKNOWN`);
    if (mid.length < 40 && status !== 'none') problems.push(`${file}: ${id}: suspiciously short`);
    if (!ev) problems.push(`${file}: ${id}: empty evidence`);
    if (fills.has(id)) problems.push(`${file}: ${id}: duplicate (later wins)`);
    fills.set(id, { mid, evidence: ev, status });
  }
}

const out = {};
for (const [id, f] of fills) {
  const c = byId.get(id);
  const { prefix, suffix } = split(c.text);
  out[id] = { text: `${prefix} ${f.mid} ${suffix}`, evidence: f.evidence, status: f.status };
}
const ordered = {};
for (const c of cases) if (out[c.id]) ordered[c.id] = out[c.id];
fs.writeFileSync(OUT, JSON.stringify(ordered, null, 1));

const counts = { filled: 0, none: 0, finding: 0 };
for (const v of Object.values(ordered)) counts[v.status]++;
const missing = cases.filter((c) => !ordered[c.id]).map((c) => c.id);
console.log(`written ${Object.keys(ordered).length}/${cases.length}`, JSON.stringify(counts), `missing=${missing.length}`);
if (process.argv.includes('--missing')) console.log('MISSING:', missing.join(','));
if (problems.length) { console.log('PROBLEMS:'); for (const p of problems) console.log('  ' + p); }
