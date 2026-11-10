import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { exportSnapshot } from '../snapshot-export.mjs';
import { tmpDir, write } from './helpers.mjs';

const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

function repo(root, name, files, ref) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  for (const [f, c] of Object.entries(files)) write(path.join(dir, f), c);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'one');
  const sha = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'update-ref', `refs/remotes/${ref}`, sha);
  return { dir, sha };
}

test('exports each repo at its ref (not the working tree), with the existing manifest format', async () => {
  const root = tmpDir('qafill-exp-');
  const clones = path.join(root, 'clones');
  const a = repo(clones, 'RepoA', { 'internal/routes/routes.go': 'package routes\nfunc A() {}\n', 'README.md': 'a\n' }, 'origin/staging');
  const b = repo(clones, 'RepoB', { 'main.go': 'package main\n' }, 'origin/main');
  write(path.join(a.dir, 'internal/routes/routes.go'), 'uncommitted drift\n');
  write(path.join(a.dir, 'untracked.txt'), 'not in git\n');
  const out = path.join(root, 'snap');
  const r = await exportSnapshot({ reposRoot: clones, out, repos: ['RepoA', 'RepoB', 'RepoMissing'], fallbackRef: 'origin/main' });
  assert.deepEqual(r.errors, [`RepoMissing: no clone at ${path.join(clones, 'RepoMissing')}`]);
  assert.equal(fs.readFileSync(path.join(out, 'RepoA', 'internal/routes/routes.go'), 'utf8').replace(/\r\n/g, '\n'), 'package routes\nfunc A() {}\n');
  assert.equal(fs.existsSync(path.join(out, 'RepoA', 'untracked.txt')), false);
  const rows = fs.readFileSync(path.join(out, '_manifest.tsv'), 'utf8').trimEnd().split('\n').map((l) => l.split('\t'));
  assert.deepEqual(rows[0], ['repo', 'ref', 'sha', 'commit_date', 'files']);
  assert.deepEqual(rows[1].slice(0, 3), ['RepoA', 'origin/staging', a.sha.slice(0, 10)]);
  assert.match(rows[1][3], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(rows[1][4], '2');
  assert.deepEqual(rows[2].slice(0, 3), ['RepoB', 'origin/main', b.sha.slice(0, 10)], 'the fallback ref is recorded as the ref actually used');
});

test('line endings follow --eol, independent of the local git config (default crlf = the shared snapshot convention)', async () => {
  const root = tmpDir('qafill-eol-');
  const clones = path.join(root, 'clones');
  repo(clones, 'RepoA', { 'a.go': 'one\ntwo\n' }, 'origin/staging');
  const crlf = path.join(root, 'crlf');
  const lf = path.join(root, 'lf');
  await exportSnapshot({ reposRoot: clones, out: crlf, repos: ['RepoA'] });
  await exportSnapshot({ reposRoot: clones, out: lf, repos: ['RepoA'], eol: 'as-committed' });
  assert.equal(fs.readFileSync(path.join(crlf, 'RepoA', 'a.go'), 'utf8'), 'one\r\ntwo\r\n');
  assert.equal(fs.readFileSync(path.join(lf, 'RepoA', 'a.go'), 'utf8'), 'one\ntwo\n');
  await assert.rejects(exportSnapshot({ reposRoot: clones, out: lf, repos: ['RepoA'], eol: 'mixed' }), /--eol must be/);
});

test('a ref that does not exist is an error, never a silent fallback to something else', async () => {
  const root = tmpDir('qafill-ref-');
  repo(path.join(root, 'clones'), 'RepoA', { 'a.go': 'x\n' }, 'origin/main');
  const r = await exportSnapshot({ reposRoot: path.join(root, 'clones'), out: path.join(root, 'snap'), repos: ['RepoA'] });
  assert.deepEqual(r.errors, ['RepoA: ref origin/staging not found']);
  assert.deepEqual(r.rows, []);
});
