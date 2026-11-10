import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGinRoutes, hintFor, joinPath } from '../lib/routes.mjs';

const SRC = `package routes

func SetupRouter(router *gin.Engine) {
\tv1Group := router.Group("/v1")
\tprotectedGroup := v1Group.Group("/")
\tsetupAuthRoutes(v1Group.Group("/auth"), h)
\tsetupDealRoutes(protectedGroup.Group("/deals", mw), h)
\tsetupCampaignRoutes(protectedGroup.Group("/campaigns"), h)
\tv1Group.GET("/health", h)
}

func setupAuthRoutes(group *gin.RouterGroup, handler *x) {
\tgroup.POST("/login", handler.Login)
}

func setupDealRoutes(group *gin.RouterGroup, handler *x) {
\tgroup.GET("/:id", handler.Get)
\tnotes := group.Group("/notes")
\tnotes.GET("/", handler.Notes)
}

func setupCampaignRoutes(group *gin.RouterGroup, handler *x) {
\tgroup.GET("/:id", handler.Get)
}
`;

test('joinPath collapses slashes and drops a trailing slash', () => {
  assert.equal(joinPath('/v1/', '/deals'), '/v1/deals');
  assert.equal(joinPath('', '/'), '/');
  assert.equal(joinPath('/v1/deals/notes', '/'), '/v1/deals/notes');
});

test('prefixes propagate through group assignments and call sites, including middleware args', () => {
  const { routes } = parseGinRoutes(SRC);
  const full = routes.flatMap((r) => r.full.map((f) => `${r.verb} ${f}`)).sort();
  assert.deepEqual(full, [
    'GET /v1/campaigns/:id',
    'GET /v1/deals/:id',
    'GET /v1/deals/notes',
    'GET /v1/health',
    'POST /v1/auth/login',
  ]);
});

test('hintFor: a unique relative path resolves; a shared one lists every candidate', () => {
  const parsed = parseGinRoutes(SRC);
  assert.deepEqual(hintFor({ path: 'routes:/login', verbs: ['POST'] }, parsed), { resolved: 'POST /v1/auth/login', candidates: ['POST /v1/auth/login'] });
  const shared = hintFor({ path: 'routes:/:id', verbs: ['GET'] }, parsed);
  assert.equal(shared.resolved, null);
  assert.deepEqual(shared.candidates, ['GET /v1/campaigns/:id', 'GET /v1/deals/:id']);
});

test('an unresolvable prefix stays visible as "?" instead of a guessed path', () => {
  const { routes } = parseGinRoutes('func orphan(g *gin.RouterGroup) {\n\tg.GET("/x", h)\n}\n');
  assert.deepEqual(routes[0].full, ['?/x']);
});
