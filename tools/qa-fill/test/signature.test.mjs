import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTag, parseCaseLine, signature, readBlocks, rehome, placeholders } from '../lib/signature.mjs';

test('splitTag finds the closing bracket by depth (Next.js dynamic segments)', () => {
  const r = splitTag('[S003 /(Auth)/invite/[id]] renders the invite _type: frontend_');
  assert.equal(r.tag.sid, 'S003');
  assert.equal(r.tag.path, '/(Auth)/invite/[id]');
  assert.equal(r.tag.raw, '[S003 /(Auth)/invite/[id]]');
  assert.equal(r.after, 'renders the invite _type: frontend_');
});

test('an unbalanced tag is treated as no tag (fails safe to residual)', () => {
  assert.equal(splitTag('[S004 /broken/[id renders _type: x_').tag, null);
});

test('signature ignores id, surface number, placeholder wording and actor marker; keeps type', () => {
  const a = '- **FE-SURF-0010** — [S045 /deals/search] renders <the EXACT empty-state copy from the code> when empty _type: frontend_';
  const b = '- **FE-SURF-2999** — [S512 /deals/search] renders <copy> when empty _type: frontend_ _actor: ADMIN / onBehalfOf: ADMIN_';
  assert.equal(signature(a), signature(b));
  const c = '- **FE-SURF-0010** — [S045 /deals/search] renders <x> when empty _type: backend_';
  assert.notEqual(signature(a), signature(c));
  assert.equal(signature(a), 'renders <P> when empty _type: frontend_');
});

test('parseCaseLine reads id, tag, body and type; non-case lines are null', () => {
  const c = parseCaseLine('- **FE-SURF-0123** — [S045 /x] body text _type: frontend_');
  assert.deepEqual([c.id, c.tag.sid, c.type], ['FE-SURF-0123', 'S045', 'frontend']);
  assert.equal(parseCaseLine('### heading'), null);
});

test('readBlocks attaches two-space sub-bullets and rejects duplicate ids', () => {
  const text = ['- **FE-SURF-001** — [S1 /a] one _type: frontend_', '  - sub one', '', '- **FE-SURF-002** — [S2 /b] two _type: frontend_'].join('\n');
  const b = readBlocks(text);
  assert.deepEqual(b.get('FE-SURF-001').block, ['- **FE-SURF-001** — [S1 /a] one _type: frontend_', '  - sub one']);
  assert.equal(b.get('FE-SURF-002').block.length, 1);
  assert.throws(() => readBlocks(text + '\n- **FE-SURF-002** — [S2 /b] again _type: frontend_'), /duplicate case id/);
});

test('rehome keeps the old body, swaps in the new id and the new surface tag, keeps sub-lines', () => {
  const old = '- **FE-SURF-005** — [S003 /(Auth)/invite/[id]] filled body _type: frontend_ _actor: ADMIN / onBehalfOf: ADMIN_\n  - detail';
  const out = rehome(old, 'FE-SURF-017', '[S011 /(Auth)/invite/[id]]');
  assert.equal(out, '- **FE-SURF-017** — [S011 /(Auth)/invite/[id]] filled body _type: frontend_ _actor: ADMIN / onBehalfOf: ADMIN_\n  - detail');
});

test('placeholders lists the remaining <...> tokens', () => {
  assert.deepEqual(placeholders('a <the real filter> b <x>'), ['<the real filter>', '<x>']);
  assert.deepEqual(placeholders('filled text'), []);
});
