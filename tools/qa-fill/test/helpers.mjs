import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir(prefix = 'qafill-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// The shared extractor lives outside this repo (~/.claude/scripts). Integration tests that need it skip with a clear
// message when it is absent (e.g. in CI); set QA_EXTRACTOR to point at a copy.
export const EXTRACTOR = process.env.QA_EXTRACTOR || path.join(os.homedir(), '.claude', 'scripts', 'qa-surface-inventory.js');
export const HAVE_EXTRACTOR = fs.existsSync(EXTRACTOR);

export const ROUTER = `package routes

import "github.com/gin-gonic/gin"

func SetupRouter(router *gin.Engine) {
\tv1Group := router.Group("/v1")
\tsetupDealRoutes(v1Group.Group("/deals"), nil)
\tsetupCampaignRoutes(v1Group.Group("/campaigns"), nil)
}

func setupDealRoutes(group *gin.RouterGroup, h interface{}) {
\tgroup.GET("/list", h)
\tgroup.GET("/detail/:id", h)
}

func setupCampaignRoutes(group *gin.RouterGroup, h interface{}) {
\tgroup.POST("/create", h)
}
`;

export const ROUTER_REL = 'RevHero-user-fe-backend/internal/routes/routes.go';

/** A temp project with an old and a new snapshot of the fixture router and a contract scanning the NEW one. */
export function routerFixture({ newRouter = ROUTER } = {}) {
  const root = tmpDir();
  const oldRoot = path.join(root, 'snap-old');
  const newRoot = path.join(root, 'snap-new');
  write(path.join(oldRoot, ROUTER_REL), ROUTER);
  write(path.join(newRoot, ROUTER_REL), newRouter);
  const project = path.join(root, 'project');
  const contract = path.join(project, 'qa-contract.json');
  write(contract, JSON.stringify({ surfaces: { source: [path.join(newRoot, ROUTER_REL)] } }, null, 2));
  return { root, oldRoot, newRoot, project, contract };
}
