# Single-stage Dockerfile — the trigger has no workspace deps so a plain
# npm install gets us to runtime. Multi-stage was tripping over pnpm's
# symlink layout when copied across image stages.
FROM node:20-alpine

WORKDIR /app

ENV PORT=3000

# Install both runtime + dev deps so tsc + @types/node are present, build,
# then prune to prod-only. Cleaner than juggling NODE_ENV mid-install.
COPY trigger/package.json ./package.json
RUN npm install --no-audit --no-fund

COPY trigger/tsconfig.json ./tsconfig.json
COPY trigger/src ./src
RUN npx tsc -p tsconfig.json

RUN npm prune --omit=dev

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/server.js"]
