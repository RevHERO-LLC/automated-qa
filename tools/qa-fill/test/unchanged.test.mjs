import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { citedFilesUnchanged, snapshotDiff, touchedSurfaceKeys } from '../lib/unchanged.mjs';
import { indexInventory, surfaceKey } from '../lib/surface-key.mjs';
import { tmpDir, write, EXTRACTOR, HAVE_EXTRACTOR, ROUTER, ROUTER_REL, routerFixture } from './helpers.mjs';

test('layer 2: identical cited files are unchanged; an edit, a deletion or an absence is not', () => {
  const root = tmpDir();
  const oldRoot = path.join(root, 'old');
  const newRoot = path.join(root, 'new');
  write(path.join(oldRoot, 'R', 'same.go'), 'a\n');
  write(path.join(newRoot, 'R', 'same.go'), 'a\n');
  write(path.join(oldRoot, 'R', 'edit.go'), 'a\n');
  write(path.join(newRoot, 'R', 'edit.go'), 'b\n');
  write(path.join(oldRoot, 'R', 'gone.go'), 'a\n');
  const f = (p) => ({ repo: 'R', path: p, lines: null });
  assert.equal(citedFilesUnchanged([f('same.go')], oldRoot, newRoot).unchanged, true);
  const r = citedFilesUnchanged([f('same.go'), f('edit.go'), f('gone.go'), f('never.go')], oldRoot, newRoot);
  assert.equal(r.unchanged, false);
  assert.deepEqual(r.changed, ['R/edit.go', 'R/gone.go (deleted)']);
  assert.deepEqual(r.missing, ['R/never.go (absent from the prior snapshot)']);
  assert.equal(citedFilesUnchanged([], oldRoot, newRoot).unchanged, false, 'no citations can never vouch for anything');
});

test('layer 2 sees a file edited between two calls in the same process (no stale module-level hash cache)', () => {
  const root = tmpDir();
  const oldRoot = path.join(root, 'old');
  const newRoot = path.join(root, 'new');
  write(path.join(oldRoot, 'R', 'a.go'), 'one\n');
  write(path.join(newRoot, 'R', 'a.go'), 'one\n');
  const f = [{ repo: 'R', path: 'a.go', lines: '1' }];
  assert.equal(citedFilesUnchanged(f, oldRoot, newRoot).unchanged, true);
  write(path.join(newRoot, 'R', 'a.go'), 'one // edited\n');
  assert.equal(citedFilesUnchanged(f, oldRoot, newRoot).unchanged, false, 'a second call must re-read the edited file');
  const cache = new Map();
  assert.equal(citedFilesUnchanged(f, oldRoot, newRoot, cache).unchanged, false);
  assert.equal(cache.size, 2, 'a caller-owned cache is filled for the run');
});

test('snapshotDiff normalizes paths to <repo>/<path>; a repo on one side only is emitted as flat paths', () => {
  const root = tmpDir();
  const oldRoot = path.join(root, 'a', 'old');
  const newRoot = path.join(root, 'b', 'new');
  write(path.join(oldRoot, 'R1', 'x', 'f.go'), 'one\ntwo\n');
  write(path.join(newRoot, 'R1', 'x', 'f.go'), 'one\nTWO\n');
  write(path.join(newRoot, 'R2', 'y.go'), 'new repo\n');
  const d = snapshotDiff(oldRoot, newRoot, ['R1', 'R2']);
  assert.match(d, /^diff --git a\/R1\/x\/f\.go b\/R1\/x\/f\.go$/m);
  assert.match(d, /^\+\+\+ b\/R1\/x\/f\.go$/m);
  assert.match(d, /^@@ -2 \+2 @@/m);
  assert.match(d, /^R2\/y\.go$/m);
  assert.equal(snapshotDiff(oldRoot, oldRoot, ['R1']), '');
});

function fullInventory(fx) {
  const inv = path.join(fx.root, 'full-inventory.json');
  const frag = path.join(fx.root, 'full-fragment.md');
  const r = spawnSync(process.execPath, [EXTRACTOR, '--contract', fx.contract, '--inventory', inv, '--fragment', frag], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(fs.readFileSync(inv, 'utf8'));
}

const keyOfPath = (inv, p) => surfaceKey(inv.surfaces.find((s) => s.path === p));

test('layer 1 (real extractor): no code change touches nothing', { skip: !HAVE_EXTRACTOR && `extractor not found at ${EXTRACTOR}` }, () => {
  const fx = routerFixture();
  const inv = fullInventory(fx);
  assert.equal(inv.surfaces.length, 3);
  const t = touchedSurfaceKeys({ extractor: EXTRACTOR, contract: fx.contract, diffText: snapshotDiff(fx.oldRoot, fx.newRoot, ['RevHero-user-fe-backend']), scratchDir: path.join(fx.root, 's1'), expectedSurfaceCount: 3 });
  assert.equal(t.all, false, t.reason);
  assert.equal(t.keys.size, 0);
});

test('layer 1 (real extractor): an edit inside one route range touches that surface only', { skip: !HAVE_EXTRACTOR && `extractor not found at ${EXTRACTOR}` }, () => {
  const fx = routerFixture({ newRouter: ROUTER.replace('group.GET("/detail/:id", h)', 'group.GET("/detail/:id", h2)') });
  const inv = fullInventory(fx);
  const t = touchedSurfaceKeys({ extractor: EXTRACTOR, contract: fx.contract, diffText: snapshotDiff(fx.oldRoot, fx.newRoot, ['RevHero-user-fe-backend']), scratchDir: path.join(fx.root, 's2'), expectedSurfaceCount: inv.surfaces.length });
  assert.equal(t.all, false, t.reason);
  assert.deepEqual([...t.keys], [keyOfPath(inv, 'routes:/detail/:id')]);
});

test('layer 1 (real extractor): an edit outside every route range touches every route of the file', { skip: !HAVE_EXTRACTOR && `extractor not found at ${EXTRACTOR}` }, () => {
  const fx = routerFixture({ newRouter: ROUTER.replace('import "github.com/gin-gonic/gin"', 'import "github.com/gin-gonic/gin" // edited') });
  const inv = fullInventory(fx);
  const t = touchedSurfaceKeys({ extractor: EXTRACTOR, contract: fx.contract, diffText: snapshotDiff(fx.oldRoot, fx.newRoot, ['RevHero-user-fe-backend']), scratchDir: path.join(fx.root, 's3'), expectedSurfaceCount: inv.surfaces.length });
  assert.equal(t.all, false, t.reason);
  assert.equal(t.keys.size, inv.surfaces.length);
});

test('layer 1 fails SAFE when the extractor run does not match the expected floor', { skip: !HAVE_EXTRACTOR && `extractor not found at ${EXTRACTOR}` }, () => {
  const fx = routerFixture();
  write(fx.contract, JSON.stringify({ surfaces: { source: [path.join(fx.root, 'nowhere', ROUTER_REL)] } }));
  const t = touchedSurfaceKeys({ extractor: EXTRACTOR, contract: fx.contract, diffText: '', scratchDir: path.join(fx.root, 's4'), expectedSurfaceCount: 3 });
  assert.equal(t.all, true);
  assert.ok(t.reason);
});

test('index helper: touched ids map back to cross-generation keys', () => {
  const idx = indexInventory({ surfaces: [{ id: 'S001', path: 'routes:/a', verbs: ['GET'], kinds: ['RECORD'] }] });
  assert.equal(idx.bySid.get('S001'), 'routes:/a | GET | RECORD');
});
