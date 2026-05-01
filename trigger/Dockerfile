# Single-stage Dockerfile — the trigger has no workspace deps so a plain
# npm install gets us to runtime. Multi-stage was tripping over pnpm's
# symlink layout when copied across image stages.
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Install runtime deps first for cache stability.
COPY trigger/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# Bring source + tsconfig and compile in-place. tsx isn't shipped at
# runtime (it's a dev dep) so we run tsc once at build time and ship the
# emitted JS only.
COPY trigger/tsconfig.json ./tsconfig.json
COPY trigger/src ./src
RUN npm install --no-save typescript@5.6.3 \
 && ./node_modules/.bin/tsc -p tsconfig.json \
 && rm -rf node_modules/typescript

EXPOSE 3000

CMD ["node", "dist/server.js"]
