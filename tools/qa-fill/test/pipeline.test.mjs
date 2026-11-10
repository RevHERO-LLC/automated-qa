// End-to-end through the CLIs, with the real shared extractor, over three registry generations:
//   gen 1  no prior: everything is residual -> make_slices -> (simulated agents) -> merge -> apply_fills -> archive
//   gen 2  no code change: everything but the per-entity case carries; the residual is filled and archived again
//   gen 3  a new route renumbers every case, one route line is edited, one cited handler changes: exactly the
//          untouched + byte-identical fill carries (re-homed to its new id and tag), everything else is residual.
// Plus the carry-forward edge reasons (template-changed, apply-rejected, self-check-failed) on the gen-2 inputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir, write, EXTRACTOR, HAVE_EXTRACTOR, ROUTER, ROUTER_REL } from './helpers.mjs';
import { readBlocks, needsFill } from '../lib/signature.mjs';
import { carryForward } from '../carry-forward.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const skip = !HAVE_EXTRACTOR && `extractor not found at ${EXTRACTOR}`;
const DEAL_REL = 'RevHero-user-fe-backend/internal/resources/deal_resource/deal.handler.go';
const CAMP_REL = 'RevHero-user-fe-backend/internal/resources/campaign_resource/campaign.handler.go';
const manifest = (sha) => `repo\tref\tsha\tcommit_date\tfiles\nRevHero-user-fe-backend\torigin/staging\t${sha}\t2026-11-01T00:00:00Z\t3\n`;

function run(script, args) {
  const r = spawnSync(process.execPath, [path.join(HERE, '..', script), ...args, ...(script === 'regenerate.mjs' ? ['--extractor', EXTRACTOR] : [])], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function project() {
  const root = tmpDir('qafill-pipe-');
  const snap = path.join(root, 'snap');
  write(path.join(snap, ROUTER_REL), ROUTER);
  write(path.join(snap, DEAL_REL), 'package deal_resource\n\nfunc List() {\n\t// ORDER BY created_at DESC\n}\n\nfunc Detail() {}\n');
  write(path.join(snap, CAMP_REL), 'package campaign_resource\n\nfunc Create() {\n\t// unique index on name\n}\n');
  write(path.join(snap, '_manifest.tsv'), manifest('aaaaaaaaaa'));
  const reg = path.join(root, 'reg');
  fs.mkdirSync(path.join(reg, 'fragments'), { recursive: true });
  const contract = path.join(root, 'proj', 'qa-contract.json');
  write(contract, JSON.stringify({ surfaces: { source: [path.join(snap, ROUTER_REL)] } }, null, 2));
  return { root, snap, reg, contract, frag: path.join(reg, 'fragments', 'zz-surfaces.md') };
}

// The fill agents, simulated: one block per sliced case, citing the file that owns its surface.
const evFor = (c) => ({ 'routes:/list': `${DEAL_REL}:3-5`, 'routes:/create': `${CAMP_REL}:3-5`, 'routes:/detail/:id': `${ROUTER_REL}:13; ${DEAL_REL}:7` })[c.path] || `${CAMP_REL}:3`;
function agentParts(slicesDir, partsFile) {
  const blocks = [];
  for (const f of fs.readdirSync(slicesDir).filter((x) => /-\d+\.json$/.test(x))) {
    for (const c of JSON.parse(fs.readFileSync(path.join(slicesDir, f), 'utf8')).cases) {
      const status = /render in/.test(c.text) ? 'finding' : /null\/0\/empty/.test(c.text) ? 'none' : 'filled';
      const tx = status === 'none' ? 'none — the route renders no fallback' : `Fixture fill for ${c.id}: seed 3 rows for tenant 7, call the route and expect status 200 with message \`ok\`${status === 'finding' ? '. DEFECT to file: no tiebreak after created_at DESC' : ''}.`;
      blocks.push(`=== ${c.id} | ${status}\nEV: ${evFor(c)}\nTX: ${tx}\n`);
    }
  }
  write(partsFile, blocks.join(''));
}

function fillAndArchive(p, runDir, date) {
  const slices = path.join(runDir, 'slices');
  const steps = [
    ['make_slices.mjs', ['--registry', p.reg, '--run', runDir, '--out', slices, '--size', '3']],
    ['merge.mjs', ['--slices', slices, '--parts', path.join(runDir, 'parts'), '--out', path.join(runDir, 'fill-agents.json'), '--snapshot', p.snap]],
    ['apply_fills.mjs', ['--fills', runDir, '--frag', p.frag]],
    ['apply_fills.mjs', ['--fills', runDir, '--frag', p.frag, '--write']],
    ['archive.mjs', ['--registry', p.reg, '--run', runDir, '--snapshot', p.snap, '--date', date]],
  ];
  const outs = {};
  for (const [script, args] of steps) {
    const r = run(script, args);
    assert.equal(r.code, 0, `${script} failed:\n${r.out}`);
    outs[script] = r.out;
    if (script === 'make_slices.mjs') agentParts(slices, path.join(runDir, 'parts', 'agent-1.txt'));
  }
  return outs;
}

const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const blocksOf = (f) => readBlocks(fs.readFileSync(f, 'utf8'));
const reasons = (runDir) => Object.fromEntries(json(path.join(runDir, 'residual.json')).cases.map((c) => [c.id, c.reason]));

test('three generations end to end: carry what is provably unchanged, residualize everything else', { skip }, () => {
  const p = project();
  // ---- gen 1: no prior generation
  const run1 = path.join(p.root, 'run1');
  let r = run('regenerate.mjs', ['--contract', p.contract, '--registry', p.reg, '--out', run1, '--write']);
  assert.equal(r.code, 0, r.out);
  let rep = json(path.join(run1, 'carry-report.json'));
  assert.equal(rep.prior, null);
  assert.deepEqual(rep.counts.residualByReason, { 'no-prior-generation': 8 });
  assert.equal(rep.counts.notFillTargets, 1, 'the by-design: <reason> boilerplate is not a fill target');
  const outs1 = fillAndArchive(p, run1, '2026-11-01');
  assert.match(outs1['make_slices.mjs'], /residual: 8 case\(s\) in \d+ slice\(s\) of <= 3/);
  assert.match(outs1['make_slices.mjs'], /PROJECTION: \d+ agents x ~\d+ steps x ~60K context ~= [\d.]+M tokens/);
  const gen1 = blocksOf(p.frag);
  assert.equal([...gen1.values()].filter((b) => needsFill(b.block.join('\n'))).length, 0, 'gen 1 fully filled');
  for (const f of ['surface-inventory.json', 'zz-surfaces.md.pre-fill.bak', 'zz-surfaces.md.filled', 'run/fills/fill-status.json', 'run/fills/fill-agents.json', 'snapshot/_manifest.tsv', 'snapshot/' + ROUTER_REL, 'carry-report.json', 'residual.json']) {
    assert.ok(fs.existsSync(path.join(p.reg, 'fill-archive', '2026-11-01', f)), `archived ${f}`);
  }

  // ---- gen 2: nothing changed
  const run2 = path.join(p.root, 'run2');
  r = run('regenerate.mjs', ['--contract', p.contract, '--registry', p.reg, '--out', run2, '--write']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /prior generation: .*2026-11-01/);
  rep = json(path.join(run2, 'carry-report.json'));
  assert.equal(rep.prior, '2026-11-01');
  assert.deepEqual(rep.counts.carriedByStatus, { filled: 5, none: 1, finding: 1 }, 'a finding stays a finding; a none stays a none');
  assert.deepEqual(rep.counts.residualByReason, { 'per-entity': 1 });
  assert.equal(rep.touched.all, false);
  assert.equal(rep.touched.count, 0);
  const gen2 = blocksOf(p.frag);
  const status2 = json(path.join(run2, 'fill-status.json'));
  for (const [id, b] of gen2) {
    if (/Enumerate EVERY path/.test(b.line)) continue;
    assert.equal(b.line, gen1.get(id).line, `${id} carried verbatim`);
    if (status2[id]) assert.equal(status2[id].carriedFrom, `2026-11-01:${id}`);
  }
  fillAndArchive(p, run2, '2026-11-02');
  const createGen2 = [...blocksOf(p.frag).values()].find((b) => b.tag && b.tag.path === 'routes:/create' && /Fixture fill/.test(b.line));

  // ---- gen 3: a new route (renumbers everything), an edit on the /detail route line, a changed /list handler
  write(path.join(p.snap, ROUTER_REL), ROUTER.replace('group.POST("/create", h)', 'group.POST("/create", h)\n\tgroup.POST("/archive", h)').replace('group.GET("/detail/:id", h)', 'group.GET("/detail/:id", h2)'));
  write(path.join(p.snap, DEAL_REL), 'package deal_resource\n\nfunc List() {\n\t// ORDER BY created_at DESC, id DESC\n}\n\nfunc Detail() {}\n');
  write(path.join(p.snap, '_manifest.tsv'), manifest('bbbbbbbbbb'));
  const run3 = path.join(p.root, 'run3');
  r = run('regenerate.mjs', ['--contract', p.contract, '--registry', p.reg, '--out', run3, '--write']);
  assert.equal(r.code, 0, r.out);
  rep = json(path.join(run3, 'carry-report.json'));
  assert.equal(rep.prior, '2026-11-02');
  const gen3 = blocksOf(p.frag);
  const pathOf = (id) => (gen3.get(id).tag ? gen3.get(id).tag.path : '(entity)');
  const got = Object.entries(reasons(run3)).map(([id, why]) => `${pathOf(id)} ${why}`).sort();
  assert.deepEqual(got, [
    '(entity) per-entity',
    'routes:/archive no-match',
    'routes:/detail/:id surface-touched',
    'routes:/detail/:id surface-touched',
    'routes:/list source-changed',
    'routes:/list source-changed',
    'routes:/list source-changed',
    'routes:/list source-changed',
  ]);
  assert.deepEqual(rep.counts.carriedByStatus, { filled: 1 });
  const carried = json(path.join(run3, 'fill-carry.json'));
  const [newId] = Object.keys(carried);
  assert.notEqual(newId, createGen2.id, 'the carried case was renumbered');
  assert.equal(gen3.get(newId).tag.path, 'routes:/create');
  assert.equal(gen3.get(newId).line, `- **${newId}** — ${gen3.get(newId).tag.raw} ${createGen2.body}`, 're-homed: new id + new tag, old body verbatim');
  assert.equal(json(path.join(run3, 'fill-status.json'))[newId].carriedFrom, `2026-11-02:${createGen2.id}`);
  const hints = Object.fromEntries(json(path.join(run3, 'residual.json')).cases.map((c) => [pathOf(c.id), c.hint]));
  assert.equal(hints['routes:/list'].resolved, 'GET /v1/deals/list');
  assert.equal(hints['routes:/archive'].resolved, 'POST /v1/campaigns/archive');
  assert.equal(hints['(entity)'], null);
  assert.equal(fs.readFileSync(path.join(p.frag), 'utf8').includes('GET /v1/deals/list'), false, 'hints never reach the case text');

  // the archive guard: a snapshot refreshed after the carry-forward is never archived
  write(path.join(p.snap, '_manifest.tsv'), manifest('cccccccccc'));
  r = run('archive.mjs', ['--registry', p.reg, '--run', run3, '--snapshot', p.snap, '--date', '2026-11-03']);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /REFUSED: snapshot changed since the carry-forward ran/);
});

test('carry-forward edge reasons: template-changed, apply-rejected, self-check-failed', { skip }, () => {
  const p = project();
  const run1 = path.join(p.root, 'run1');
  assert.equal(run('regenerate.mjs', ['--contract', p.contract, '--registry', p.reg, '--out', run1, '--write']).code, 0);
  fillAndArchive(p, run1, '2026-11-01');
  const run2 = path.join(p.root, 'run2');
  assert.equal(run('regenerate.mjs', ['--contract', p.contract, '--registry', p.reg, '--out', run2]).code, 0);
  const raw = fs.readFileSync(path.join(run2, 'scaffold.raw.md'), 'utf8');
  const prior = path.join(p.reg, 'fill-archive', '2026-11-01');
  const base = { prior, inventory: path.join(p.reg, 'surface-inventory.json'), snapshot: p.snap, contract: p.contract, extractor: EXTRACTOR };

  // an extractor template whose wording changed on a surface the prior generation had
  const edited = path.join(p.root, 'edited.md');
  write(edited, raw.replace('For <field>=null/0/empty,', 'For <field>=null, zero or empty,'));
  let res = carryForward({ ...base, scaffold: edited, out: path.join(p.root, 'o1') });
  const nullCase = res.residual.find((x) => x.reason === 'template-changed');
  assert.ok(nullCase, JSON.stringify(res.report.counts));
  assert.equal(res.report.counts.residualByReason['template-changed'], 1);

  // a regenerated case that now carries an _actor marker the prior did not: the carried fill takes the NEW markers
  const actor = path.join(p.root, 'actor.md');
  const target = [...readBlocks(raw).values()].find((b) => needsFill(b.block.join('\n')) && b.tag && /_type: frontend_$/.test(b.line));
  write(actor, raw.replace(target.line, `${target.line} _actor: MEMBER / onBehalfOf: ADMIN_`));
  res = carryForward({ ...base, scaffold: actor, out: path.join(p.root, 'o0') });
  const moved = res.accepted.find((a) => a.id === target.id);
  assert.ok(moved, JSON.stringify(res.residual.find((x) => x.id === target.id)));
  assert.match(moved.text, /_type: frontend_ _actor: MEMBER \/ onBehalfOf: ADMIN_$/);

  // the live fragment lost a case the scaffold has: the validator rejects the carry, and it is residual, not dropped
  const liveMissing = path.join(p.root, 'live.md');
  const firstFill = [...readBlocks(raw).values()].find((b) => needsFill(b.block.join('\n')) && b.tag);
  write(liveMissing, raw.split('\n').filter((l) => !l.startsWith(`- **${firstFill.id}** `)).join('\n'));
  res = carryForward({ ...base, scaffold: path.join(run2, 'scaffold.raw.md'), frag: liveMissing, out: path.join(p.root, 'o2') });
  assert.deepEqual(res.residual.filter((x) => x.reason === 'apply-rejected').map((x) => x.id), [firstFill.id]);
  assert.match(res.residual.find((x) => x.id === firstFill.id).detail, /id found 0 times/);

  // a contract whose sources are not inside the snapshot can never be diffed: refuse, residualize everything
  const offContract = path.join(p.root, 'off.json');
  write(offContract, JSON.stringify({ surfaces: { source: [path.join(p.root, 'elsewhere', ROUTER_REL)] } }));
  res = carryForward({ ...base, contract: offContract, scaffold: path.join(run2, 'scaffold.raw.md'), out: path.join(p.root, 'o3') });
  assert.equal(res.accepted.length, 0);
  assert.deepEqual(Object.keys(res.report.counts.residualByReason), ['self-check-failed']);
  assert.match(res.report.selfCheckProblems[0], /must all live under --snapshot/);
  const cli = run('carry-forward.mjs', ['--prior', prior, '--scaffold', path.join(run2, 'scaffold.raw.md'), '--inventory', base.inventory, '--snapshot', p.snap, '--contract', offContract, '--out', path.join(p.root, 'o4'), '--extractor', EXTRACTOR]);
  assert.equal(cli.code, 4, 'a failed self-check is a non-zero exit');
});
