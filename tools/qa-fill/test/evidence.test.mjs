import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseEvidence, resolveAgainstSnapshot, rewriteCitedLines } from '../lib/evidence.mjs';
import { tmpDir, write } from './helpers.mjs';

const REPOS = new Set(['RevHero-FE-New', 'RevHero-users-service', 'RevHero-user-fe-backend', 'RevHero-calendar-service', 'RevHero-leadgen-service']);

test('real 11-07 shapes: a space in a folder name, and a repo named on its own before a path', () => {
  // FE-SURF-1353 (folder "Stage Actions"), FE-SURF-1298 and FE-SURF-1299 (repo, space, then the path).
  const a = parseEvidence('RevHero-FE-New/features/campaign/components/Stage Actions/LinkedInSearch.tsx:327-380', REPOS);
  assert.deepEqual(a.files.map((f) => f.path), ['features/campaign/components/Stage Actions/LinkedInSearch.tsx']);
  assert.equal(a.files[0].lines, '327-380');
  const b = parseEvidence('RevHero-leadgen-service jobs.service.go:167-207 (shortfall clamped at 0); dto JobDTO (plain int)', REPOS);
  assert.deepEqual(b.files.map((f) => `${f.repo}/${f.path}`), ['RevHero-leadgen-service/jobs.service.go']);
  const c = parseEvidence('RevHero-user-fe-backend leadgen_resource/leadgen.handler.go:55-70,147-155 (parseID; every failure is a 500), internal/helpers/httpResponse.go:261-286;', REPOS);
  assert.deepEqual(c.files.map((f) => `${f.repo}/${f.path}:${f.lines}`), [
    'RevHero-user-fe-backend/leadgen_resource/leadgen.handler.go:55-70,147-155',
    'RevHero-user-fe-backend/internal/helpers/httpResponse.go:261-286',
  ]);
});

test('a partial path resolves only through a UNIQUE suffix match inside the cited repo', () => {
  const snap = tmpDir();
  write(path.join(snap, 'RevHero-FE-New', 'components', 'settings', 'tabs', 'BlockedDomains.tsx'), 'x');
  write(path.join(snap, 'RevHero-FE-New', 'x', 'Shared.tsx'), 'x');
  write(path.join(snap, 'RevHero-FE-New', 'y', 'Shared.tsx'), 'x');
  write(path.join(snap, 'RevHero-calendar-service', 'calendar.handler.go'), 'x');
  const parsed = parseEvidence('RevHero-FE-New/tabs/BlockedDomains.tsx:1; Shared.tsx:2; RevHero-users-service/calendar.handler.go:3', REPOS);
  const r = resolveAgainstSnapshot(parsed, snap);
  assert.deepEqual(r.files.map((f) => `${f.repo}/${f.path}`), ['RevHero-FE-New/components/settings/tabs/BlockedDomains.tsx']);
  // An ambiguous name, and a file cited under the WRONG repo, stay unresolved (never guessed).
  assert.deepEqual(r.unresolved.sort(), ['RevHero-FE-New/Shared.tsx', 'RevHero-users-service/calendar.handler.go']);
});

test('a repo prefix starts a context; unprefixed paths inherit it; ranges and notes are handled', () => {
  // The exact evidence string the 2026-11-07 fill wrote for FE-SURF-005.
  const ev = 'RevHero-FE-New/components/invite/InvitePage.tsx:43-60,66-88; components/invite/InviteDetails.tsx:160-205; '
    + 'RevHero-users-service/internal/resources/account_resource/account.service.go:388-411; '
    + 'RevHero-user-fe-backend/internal/resources/account_resource/account.handler.go:213-235 (response shape data.invitation)';
  const r = parseEvidence(ev, REPOS);
  assert.equal(r.uncited, false);
  assert.deepEqual(r.files.map((f) => `${f.repo}/${f.path}`), [
    'RevHero-FE-New/components/invite/InvitePage.tsx',
    'RevHero-FE-New/components/invite/InviteDetails.tsx',
    'RevHero-users-service/internal/resources/account_resource/account.service.go',
    'RevHero-user-fe-backend/internal/resources/account_resource/account.handler.go',
  ]);
  assert.equal(r.files[0].lines, '43-60,66-88');
  assert.deepEqual(r.unresolved, []);
});

test('Next.js route groups and dynamic segments survive parsing', () => {
  const r = parseEvidence('RevHero-FE-New/app/(dashboard)/deals/[id]/page.tsx:12-40', REPOS);
  assert.equal(r.files[0].path, 'app/(dashboard)/deals/[id]/page.tsx');
});

test('a renamed GitHub repo resolves to its local directory name', () => {
  const r = parseEvidence('RevHero-booking-service/internal/resources/booking.go:10', REPOS);
  assert.equal(r.files[0].repo, 'RevHero-calendar-service');
});

test('prose with no source-file citation is uncited (never carriable)', () => {
  const r = parseEvidence('see the deals page; GET /v1/deals returns 404 (data.items)', REPOS);
  assert.equal(r.uncited, true);
  assert.deepEqual(r.files, []);
});

test('a path before any repo context is unresolved, not guessed', () => {
  const r = parseEvidence('internal/routes/routes.go:3', REPOS);
  assert.deepEqual(r.files, []);
  assert.deepEqual(r.unresolved, ['internal/routes/routes.go']);
});

test('resolveAgainstSnapshot: present path ok, missing path unresolved, bare name only when unique', () => {
  const snap = tmpDir();
  write(path.join(snap, 'RevHero-FE-New', 'a', 'One.tsx'), 'x');
  write(path.join(snap, 'RevHero-FE-New', 'b', 'page.tsx'), 'x');
  write(path.join(snap, 'RevHero-FE-New', 'c', 'page.tsx'), 'x');
  const parsed = parseEvidence('RevHero-FE-New/a/One.tsx:1; a/Missing.tsx:2; One.tsx:3; page.tsx:4', REPOS);
  const r = resolveAgainstSnapshot(parsed, snap);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['a/One.tsx']);
  assert.deepEqual(r.unresolved.sort(), ['RevHero-FE-New/a/Missing.tsx', 'RevHero-FE-New/page.tsx']);
});

test('a file cited more than once keeps every range; a mention without lines means the whole file', () => {
  // Shape of FE-SURF-911..913 (routes.go:2044 ... routes.go:1041): the router check must see BOTH ranges.
  const a = parseEvidence('RevHero-user-fe-backend/internal/routes/routes.go:2044; admin.handler.go:12; routes.go:1041', REPOS);
  assert.equal(a.files.find((f) => f.path === 'internal/routes/routes.go').lines, '2044');
  const snap = tmpDir();
  write(path.join(snap, 'RevHero-user-fe-backend', 'internal', 'routes', 'routes.go'), 'package routes\n');
  write(path.join(snap, 'RevHero-user-fe-backend', 'internal', 'admin.handler.go'), 'package admin\n');
  const r = resolveAgainstSnapshot(a, snap);
  assert.equal(r.files.find((f) => f.path === 'internal/routes/routes.go').lines, '2044,1041', 'merged after resolution (bare name + full path)');
  const b = parseEvidence('RevHero-user-fe-backend/internal/routes/routes.go:858-870; RevHero-user-fe-backend/internal/routes/routes.go', REPOS);
  assert.equal(b.files[0].lines, null);
  const c = parseEvidence('RevHero-user-fe-backend/x.go:1-2; RevHero-user-fe-backend/x.go:9', REPOS);
  assert.equal(c.files[0].lines, '1-2,9');
});

test('rewriteCitedLines changes only the line specs of the target file, every occurrence, nothing else', () => {
  const snap = tmpDir();
  write(path.join(snap, 'RevHero-user-fe-backend', 'internal', 'routes', 'routes.go'), 'package routes\n');
  write(path.join(snap, 'RevHero-user-fe-backend', 'internal', 'deal.handler.go'), 'package deal\n');
  write(path.join(snap, 'RevHero-users-service', 'internal', 'routes', 'routes.go'), 'package routes\n');
  const T = 'RevHero-user-fe-backend/internal/routes/routes.go';
  const plus2 = (s) => s.split(',').map((p) => p.split('-').map((n) => Number(n) + 2).join('-')).join(',');
  const ev = 'RevHero-user-fe-backend/internal/routes/routes.go:13 (detail route); deal.handler.go:7; routes.go:40-42,50';
  assert.equal(rewriteCitedLines(ev, REPOS, snap, T, plus2), 'RevHero-user-fe-backend/internal/routes/routes.go:15 (detail route); deal.handler.go:7; routes.go:42-44,52');
  const other = 'RevHero-users-service/internal/routes/routes.go:13; RevHero-user-fe-backend/internal/routes/routes.go:5';
  assert.equal(rewriteCitedLines(other, REPOS, snap, T, plus2), 'RevHero-users-service/internal/routes/routes.go:13; RevHero-user-fe-backend/internal/routes/routes.go:7', "another repo's routes.go is not the target");
  assert.equal(rewriteCitedLines('RevHero-user-fe-backend/internal/routes/routes.go:13', REPOS, snap, T, () => null), null, 'a refused remap refuses the whole carry');
  assert.equal(rewriteCitedLines('RevHero-user-fe-backend/internal/routes/routes.go (whole file)', REPOS, snap, T, plus2), null, 'a citation without lines cannot be remapped');
  assert.equal(rewriteCitedLines('RevHero-user-fe-backend/internal/deal.handler.go:7', REPOS, snap, T, plus2), 'RevHero-user-fe-backend/internal/deal.handler.go:7', 'no target citation: unchanged');
});
