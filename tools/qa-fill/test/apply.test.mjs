import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { indexFragments, loadFillMaps, validateEntries, applyEntries } from '../lib/apply.mjs';
import { tmpDir, write } from './helpers.mjs';

const FRAG = [
  '### Surface templates (FE-SURF)',
  '',
  '- **FE-SURF-001** — [S001 /(dashboard)/deals/[id]] For <field>=<real value>, the page displays <the exact rendered string>. _type: frontend_',
  '- **FE-SURF-002** — [S002 routes:/list] With zero rows matching, `routes:/list` renders <the EXACT empty-state copy from the code>. _type: frontend_',
  '  - a sub-bullet that belongs to FE-SURF-002',
  '- **FE-SURF-003** — Enumerate EVERY path that writes <UNKNOWN: entities>. _type: backend_',
  '',
].join('\r\n');

function setup() {
  const dir = tmpDir();
  const frag = path.join(dir, 'zz-surfaces.md');
  write(frag, FRAG);
  return { dir, frag };
}

const good1 = { id: 'FE-SURF-001', status: 'filled', evidence: 'R/a.go:1', text: '- **FE-SURF-001** — [S001 /(dashboard)/deals/[id]] For `amount`=1200 the page displays `$1,200`. _type: frontend_' };
const good2 = { id: 'FE-SURF-002', status: 'none', evidence: 'R/b.go:2', text: '- **FE-SURF-002** — [S002 routes:/list] none — single record route, no list. _type: frontend_' };

test('validateEntries accepts well-formed fills and names every broken rule', () => {
  const { frag } = setup();
  const idx = indexFragments([frag]);
  const bad = [
    { ...good1, id: 'FE-SURF-009', text: good1.text.replace('001', '009') },
    { ...good1, text: good1.text.replace('[S001 /(dashboard)/deals/[id]]', '[S007 /elsewhere]') },
    { ...good1, text: good1.text.replace('_type: frontend_', '_type: backend_') },
    { ...good1, text: good1.text.replace('`$1,200`', '<the exact rendered string>') },
    { ...good1, status: 'done' },
    { ...good2, text: good2.text.replace('none — single record route, no list.', 'no list here.') },
    { ...good1, text: good1.text.replace('- **FE-SURF-001** — ', '- FE-SURF-001 — ') },
  ];
  const { accepted, rejected } = validateEntries([good1, good2, ...bad], idx);
  assert.deepEqual(accepted.map((a) => a.id), ['FE-SURF-001', 'FE-SURF-002']);
  const why = rejected.map((r) => r.why);
  assert.match(why[0], /id found 0 times/);
  assert.match(why[1], /duplicate entry/);
  assert.match(why[1], /surface tag changed/);
  assert.match(why[2], /type marker changed/);
  assert.match(why[3], /placeholders left: <the exact rendered string>/);
  assert.match(why[4], /bad status "done"/);
  assert.match(why[5], /status none but no "none — <reason>"/);
  assert.match(why[6], /does not start with/);
});

test('legitimate angle brackets in a fill are not mistaken for placeholders', () => {
  const { frag } = setup();
  const e = { ...good1, text: good1.text.replace('`$1,200`', '`$1,200` inside a `<li>` of an `Array<string>`') };
  assert.equal(validateEntries([e], indexFragments([frag])).accepted.length, 1);
});

test('applyEntries backs up, replaces whole blocks, keeps CRLF, and merges fill-status with carriedFrom', () => {
  const { dir, frag } = setup();
  const idx = indexFragments([frag]);
  const carried = { ...good2, carriedFrom: '2026-11-07:FE-SURF-0042', src: 'fill-carry.json' };
  const { accepted } = validateEntries([{ ...good1, src: 'fill-a.json' }, carried], idx);
  const r = applyEntries(accepted, idx, dir);
  const out = fs.readFileSync(frag, 'utf8');
  assert.ok(out.includes('\r\n') && !/[^\r]\n/.test(out), 'line endings preserved');
  assert.ok(out.includes(good1.text) && out.includes(good2.text));
  assert.ok(!out.includes('a sub-bullet that belongs to FE-SURF-002'), 'the sub-bullet went with its block');
  assert.ok(out.includes('Enumerate EVERY path'), 'untouched cases stay');
  assert.ok(fs.existsSync(`${frag}.pre-fill.${r.ts}.bak`));
  assert.equal(fs.readFileSync(`${frag}.pre-fill.${r.ts}.bak`, 'utf8'), FRAG);
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'fill-status.json'), 'utf8'));
  assert.deepEqual(status['FE-SURF-002'], { status: 'none', evidence: 'R/b.go:2', frag: 'zz-surfaces.md', src: 'fill-carry.json', carriedFrom: '2026-11-07:FE-SURF-0042' });
  assert.equal(status['FE-SURF-001'].carriedFrom, undefined);
});

test('re-applying the same entries by id is idempotent (crash recovery)', () => {
  const { dir, frag } = setup();
  const first = indexFragments([frag]);
  applyEntries(validateEntries([good1, good2], first).accepted, first, dir);
  const once = fs.readFileSync(frag, 'utf8');
  const again = indexFragments([frag]);
  const v = validateEntries([good1, good2], again);
  assert.equal(v.rejected.length, 0, JSON.stringify(v.rejected));
  applyEntries(v.accepted, again, dir);
  assert.equal(fs.readFileSync(frag, 'utf8'), once);
});

test('loadFillMaps reads every fill-*.json except fill-status.json and reports unreadable maps', () => {
  const dir = tmpDir();
  write(path.join(dir, 'fill-a.json'), JSON.stringify({ 'FE-SURF-001': { text: 'x', status: 'filled' } }));
  write(path.join(dir, 'fill-status.json'), JSON.stringify({ 'FE-SURF-001': { status: 'filled' } }));
  write(path.join(dir, 'fill-broken.json'), '{ nope');
  write(path.join(dir, 'other.json'), '{}');
  const r = loadFillMaps(dir);
  assert.deepEqual(r.files, ['fill-a.json', 'fill-broken.json']);
  assert.deepEqual(r.entries.map((e) => [e.id, e.src]), [['FE-SURF-001', 'fill-a.json']]);
  assert.equal(r.loadErrors.length, 1);
});
