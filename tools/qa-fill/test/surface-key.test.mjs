import test from 'node:test';
import assert from 'node:assert/strict';
import { surfaceKey, indexInventory, caseKey, isPerEntity } from '../lib/surface-key.mjs';
import { parseCaseLine } from '../lib/signature.mjs';

const inv = {
  surfaces: [
    { id: 'S001', path: '/deals/search', verbs: [], kinds: ['COLLECTION'] },
    { id: 'S002', path: 'routes:/:id', verbs: ['PUT', 'GET'], kinds: ['RECORD', 'INPUT'] },
    { id: 'S003', path: 'routes:/dup', verbs: ['GET'], kinds: ['RECORD'] },
    { id: 'S004', path: 'routes:/dup', verbs: ['GET'], kinds: ['RECORD'] },
  ],
};

test('surfaceKey sorts verbs and kinds so order never changes identity', () => {
  assert.equal(surfaceKey(inv.surfaces[1]), 'routes:/:id | GET+PUT | INPUT+RECORD');
});

test('caseKey: tagged case -> surface key + signature', () => {
  const idx = indexInventory(inv);
  const k = caseKey(parseCaseLine('- **FE-SURF-001** — [S002 routes:/:id] reads <field> _type: backend_'), idx);
  assert.equal(k.reason, null);
  assert.equal(k.key, 'routes:/:id | GET+PUT | INPUT+RECORD || reads <P> _type: backend_');
});

test('caseKey reasons: per-entity, untagged, unknown surface, ambiguous surface', () => {
  const idx = indexInventory(inv);
  const perEntity = parseCaseLine('- **FE-SURF-900** — Enumerate EVERY path that writes `deals` ... _type: backend_');
  assert.equal(isPerEntity(perEntity), true);
  assert.equal(caseKey(perEntity, idx).reason, 'per-entity');
  assert.equal(caseKey(parseCaseLine('- **FE-SURF-901** — free text _type: backend_'), idx).reason, 'untagged');
  assert.equal(caseKey(parseCaseLine('- **FE-SURF-902** — [S999 /gone] x _type: backend_'), idx).reason, 'surface-not-in-inventory');
  assert.equal(caseKey(parseCaseLine('- **FE-SURF-903** — [S003 routes:/dup] x _type: backend_'), idx).reason, 'ambiguous-surface');
});
