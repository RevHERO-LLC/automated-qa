// Slice the placeholder-bearing FE-SURF / FE-ATTR cases by feature for the fill agents. Writes one JSON per slice:
// { slice, cases:[{id, surface, path, sources, kinds, text}] }. Ready (placeholder-free) cases are listed separately.
import fs from 'node:fs';
const Q = 'C:/Users/zsk54/OneDrive/Desktop/RevHERO/qa-test-cases';
const OUT = 'C:/Users/zsk54/AppData/Local/Temp/claude/145938591d8587d9/a13de84e-6a82-4ecd-9e10-a0dece670191/scratchpad/p36/fullqa/slices';
const inv = JSON.parse(fs.readFileSync(`${Q}/surface-inventory.json`, 'utf8')).surfaces;
const byId = new Map(inv.map((s) => [s.id, s]));
const PH = /<(the|UNKNOWN|a |an |N>|real|exact|value|field|filter|status|product|entity|role|seed|count)[^>]*>/i;
const SLICES = [
  ['inbox', /inbox|linkedin|unipile/i],
  ['campaign-deal', /campaign|deal|stage|csv|pipeline|import|merge-tag|template|workflow|sequence|outcome/i],
  ['messaging', /email|mailbox|sms|phone|voicemail|toky|twilio|signature|message|conversation|takeover|draft/i],
  ['account-settings', /auth|login|signup|register|password|onboarding|setup|settings|user|account|member|seat|billing|credit|plan|subscription|payment|notification|profile|api-key|impersonate|getting-started|welcome/i],
  ['growth-ai', /booking|calendar|judy|knowledge|kb|optimization|analytics|swarm|leadgen|lead|buy|siteforge|dashboard|metric|insight|report|ai|agent|prompt|purchase/i],
  ['integrations-admin', /.*/],
];
const sliceOf = (s) => {
  const srcs = (s?.sources ?? []).filter((p) => !/user-fe-backend/i.test(p)); const hay = `${s?.path ?? ''} ${srcs.join(' ')}`;
  if (/Super-Admin/i.test(hay)) return 'integrations-admin';
  for (const [name, re] of SLICES) if (re.test(hay)) return name;
  return 'integrations-admin';
};
const out = Object.fromEntries(SLICES.map(([n]) => [n, []]));
const ready = [];
for (const frag of ['zz-surfaces.md', 'zz-attribution.md']) {
  const lines = fs.readFileSync(`${Q}/fragments/${frag}`, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = l.match(/^- \*\*(FE-(?:SURF|ATTR)-\d+)\*\* — (?:\[(S\d+) ([^\]]+)\])?/);
    if (!m) continue;
    let text = l; let j = i + 1;
    while (j < lines.length && /^\s{2,}- /.test(lines[j])) { text += '\n' + lines[j]; j++; }
    const s = m[2] ? byId.get(m[2]) : null;
    const rec = { id: m[1], frag, surface: m[2] ?? null, path: m[3] ?? null, rendering: !!s?.rendering, sources: s?.sources ?? [], kinds: s?.kinds ?? [], text };
    if (!PH.test(text)) { ready.push(rec); continue; }
    const sl = frag === 'zz-attribution.md' ? (sliceOf({ path: text, sources: [] })) : sliceOf(s);
    out[sl].push(rec);
  }
}
for (const [n, cases] of Object.entries(out)) fs.writeFileSync(`${OUT}/${n}.json`, JSON.stringify({ slice: n, count: cases.length, cases }, null, 1));
fs.writeFileSync(`${OUT}/ready.json`, JSON.stringify({ count: ready.length, cases: ready }, null, 1));
console.log(Object.entries(out).map(([n, c]) => `${n}=${c.length}`).join('  '), `ready=${ready.length}`);
