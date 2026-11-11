// Option C (Zach, 2026-11-10): the BFF router's inert hunks are dropped before the extractor, and a fill citing router
// LINES carries when no hunk overlaps them, with its citation remapped to the current file. The guard keeps anything
// route-shaping and anything that touches the security or permission setup.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { analyzeRouterSource, lineIsInert, relaxRouterDiff, remapCitedLines, citedFilesUnchanged, snapshotDiff, lexGo } from '../lib/unchanged.mjs';
import { changedPlumbing } from '../carry-forward.mjs';
import { tmpDir, write, ROUTER_REL } from './helpers.mjs';

test('plumbing: changed non-test Go files under the BFF shared dirs, from headers and one-sided flat paths', () => {
  const diff = [
    'diff --git a/RevHero-user-fe-backend/internal/helpers/httpResponse.go b/RevHero-user-fe-backend/internal/helpers/httpResponse.go',
    '@@ -1 +1 @@', '-a', '+b',
    'diff --git a/RevHero-user-fe-backend/internal/helpers/httpResponse_test.go b/RevHero-user-fe-backend/internal/helpers/httpResponse_test.go',
    'diff --git a/RevHero-user-fe-backend/internal/middleware/auth/auth.go b/RevHero-user-fe-backend/internal/middleware/auth/auth.go',
    'diff --git a/RevHero-user-fe-backend/internal/resources/x/x.handler.go b/RevHero-user-fe-backend/internal/resources/x/x.handler.go',
    'diff --git a/RevHero-users-service/internal/helpers/h.go b/RevHero-users-service/internal/helpers/h.go',
    'RevHero-user-fe-backend/cmd/main.go',
    '+RevHero-user-fe-backend/internal/config/config.go',
  ].join('\n');
  assert.deepEqual(changedPlumbing(diff), [
    'RevHero-user-fe-backend/cmd/main.go',
    'RevHero-user-fe-backend/internal/helpers/httpResponse.go',
    'RevHero-user-fe-backend/internal/middleware/auth/auth.go',
  ], 'test files, handlers, other repos and diff body lines are not plumbing');
});

test('plumbing with the snapshots: only CODE changes count (comments, imports and the package clause do not)', () => {
  const root = tmpDir('qafill-plumb-');
  const oldRoot = path.join(root, 'old');
  const newRoot = path.join(root, 'new');
  const H = 'RevHero-user-fe-backend/internal/helpers';
  const both = (rel, a, b) => { write(path.join(oldRoot, rel), a); write(path.join(newRoot, rel), b); };
  const go = (body) => `package helpers\n\nimport (\n\t"fmt"\n)\n\n${body}\n`;
  both(`${H}/comment.go`, go('// old note\nfunc A() { fmt.Println(1) }'), go('// new note, reworded\nfunc A() { fmt.Println(1) }'));
  both(`${H}/imports.go`, go('func B() { fmt.Println(2) }'), go('func B() { fmt.Println(2) }').replace('\t"fmt"\n', '\t"fmt"\n\tstr "strings"\n'));
  both(`${H}/blank.go`, go('func C() {}'), go('func C() {}').replace('\t"fmt"\n', '\t"fmt"\n\t_ "net/http/pprof"\n'));
  both(`${H}/code.go`, go('func D() int { return 1 }'), go('func D() int { return 2 }'));
  both(`${H}/block.go`, go('/*\n * old words\n */\nfunc E() {}'), go('/*\n * new words\n */\nfunc E() {}'));
  both(`${H}/pointer.go`, go('func F(p *int) {\n\t*p = 1\n}'), go('func F(p *int) {\n\t*p = 2\n}'));
  write(path.join(newRoot, 'RevHero-user-fe-backend/cmd/extra.go'), 'package main\n\nfunc init() {}\n');
  write(path.join(oldRoot, 'RevHero-user-fe-backend/cmd/main.go'), 'package main\n');
  write(path.join(newRoot, 'RevHero-user-fe-backend/cmd/main.go'), 'package main\n');
  const diff = snapshotDiff(oldRoot, newRoot, ['RevHero-user-fe-backend']);
  assert.deepEqual(changedPlumbing(diff, oldRoot, newRoot), [
    'RevHero-user-fe-backend/cmd/extra.go',
    `${H}/blank.go`,
    `${H}/code.go`,
    `${H}/pointer.go`,
  ], 'comment, named-import and block-comment edits are inert; a blank import, code, a pointer write and a new file count');
  assert.equal(changedPlumbing(diff).length, 7, 'without the snapshots every touched file counts (path-only, conservative)');
  const ghost = `diff --git a/${H}/ghost.go b/${H}/ghost.go\n@@ -1,0 +2 @@\n+// a comment, but the file cannot be read\n`;
  assert.deepEqual(changedPlumbing(ghost, oldRoot, newRoot), [`${H}/ghost.go`], 'a side that cannot be read counts as changed');
});

// Modeled on the real router: clients, the revocation store and seat guard, a rate limiter, handlers, registrations
// (one with inline middleware, one multi-line), a conditional block and a route mount.
const SRC = `package routes

import (
\t"revhero/x/internal/middleware_auth"
\t"github.com/gin-gonic/gin"
)

func SetupRouter(router *gin.Engine) {
\tv1Group := router.Group("/v1")

\tusersClient := users.NewClient(config.GlobalConfig.UsersURL)
\tusersClient.SetInternalSecret(config.GlobalConfig.InternalServicesWebhookSecret)
\tdocsClient := docs.NewClient(config.GlobalConfig.DocsURL)
\tdocsClient.SetInternalSecret(config.GlobalConfig.InternalServicesWebhookSecret)
\tcfg := cache.Config{
\t\tAddr: config.GlobalConfig.RedisAddr,
\t}
\tcacheTTL := 30
\tstore := revocation.NewStore(redisClient, cacheTTL)
\tmiddleware_auth.SetRevocationChecker(store)
\tmiddleware_auth.InstallSeatGuard(usersClient)
\tlimiter := helpers.NewFixedWindowRateLimiter(redisClient)
\tloginLimiter := helpers.NewFixedWindowRateLimiter(redisClient)
\tauthService := auth.NewService(usersClient, loginLimiter)
\tuploadService := upload.NewService(docsClient)
\tuploadHandler := upload.NewHandler(uploadService)
\tdealHandler := deal.NewHandler(usersClient)
\tv1Group.POST("/uploads", middleware_auth.JWTAuth(), uploadHandler.Upload)
\tv1Group.GET("/deals",
\t\tmiddleware_auth.JWTAuth(),
\t\tdealHandler.List)
\tif cacheTTL > 0 {
\t\tdocsClient.SetTimeout(cacheTTL)
\t}
\tsetupPublicRoutes(v1Group.Group("/public"), limiter)
}
`;
const LINES = SRC.split('\n');
const at = (s) => { const n = LINES.findIndex((l) => l.includes(s)) + 1; assert.ok(n > 0, `fixture line ${s}`); return n; };

test('classifier: comments, imports and wiring of clients that feed only handlers are inert', () => {
  const A = analyzeRouterSource(LINES);
  for (const s of ['docsClient.SetInternalSecret', 'docsClient := docs', 'uploadService :=', '"github.com/gin-gonic/gin"']) {
    assert.equal(lineIsInert(at(s), LINES, A), true, `${s} should be inert`);
  }
  assert.equal(lineIsInert(at('') || 2, LINES, A), true, 'a blank line');
});

test('classifier: route-shaping lines and the security or permission setup are always kept', () => {
  const A = analyzeRouterSource(LINES);
  const keep = {
    'usersClient.SetInternalSecret': 'the seat guard is built on usersClient',
    'usersClient := users': 'same object, its construction',
    'cacheTTL := 30': 'flows into the revocation store',
    'store := revocation': 'the revocation store',
    'SetRevocationChecker': 'a middleware setter',
    'InstallSeatGuard': 'a middleware setter',
    'limiter := helpers': 'a rate limiter',
    'loginLimiter := helpers': 'a rate limiter no route or middleware names directly (security words)',
    'authService := auth': 'auth wiring no route or middleware names directly (security words)',
    'uploadHandler := upload': 'a handler a route statement names',
    'dealHandler := deal': 'a handler a route statement names',
    'v1Group.POST': 'a registration',
    'v1Group.GET("/deals"': 'a multi-line registration (first line)',
    'middleware_auth.JWTAuth(),': 'a multi-line registration (continuation)',
    'dealHandler.List)': 'a multi-line registration (last line)',
    'if cacheTTL > 0': 'control flow',
    'docsClient.SetTimeout': 'inside a conditional block (a move across its boundary would look harmless line by line)',
    'setupPublicRoutes': 'a route mount',
    'func SetupRouter': 'a function signature',
    'v1Group := router': 'a group',
    'import (': 'the import block itself',
    'Addr: config': 'a line inside a multi-line statement is never judged alone',
  };
  for (const [s, why] of Object.entries(keep)) assert.equal(lineIsInert(at(s), LINES, A), false, `${s} must be kept: ${why}`);
  const brace = LINES.indexOf('\t}', at('if cacheTTL > 0')) + 1; // the if block's brace (not the literal's)
  assert.equal(lineIsInert(brace, LINES, A), false, 'a lone closing brace moves block structure');
});

test('classifier: blank imports, directives, block comments vs pointer writes, and raw strings', () => {
  const src = ['package routes', 'import (', '\t"fmt"', '\t_ "net/http/pprof"', ')', '//go:build linux', 'func f() {',
    '\t/*', '\t * v1Group.GET("/x", h)', '\t */', '\t*cfg = other', '\ttmpl := `', 'v1Group.GET("/y", h)', '`', '}', ''];
  const A = analyzeRouterSource(src);
  const n = (s) => src.indexOf(s) + 1;
  assert.equal(lineIsInert(n('\t"fmt"'), src, A), true, 'a named import spec');
  assert.equal(lineIsInert(n('\t_ "net/http/pprof"'), src, A), false, 'a blank import runs init side effects (pprof registers routes)');
  assert.equal(lineIsInert(n('//go:build linux'), src, A), false, 'a build directive');
  assert.equal(lineIsInert(n('\t * v1Group.GET("/x", h)'), src, A), true, 'inside a block comment');
  assert.equal(lexGo(src)[n('\t*cfg = other') - 1].code.trim(), '*cfg = other', 'a pointer write is code, not a comment continuation');
  assert.equal(lineIsInert(n('v1Group.GET("/y", h)'), src, A), false, 'inside a multi-line raw string');
});

/** Old = SRC, new = `edit(SRC)`; returns the relax result for the router section. */
function relaxed(edit) {
  const root = tmpDir('qafill-relax-');
  const oldRoot = path.join(root, 'old');
  const newRoot = path.join(root, 'new');
  write(path.join(oldRoot, ROUTER_REL), SRC);
  write(path.join(newRoot, ROUTER_REL), edit(SRC));
  write(path.join(oldRoot, 'RevHero-user-fe-backend', 'other.go'), '// a\n');
  write(path.join(newRoot, 'RevHero-user-fe-backend', 'other.go'), '// b\n');
  const diff = snapshotDiff(oldRoot, newRoot, ['RevHero-user-fe-backend']);
  return { diff, ...relaxRouterDiff(diff, [ROUTER_REL], oldRoot, newRoot), oldRoot, newRoot };
}

test('relax: an inert-only router diff disappears entirely; other files are never filtered', () => {
  const r = relaxed((s) => s.replace('\tcacheTTL := 30', '\tdocsClient.SetRetries(3)\n\tcacheTTL := 30').replace('import (', '// routes wires every endpoint\nimport ('));
  const i = r.info[ROUTER_REL];
  assert.equal(i.reliable, true);
  assert.equal(i.hunks, 2);
  assert.equal(i.dropped, 2);
  assert.equal(r.diffText.includes(`a/${ROUTER_REL}`), false, 'no header-only section is left (it would read as whole-file touched)');
  assert.equal(r.diffText.includes('a/RevHero-user-fe-backend/other.go'), true, 'a comment edit in another file is untouched by the relaxation');
});

test('relax: a middleware, Use, or continuation-line edit keeps its hunk', () => {
  for (const [label, edit] of [
    ['.Use(', (s) => s.replace('\tv1Group := router.Group("/v1")', '\tv1Group := router.Group("/v1")\n\tv1Group.Use(cors.Default())')],
    ['continuation', (s) => s.replace('\t\tmiddleware_auth.JWTAuth(),', '\t\tmiddleware_auth.OptionalAuth(),')],
    ['security object', (s) => s.replace('cacheTTL := 30', 'cacheTTL := 1')],
    ['seat-guard client', (s) => s.replace('usersClient.SetInternalSecret(config.GlobalConfig.InternalServicesWebhookSecret)', 'usersClient.SetInternalSecret(config.GlobalConfig.OtherSecret)')],
    ['brace move', (s) => s.replace('\t\tdocsClient.SetTimeout(cacheTTL)\n\t}', '\t}\n\t\tdocsClient.SetTimeout(cacheTTL)')],
  ]) {
    const i = relaxed(edit).info[ROUTER_REL];
    assert.ok(i.kept >= 1, `${label}: kept ${i.kept} of ${i.hunks}`);
  }
});

test('relax: a diff that does not match the files read is unreliable and keeps everything', () => {
  const r = relaxed((s) => s.replace('\tcacheTTL := 30', '\tdocsClient.SetRetries(3)\n\tcacheTTL := 30'));
  write(path.join(r.newRoot, ROUTER_REL), SRC.replace('package routes', 'package routes\n// drifted after the diff'));
  const again = relaxRouterDiff(r.diff, [ROUTER_REL], r.oldRoot, r.newRoot);
  assert.equal(again.info[ROUTER_REL].reliable, false);
  assert.equal(again.info[ROUTER_REL].kept, 1);
  assert.equal(remapCitedLines('23', again.info[ROUTER_REL]), null, 'no line-level carry off an unreliable diff');
});

test('line level: citations below an insertion move with it; overlap, out-of-range and unparsable stay changed', () => {
  const r = relaxed((s) => s.replace('\tcacheTTL := 30', '\tdocsClient.SetRetries(3)\n\tcacheTTL := 30'));
  const i = r.info[ROUTER_REL];
  const post = at('v1Group.POST');
  assert.equal(remapCitedLines(`${post}`, i), `${post + 1}`, 'the registration moved down one line');
  assert.equal(remapCitedLines(`${at('usersClient := users')}-${at('usersClient.SetInternal')}`, i), `${at('usersClient := users')}-${at('usersClient.SetInternal')}`, 'above the insertion: unmoved');
  assert.equal(remapCitedLines(`9,${post}`, i), `9,${post + 1}`, 'a multi-range citation remaps range by range');
  const ins = at('cacheTTL := 30') - 1; // the insertion lands right after this old line
  assert.equal(remapCitedLines(`${ins}`, i), `${ins}`, 'an insertion AFTER the cited line does not touch it');
  assert.equal(remapCitedLines(`${ins}-${ins + 1}`, i), null, 'an insertion INSIDE the cited range overlaps it');
  assert.equal(remapCitedLines('9999', i), null, 'out of range');
  assert.equal(remapCitedLines('abc', i), null, 'unparsable');
  assert.equal(remapCitedLines(null, i), null, 'no line numbers = whole file');
  assert.equal(remapCitedLines(`${post}–${post + 1}`, i), `${post + 1}-${post + 2}`, 'an en dash range parses');
});

test('line level: a deleted cited line is changed; layer 2 uses it only for the router file', () => {
  const r = relaxed((s) => s.replace('\tlimiter := helpers.NewFixedWindowRateLimiter(redisClient)\n', ''));
  const i = r.info[ROUTER_REL];
  assert.equal(remapCitedLines(`${at('limiter := helpers')}`, i), null);
  assert.equal(remapCitedLines(`${at('v1Group.POST')}`, i), `${at('v1Group.POST') - 1}`);
  const lineLevel = { [ROUTER_REL]: i };
  const cite = (lines, p = 'internal/routes/routes.go') => [{ repo: 'RevHero-user-fe-backend', path: p, lines }];
  assert.equal(citedFilesUnchanged(cite(`${at('v1Group.POST')}`), r.oldRoot, r.newRoot, null, lineLevel).unchanged, true);
  assert.equal(citedFilesUnchanged(cite(null), r.oldRoot, r.newRoot, null, lineLevel).unchanged, false, 'no lines: whole file, changed');
  assert.equal(citedFilesUnchanged(cite(`${at('v1Group.POST')}`), r.oldRoot, r.newRoot, null, null).unchanged, false, 'strict: whole file');
  assert.equal(citedFilesUnchanged(cite('1', 'other.go'), r.oldRoot, r.newRoot, null, lineLevel).unchanged, false, 'another file is never line-level');
});
