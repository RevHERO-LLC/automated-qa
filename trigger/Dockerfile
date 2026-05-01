# Multi-stage: install + compile in one layer, ship a slim runtime.
FROM node:20-alpine AS builder

WORKDIR /repo

# Bring the workspace manifests in first so the Docker layer cache survives
# unrelated source-file edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY shared/package.json shared/
COPY trigger/package.json trigger/

RUN corepack enable && corepack prepare pnpm@9.12.3 --activate
RUN pnpm install --frozen-lockfile --filter @revhero/qa-trigger... --filter @revhero/qa-shared

# Now bring source. Shared is consumed via TS source (not built), so we copy
# it directly. Trigger compiles to dist/.
COPY shared shared
COPY trigger trigger

WORKDIR /repo/trigger
RUN pnpm exec tsc -p tsconfig.json

# Runtime image — strip dev deps + reuse the same node base.
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy compiled trigger + shared sources + production node_modules.
COPY --from=builder /repo/trigger/dist /app/dist
COPY --from=builder /repo/trigger/package.json /app/package.json
COPY --from=builder /repo/shared /app/shared
COPY --from=builder /repo/node_modules /app/node_modules
COPY --from=builder /repo/trigger/node_modules /app/trigger-node_modules

# Fastify resolves modules from /app/node_modules — symlink the trigger's
# scoped deps into place so `import "fastify"` works at runtime.
RUN if [ -d /app/trigger-node_modules ]; then cp -rn /app/trigger-node_modules/. /app/node_modules/; fi

EXPOSE 3000

CMD ["node", "dist/server.js"]
