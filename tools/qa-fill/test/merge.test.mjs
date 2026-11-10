import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mergeParts, splitCase } from '../merge.mjs';
import { tmpDir, write } from './helpers.mjs';

const C1 = '- **FE-SURF-101** — [S045 /(dashboard)/deals/[id]] For <field>=<real value>, the page displays <the exact rendered string>. _type: frontend_ _actor: ADMIN / onBehalfOf: ADMIN_';
const C2 = '- **FE-SURF-102** — [S046 routes:/list] Rows on `routes:/list` render in <the real sort order>; for a tie, <the real tiebreak>. _type: frontend_';
const C3 = '- **FE-SURF-103** — Enumerate EVERY path that writes `deals`. For EACH path, assert the resulting row\'s <the real status field>. _type: backend_';

test('splitCase keeps nested-bracket tags, the actor marker, and untagged cases verbatim', () => {
  assert.deepEqual(splitCase(C1), { prefix: '- **FE-SURF-101** — [S045 /(dashboard)/deals/[id]]', suffix: '_type: frontend_ _actor: ADMIN / onBehalfOf: ADMIN_' });
  assert.deepEqual(splitCase(C3), { prefix: '- **FE-SURF-103** —', suffix: '_type: backend_' });
  assert.throws(() => splitCase('- **FE-SURF-104** — [S1 /a] no marker'), /no _type marker/);
});

function fixture(partText) {
  const root = tmpDir();
  const slices = path.join(root, 'slices');
  write(path.join(slices, 'campaign-deal-1.json'), JSON.stringify({ slice: 'campaign-deal', part: 1, count: 2, cases: [{ id: 'FE-SURF-101', text: C1 }, { id: 'FE-SURF-102', text: C2 }] }));
  write(path.join(slices, 'integrations-admin-1.json'), JSON.stringify({ slice: 'integrations-admin', part: 1, count: 1, cases: [{ id: 'FE-SURF-103', text: C3 }] }));
  write(path.join(slices, 'slices-index.json'), JSON.stringify({ files: [] }));
  const parts = path.join(root, 'parts');
  write(path.join(parts, 'a.txt'), partText);
  write(path.join(parts, '_scratch.txt'), '=== FE-SURF-101 | filled\nEV: x\nTX: ignored because the file starts with an underscore\n');
  const snap = path.join(root, 'snap');
  fs.mkdirSync(path.join(snap, 'RevHero-campaign-service'), { recursive: true });
  return { root, slices, parts, snap, out: path.join(root, 'run', 'fill-agents.json') };
}

test('a clean merge re-attaches prefix and suffix, repo-qualifies evidence and keeps slice order', () => {
  const fx = fixture([
    '=== FE-SURF-102 | finding',
    'EV: RevHero-campaign-service/internal/x.go:10; y.go:20',
    'TX: Rows render newest first by `created_at DESC` and there is NO tiebreak. DEFECT to file: add `id DESC`.',
    '=== FE-SURF-101 | filled',
    'EV: RevHero-campaign-service/internal/deal.go:5',
    'TX: For `amount`=1200 the deal page displays `$1,200`',
    'on the summary card.',
    '',
  ].join('\r\n'));
  const r = mergeParts({ slicesDir: fx.slices, partsDir: fx.parts, out: fx.out, snapshot: fx.snap });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.counts, { filled: 1, none: 0, finding: 1 });
  assert.deepEqual(r.missing, ['FE-SURF-103']);
  const out = JSON.parse(fs.readFileSync(fx.out, 'utf8'));
  assert.deepEqual(Object.keys(out), ['FE-SURF-101', 'FE-SURF-102']);
  assert.equal(out['FE-SURF-101'].text, '- **FE-SURF-101** — [S045 /(dashboard)/deals/[id]] For `amount`=1200 the deal page displays `$1,200` on the summary card. _type: frontend_ _actor: ADMIN / onBehalfOf: ADMIN_');
  assert.equal(out['FE-SURF-102'].evidence, 'RevHero-campaign-service/internal/x.go:10; RevHero-campaign-service/y.go:20');
});

test('every legacy check fires, and the merge still writes what parsed', () => {
  const fx = fixture([
    '=== FE-SURF-101 | filled',
    'EV: R/a.go:1',
    'TX: For `amount`=1200 the page displays <the exact rendered string> for this record.',
    '=== FE-SURF-102 | none',
    'EV: R/b.go:2',
    'TX: none — this template does not apply to a list route at all',
    '=== FE-SURF-103 | done',
    'EV:',
    'TX: short',
    '=== FE-SURF-999 | filled',
    'EV: R/c.go:3',
    'TX: an id no slice holds, which must be reported rather than merged anywhere',
    '=== FE-SURF-101 | filled',
    'TX: missing its evidence line entirely so it cannot be parsed',
    '=== FE-SURF-102 | filled',
    'EV: R/b.go:2',
    'TX: none — wrong status for a none text',
    '',
  ].join('\n'));
  const r = mergeParts({ slicesDir: fx.slices, partsDir: fx.parts, out: fx.out });
  const p = r.problems.join('\n');
  assert.match(p, /FE-SURF-101: still holds the scaffold's own placeholder <the exact rendered string>/);
  assert.match(p, /FE-SURF-102: none reason has 11 words \(>8\)/);
  assert.match(p, /FE-SURF-103: bad status "done"/);
  assert.match(p, /FE-SURF-103: suspiciously short/);
  assert.match(p, /FE-SURF-103: empty evidence/);
  assert.match(p, /FE-SURF-999: unknown case id/);
  assert.match(p, /FE-SURF-101: missing EV:\/TX:/);
  assert.match(p, /FE-SURF-102: status filled but text starts with none/);
  assert.match(p, /FE-SURF-102: duplicate \(later wins\)/);
  assert.equal(r.written, 3);
});

test('a generic placeholder-looking token and UNKNOWN are flagged even when the scaffold did not hold them', () => {
  const fx = fixture('=== FE-SURF-101 | filled\nEV: R/a.go:1\nTX: For <the real field> the page shows UNKNOWN text until it loads properly.\n');
  const p = mergeParts({ slicesDir: fx.slices, partsDir: fx.parts, out: fx.out }).problems.join('\n');
  assert.match(p, /placeholder-looking token <the real field>/);
  assert.match(p, /contains UNKNOWN/);
});
