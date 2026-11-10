import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeSlices, checkCarryReport, projection, sliceOf } from '../make_slices.mjs';
import { tmpDir, write } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const INV = { surfaces: [
  { id: 'S001', path: '/(dashboard)/campaigns/[id]', verbs: [], kinds: ['RECORD'], sources: ['../snap/RevHero-FE-New/app/(dashboard)/campaigns/[id]/page.tsx'] },
  { id: 'S002', path: 'routes:/list', verbs: ['GET'], kinds: ['COLLECTION'], sources: ['../snap/RevHero-user-fe-backend/internal/routes/routes.go'] },
  { id: 'S003', path: '/(dashboard)/inbox', verbs: [], kinds: ['COLLECTION'], sources: [] },
] };
const line = (n, sid, p, body) => `- **FE-SURF-${String(n).padStart(3, '0')}** — ${sid ? `[${sid} ${p}] ` : ''}${body} _type: frontend_`;
const SCAFFOLD = [
  '### Surface templates (FE-SURF)',
  line(1, 'S001', '/(dashboard)/campaigns/[id]', 'For <field>=<real value>, displays <the exact rendered string>.'),
  line(2, 'S001', '/(dashboard)/campaigns/[id]', 'Same write twice: name the guard, or file a by-design: <reason> marker.'),
  line(3, 'S002', 'routes:/list', 'Zero rows renders <the EXACT empty-state copy from the code>.'),
  line(4, 'S002', 'routes:/list', 'Rows render in <the real sort order>; tie: <the real tiebreak>.'),
  line(5, 'S003', '/(dashboard)/inbox', 'Seed N rows matching <the real filter>.'),
  line(6, null, null, 'Enumerate EVERY path that writes `deals` (form, invite, import, admin action, ETL), assert <the real status field>.'),
  line(7, null, null, 'Enumerate EVERY path that writes `sms_messages` (form, invite, import, admin action, ETL), assert <the real status field>.'),
  '',
].join('\n');

/** A registry + a run dir as regenerate.mjs leaves them: FE-SURF-001 carried and applied, the rest residual. */
function fixture() {
  const root = tmpDir('qafill-slice-');
  const reg = path.join(root, 'reg');
  const run = path.join(root, 'run');
  const inv = path.join(reg, 'surface-inventory.json');
  const frag = path.join(reg, 'fragments', 'zz-surfaces.md');
  write(inv, JSON.stringify(INV));
  write(path.join(run, 'scaffold.raw.md'), SCAFFOLD);
  write(frag, SCAFFOLD.replace(/For <field>=<real value>, displays <the exact rendered string>\./, 'For `name`=Q4 the header displays `Q4`.'));
  const cases = ['FE-SURF-003', 'FE-SURF-004', 'FE-SURF-005', 'FE-SURF-006', 'FE-SURF-007'].map((id) => ({ id, reason: ['FE-SURF-006', 'FE-SURF-007'].includes(id) ? 'per-entity' : 'source-changed', hint: id === 'FE-SURF-003' ? { resolved: 'GET /v1/deals/list', candidates: ['GET /v1/deals/list'] } : null }));
  write(path.join(run, 'residual.json'), JSON.stringify({ count: cases.length, cases }));
  write(path.join(run, 'carry-report.json'), JSON.stringify({ selfCheckProblems: [], hashes: { scaffold: sha(path.join(run, 'scaffold.raw.md')), inventory: sha(inv) }, paths: { scaffold: path.join(run, 'scaffold.raw.md'), frag } }));
  return { root, reg, run, inv, frag, out: path.join(root, 'slices') };
}

const ids = (r, out) => r.files.flatMap((f) => JSON.parse(fs.readFileSync(path.join(out, f.file), 'utf8')).cases.map((c) => c.id)).sort();

test('slices only the residual, with reason and hint, grouped by feature and chunked by --size', () => {
  const fx = fixture();
  const r = makeSlices({ registry: fx.reg, run: fx.run, out: fx.out, size: 1 });
  assert.equal(r.mode, 'residual');
  assert.deepEqual(ids(r, fx.out), ['FE-SURF-003', 'FE-SURF-004', 'FE-SURF-005', 'FE-SURF-006', 'FE-SURF-007']);
  assert.ok(r.files.every((f) => f.count <= 1));
  const bySlice = Object.fromEntries(r.files.map((f) => [f.file, JSON.parse(fs.readFileSync(path.join(fx.out, f.file), 'utf8'))]));
  const first = Object.values(bySlice).flatMap((s) => s.cases).find((c) => c.id === 'FE-SURF-003');
  assert.deepEqual(first.hint, { resolved: 'GET /v1/deals/list', candidates: ['GET /v1/deals/list'] });
  assert.equal(first.reason, 'source-changed');
  assert.equal(first.surface, 'S002');
  assert.ok(Object.values(bySlice).some((s) => s.slice === 'inbox' && s.cases[0].id === 'FE-SURF-005'));
  assert.ok(Object.values(bySlice).some((s) => s.slice === 'campaign-deal' && s.cases[0].id === 'FE-SURF-006'), 'an untagged entity case is routed by its entity name');
  assert.ok(Object.values(bySlice).some((s) => s.slice === 'messaging' && s.cases[0].id === 'FE-SURF-007'), 'not by the template boilerplate, which names import');
  assert.equal(r.projection.agents, 5);
  assert.equal(r.projection.tokens, 5 * (2 * 1 + 10) * 60000);
});

test('refuses without a carry report, or when the inventory, the raw scaffold or the live case set moved on', () => {
  for (const [name, mutate, why] of [
    ['no report', (fx) => fs.rmSync(path.join(fx.run, 'carry-report.json')), /no carry report/],
    ['inventory re-generated', (fx) => fs.appendFileSync(fx.inv, ' '), /registry inventory changed/],
    ['raw scaffold edited', (fx) => fs.appendFileSync(path.join(fx.run, 'scaffold.raw.md'), '\n'), /raw scaffold changed/],
    ['live fragment swapped', (fx) => fs.appendFileSync(fx.frag, `\n${line(8, null, null, 'x <the real filter>.')}\n`), /does not hold the same case ids/],
  ]) {
    const fx = fixture();
    mutate(fx);
    assert.throws(() => makeSlices({ registry: fx.reg, run: fx.run, out: fx.out }), (e) => e.code === 'NO_MATCHING_CARRY_REPORT' && why.test(e.message), name);
    assert.equal(fs.existsSync(fx.out), false, `${name}: nothing sliced`);
  }
  const fx = fixture();
  fs.appendFileSync(fx.inv, ' ');
  const cli = spawnSync(process.execPath, [path.join(HERE, '..', 'make_slices.mjs'), '--registry', fx.reg, '--run', fx.run, '--out', fx.out], { encoding: 'utf8' });
  assert.equal(cli.status, 3);
  assert.match(cli.stderr, /REFUSED: refusing to slice/);
  assert.match(cli.stderr, /--no-carry "<reason>"/);
});

test('--no-carry slices every case still needing a fill and records the reason in the run', () => {
  const fx = fixture();
  fs.rmSync(path.join(fx.run, 'carry-report.json'));
  write(path.join(fx.run, 'carry-report.md'), '# Carry-forward report\n');
  const r = makeSlices({ registry: fx.reg, run: fx.run, out: fx.out, noCarry: 'carry-forward crashed on the new extractor' });
  assert.match(fs.readFileSync(path.join(fx.run, 'carry-report.md'), 'utf8'), /NO-CARRY OVERRIDE \(.+\): .* Reason: carry-forward crashed on the new extractor/);
  assert.equal(r.mode, 'no-carry');
  assert.deepEqual(ids(r, fx.out), ['FE-SURF-003', 'FE-SURF-004', 'FE-SURF-005', 'FE-SURF-006', 'FE-SURF-007'], 'FE-SURF-001 is already filled, FE-SURF-002 holds only boilerplate');
  const nc = JSON.parse(fs.readFileSync(path.join(fx.run, 'no-carry.json'), 'utf8'));
  assert.equal(nc.reason, 'carry-forward crashed on the new extractor');
  assert.throws(() => makeSlices({ registry: fx.reg, run: fx.run, out: fx.out, noCarry: '  ' }), /needs a reason/);
});

test('re-slicing skips cases filled in between and replaces the earlier slice files', () => {
  const fx = fixture();
  makeSlices({ registry: fx.reg, run: fx.run, out: fx.out, size: 1 });
  write(path.join(fx.out, 'agent-notes.txt'), 'not ours');
  fs.writeFileSync(fx.frag, fs.readFileSync(fx.frag, 'utf8').replace('Zero rows renders <the EXACT empty-state copy from the code>.', 'Zero rows renders `No deals yet`.'));
  const r = makeSlices({ registry: fx.reg, run: fx.run, out: fx.out, size: 30 });
  assert.equal(r.alreadyFilled, 1);
  assert.deepEqual(ids(r, fx.out), ['FE-SURF-004', 'FE-SURF-005', 'FE-SURF-006', 'FE-SURF-007']);
  assert.deepEqual(fs.readdirSync(fx.out).sort(), ['agent-notes.txt', 'campaign-deal-1.json', 'inbox-1.json', 'integrations-admin-1.json', 'messaging-1.json', 'slices-index.json']);
});

test('a failed carry-forward self-check is a warning, not a refusal: everything is residual already', () => {
  const fx = fixture();
  const rep = JSON.parse(fs.readFileSync(path.join(fx.run, 'carry-report.json'), 'utf8'));
  rep.selfCheckProblems = ['extractor no longer contains --touched'];
  fs.writeFileSync(path.join(fx.run, 'carry-report.json'), JSON.stringify(rep));
  const chk = checkCarryReport({ registry: fx.reg, run: fx.run });
  assert.equal(chk.ok, true);
  assert.match(makeSlices({ registry: fx.reg, run: fx.run, out: fx.out }).warning, /self-check failed/);
});

test('the legacy feature grouping is unchanged', () => {
  assert.equal(sliceOf({ path: '/(dashboard)/inbox', sources: [] }), 'inbox');
  assert.equal(sliceOf({ path: 'routes:/list', sources: ['x/RevHero-user-fe-backend/internal/routes/routes.go'] }), 'integrations-admin', 'BFF sources do not steer the grouping');
  assert.equal(sliceOf({ path: '/settings', sources: ['RevHERO-Super-Admin-Portal/app/settings/page.tsx'] }), 'integrations-admin');
  assert.equal(sliceOf({ path: '/booking', sources: [] }), 'growth-ai');
  // (2x30+10) + (2x30+10) + (2x5+10) = 160 steps, avg 53; 160 x 60K = 9.6M
  assert.equal(projection([30, 30, 5]).line, 'PROJECTION: 3 agents x ~53 steps x ~60K context ~= 9.6M tokens (estimate; cache reads dominate)');
});
