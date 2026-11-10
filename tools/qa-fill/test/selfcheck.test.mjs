import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { checkExtractorSource, checkInventory, checkFragment } from '../lib/selfcheck.mjs';
import { tmpDir, write, EXTRACTOR, HAVE_EXTRACTOR } from './helpers.mjs';

test('the real extractor still exposes everything the carry-forward depends on', { skip: !HAVE_EXTRACTOR && `extractor not found at ${EXTRACTOR}` }, () => {
  const r = checkExtractorSource(EXTRACTOR);
  assert.deepEqual(r.problems, []);
});

test('an extractor that lost its --touched flag is refused loudly', () => {
  const f = path.join(tmpDir(), 'fake-extractor.js');
  write(f, "if (a === '--contract') x; if (a === '--inventory') y; if (a === '--fragment') z; touchedResolution; surfaceIds;");
  const r = checkExtractorSource(f);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ["extractor no longer contains '--touched'"]);
});

test('checkInventory accepts the expected shape and names what is missing', () => {
  assert.equal(checkInventory({ surfaces: [{ id: 'S001', path: '/a', verbs: [], kinds: ['RECORD'], sources: [] }] }).ok, true);
  // Contract egress surfaces carry no verbs at all (S565-S569 on 11-07): accepted.
  assert.equal(checkInventory({ surfaces: [{ id: 'S565', path: 'egress:email', kinds: ['ARTIFACT'], sources: [] }] }).ok, true);
  const bad = checkInventory({ surfaces: [{ id: 'S001', path: '/a', verbs: 'GET', kinds: ['RECORD'], sources: [] }, { id: 'S001', path: '/b', verbs: [], kinds: [], sources: [] }] });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.includes('surface S001 has a non-array verbs'));
  assert.ok(bad.problems.includes('duplicate surface id S001'));
  assert.equal(checkInventory({}).ok, false);
});

test('checkFragment: duplicate ids, unbalanced tags, missing type and empty fragments are refused', () => {
  const good = '- **FE-SURF-001** — [S1 /a] x _type: frontend_\n- **FE-SURF-002** — free _type: backend_';
  assert.equal(checkFragment(good).ok, true);
  const bad = '- **FE-SURF-001** — [S1 /a] x _type: frontend_\n- **FE-SURF-001** — [S2 /b[ y\n';
  const r = checkFragment(bad);
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes('duplicate case id FE-SURF-001'));
  assert.ok(r.problems.includes('unbalanced surface tag on FE-SURF-001'));
  assert.equal(checkFragment('# nothing here').ok, false);
});
