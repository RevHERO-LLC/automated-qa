# Single-stage Dockerfile — the trigger has no workspace deps so a plain
# npm install gets us to runtime. Multi-stage was tripping over pnpm's
# symlink layout when copied across image stages.
FROM node:20-alpine

WORKDIR /app

ENV PORT=3000

# Install runtime deps. Keep NODE_ENV unset for the install step so dev
# deps (typescript) we add for the build don't get filtered out — flip
# NODE_ENV=production at runtime via the CMD env.
COPY trigger/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# Compile TS to JS at build time. typescript is a build-only dep — install
# it globally so the runtime image stays slim, then build, then ship.
COPY trigger/tsconfig.json ./tsconfig.json
COPY trigger/src ./src
RUN npm install -g typescript@5.6.3 \
 && tsc -p tsconfig.json \
 && npm uninstall -g typescript

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/server.js"]
