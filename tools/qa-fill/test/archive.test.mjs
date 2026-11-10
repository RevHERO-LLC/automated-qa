import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { archiveGeneration } from '../archive.mjs';
import { latestGeneration, snapshotRootFromContract } from '../regenerate.mjs';
import { tmpDir, write } from './helpers.mjs';

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function fixture({ finalText = '- **FE-SURF-001** — [S001 /a] filled text. _type: frontend_\n' } = {}) {
  const root = tmpDir('qafill-arch-');
  const reg = path.join(root, 'reg');
  const run = path.join(root, 'run');
  const snap = path.join(root, 'snap');
  const frag = path.join(reg, 'fragments', 'zz-surfaces.md');
  write(path.join(snap, '_manifest.tsv'), 'repo\tref\tsha\tcommit_date\tfiles\nR\torigin/staging\taaaaaaaaaa\t2026-11-01T00:00:00Z\t1\n');
  write(path.join(snap, 'R', 'a.go'), 'package a\n');
  write(frag, finalText);
  write(path.join(run, 'scaffold.raw.md'), '- **FE-SURF-001** — [S001 /a] For <field> shows <the real fallback>. _type: frontend_\n');
  write(path.join(run, 'surface-inventory.json'), '{"surfaces":[]}');
  write(path.join(run, 'fill-carry.json'), '{}');
  write(path.join(run, 'fill-agents.json'), '{}');
  write(path.join(run, 'fill-status.json'), '{"FE-SURF-001":{"status":"filled","evidence":"R/a.go:1"}}');
  write(path.join(run, 'residual.json'), '{"cases":[]}');
  write(path.join(run, 'carry-report.json'), JSON.stringify({ hashes: { snapshotManifest: sha(path.join(snap, '_manifest.tsv')) }, paths: { frag } }));
  write(path.join(run, 'touched', 'scratch.json'), '{}');
  return { root, reg, run, snap, frag };
}

test('archives a generation in exactly the layout carry-forward reads back', () => {
  const fx = fixture();
  const r = archiveGeneration({ registry: fx.reg, run: fx.run, snapshot: fx.snap, date: '2026-11-01' });
  const gen = path.join(fx.reg, 'fill-archive', '2026-11-01');
  assert.equal(r.generation, gen);
  assert.deepEqual(r.remaining, []);
  const files = (d) => fs.readdirSync(d, { recursive: true }).map((f) => f.replace(/\\/g, '/')).filter((f) => fs.statSync(path.join(d, f)).isFile()).sort();
  assert.deepEqual(files(gen), ['carry-report.json', 'residual.json', 'run/fills/fill-agents.json', 'run/fills/fill-carry.json', 'run/fills/fill-status.json', 'snapshot/R/a.go', 'snapshot/_manifest.tsv', 'surface-inventory.json', 'zz-surfaces.md.filled', 'zz-surfaces.md.pre-fill.bak']);
  assert.match(fs.readFileSync(path.join(gen, 'zz-surfaces.md.pre-fill.bak'), 'utf8'), /<the real fallback>/, 'the RAW scaffold, never the filled text');
  assert.equal(latestGeneration(fx.reg), gen);
});

test('refuses when the snapshot moved since the carry-forward, or when nothing was applied', () => {
  let fx = fixture();
  fs.appendFileSync(path.join(fx.snap, '_manifest.tsv'), 'R2\torigin/staging\tbbbbbbbbbb\t2026-11-02T00:00:00Z\t1\n');
  assert.throws(() => archiveGeneration({ registry: fx.reg, run: fx.run, snapshot: fx.snap }), (e) => e.code === 'SNAPSHOT_CHANGED');
  assert.equal(fs.existsSync(path.join(fx.reg, 'fill-archive')), false);
  fx = fixture();
  fs.rmSync(path.join(fx.run, 'fill-status.json'));
  assert.throws(() => archiveGeneration({ registry: fx.reg, run: fx.run, snapshot: fx.snap }), /no fill-status\.json/);
});

test('reports cases that still need a fill, numbers same-day generations, and keeps the newest three', () => {
  const fx = fixture({ finalText: '- **FE-SURF-001** — [S001 /a] For <field> shows <the real fallback>. _type: frontend_\n' });
  const dates = ['2026-10-01', '2026-11-01', '2026-11-01', '2026-11-01'];
  let last;
  for (const date of dates) last = archiveGeneration({ registry: fx.reg, run: fx.run, snapshot: fx.snap, date });
  assert.deepEqual(last.remaining, ['FE-SURF-001']);
  assert.deepEqual(fs.readdirSync(path.join(fx.reg, 'fill-archive')).sort(), ['2026-11-01', '2026-11-01-2', '2026-11-01-3']);
  assert.equal(path.basename(latestGeneration(fx.reg)), '2026-11-01-3');
  fs.mkdirSync(path.join(fx.reg, 'fill-archive', 'notes'));
  for (let i = 0; i < 8; i += 1) archiveGeneration({ registry: fx.reg, run: fx.run, snapshot: fx.snap, date: '2026-11-01' });
  assert.deepEqual(fs.readdirSync(path.join(fx.reg, 'fill-archive')).sort(), ['2026-11-01-10', '2026-11-01-11', '2026-11-01-9', 'notes'], 'numeric order; foreign folders are never pruned');
  assert.equal(path.basename(latestGeneration(fx.reg)), '2026-11-01-11');
  assert.throws(() => archiveGeneration({ registry: fx.reg, run: fx.run, snapshot: fx.snap, date: '2026-10-31' }), /a newer generation 2026-11-01-11 already exists/);
});

test('latestGeneration skips incomplete generations; snapshotRootFromContract walks up to the manifest', () => {
  const fx = fixture();
  archiveGeneration({ registry: fx.reg, run: fx.run, snapshot: fx.snap, date: '2026-11-01' });
  fs.mkdirSync(path.join(fx.reg, 'fill-archive', '2026-11-09'), { recursive: true });
  assert.equal(path.basename(latestGeneration(fx.reg)), '2026-11-01');
  assert.equal(latestGeneration(path.join(fx.root, 'nowhere')), null);
  const contract = path.join(fx.root, 'c.json');
  write(contract, JSON.stringify({ surfaces: { source: [path.join(fx.snap, 'R', 'internal', 'routes', 'routes.go')] } }));
  assert.equal(snapshotRootFromContract(contract), fx.snap);
  write(contract, JSON.stringify({ surfaces: { source: [path.join(fx.root, 'loose', 'routes.go')] } }));
  assert.equal(snapshotRootFromContract(contract), null);
});
