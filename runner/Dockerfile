# Multi-stage build for the QA runner.
# Builder pulls deps + transpiles. Runtime ships the Playwright official image
# (jammy, ~360 MB compressed) with chromium pre-installed.

FROM node:20-alpine AS builder
WORKDIR /app

RUN corepack enable

# Copy lockfile + workspace metadata first to maximise Docker layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY runner/package.json ./runner/
COPY audit/package.json ./audit/

RUN pnpm install --frozen-lockfile

# Now copy sources. Tests are required at runtime (vitest reads them).
COPY shared ./shared
COPY runner ./runner
COPY registry.json ./registry.json
COPY scripts ./scripts

# No build step needed — vitest runs TS directly via tsx-style compilation.

FROM mcr.microsoft.com/playwright:v1.59.1-jammy AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PWHEADLESS=true
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@9.12.3 --activate \
 && apt-get update && apt-get install -y --no-install-recommends \
      gh \
      ca-certificates \
      git \
 && rm -rf /var/lib/apt/lists/*

# Copy installed node_modules and source from builder.
COPY --from=builder /app /app

# Reports volume — Dokploy mounts /mnt/qa-reports here.
VOLUME ["/mnt/qa-reports"]
ENV QA_REPORT_DIR=/mnt/qa-reports

# Default entrypoint runs the scheduled suite. CI overrides via the `ci.sh`
# script when invoked from a workflow_dispatch.
ENTRYPOINT ["bash", "/app/runner/runner/scheduled.sh"]
