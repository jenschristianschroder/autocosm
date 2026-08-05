# syntax=docker/dockerfile:1.7
#
# One image, three modes.
#
# The product constraint is explicit: never one process or container per agent. `web`, `tick` and
# `think` share the same compiled monorepo and the same storage adapter, so a build that works for
# one works for all three. The entrypoint dispatches on argv[0]/AUTOCOSM_MODE; there is no separate
# Dockerfile, no separate tag, and no drift between what the API sees and what the simulation sees.

# ---------------------------------------------------------------------------------------------
# deps — install once from the committed lockfile so the layer caches across source changes.
# ---------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/simulation/package.json packages/simulation/
COPY packages/storage/package.json packages/storage/
COPY packages/agent-runtime/package.json packages/agent-runtime/
COPY packages/observability/package.json packages/observability/
COPY apps/world-web/package.json apps/world-web/
COPY apps/world-tick/package.json apps/world-tick/
COPY apps/agent-think/package.json apps/agent-think/
COPY apps/web-client/package.json apps/web-client/

# BuildKit cache mounts (`--mount=type=cache`) are intentionally not used here: ACR Tasks builds
# with the classic (non-BuildKit) engine, which rejects `--mount`. A plain `npm ci` is functionally
# identical; it only forgoes cross-build reuse of the npm download cache.
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------------------------
# build — compile TypeScript and bundle the browser client into world-web/public.
# ---------------------------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json tsconfig.build.json ./
COPY packages packages
COPY apps apps

RUN npm run typecheck \
 && npm run build --workspace @autocosm/web-client

# ---------------------------------------------------------------------------------------------
# prune — production-only dependency tree for the three SERVER workspaces.
#
# `apps/web-client` is a build-time workspace: Vite bundles React and Babylon.js into
# world-web/public, and no server module ever imports them. Filtering the install to the three
# runtime workspaces keeps ~100 MB of browser libraries out of the image, which is roughly half
# the dependency tree and directly buys back cold-start time on a scale-to-zero app.
# ---------------------------------------------------------------------------------------------
FROM deps AS prune
WORKDIR /app
RUN npm ci --omit=dev --no-audit --no-fund \
      --workspace @autocosm/world-web \
      --workspace @autocosm/world-tick \
      --workspace @autocosm/agent-think \
      --include-workspace-root

# ---------------------------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    AUTOCOSM_MODE=web \
    AUTOCOSM_STATIC_ROOT=/app/apps/world-web/public \
    PORT=8080 \
    NODE_OPTIONS=--enable-source-maps

# Container Apps runs as this user; nothing in the image needs write access at runtime.
RUN useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin autocosm

COPY --from=prune  --chown=root:root /app/node_modules ./node_modules
COPY --from=build  --chown=root:root /app/package.json ./package.json

# Only the compiled output and each workspace's manifest — never src/, never tests.
COPY --from=build --chown=root:root /app/packages/domain/package.json        ./packages/domain/package.json
COPY --from=build --chown=root:root /app/packages/domain/dist                ./packages/domain/dist
COPY --from=build --chown=root:root /app/packages/simulation/package.json    ./packages/simulation/package.json
COPY --from=build --chown=root:root /app/packages/simulation/dist            ./packages/simulation/dist
COPY --from=build --chown=root:root /app/packages/storage/package.json       ./packages/storage/package.json
COPY --from=build --chown=root:root /app/packages/storage/dist               ./packages/storage/dist
COPY --from=build --chown=root:root /app/packages/agent-runtime/package.json ./packages/agent-runtime/package.json
COPY --from=build --chown=root:root /app/packages/agent-runtime/dist         ./packages/agent-runtime/dist
COPY --from=build --chown=root:root /app/packages/observability/package.json ./packages/observability/package.json
COPY --from=build --chown=root:root /app/packages/observability/dist         ./packages/observability/dist

COPY --from=build --chown=root:root /app/apps/world-web/package.json    ./apps/world-web/package.json
COPY --from=build --chown=root:root /app/apps/world-web/dist            ./apps/world-web/dist
COPY --from=build --chown=root:root /app/apps/world-web/public          ./apps/world-web/public
COPY --from=build --chown=root:root /app/apps/world-tick/package.json   ./apps/world-tick/package.json
COPY --from=build --chown=root:root /app/apps/world-tick/dist           ./apps/world-tick/dist
COPY --from=build --chown=root:root /app/apps/agent-think/package.json  ./apps/agent-think/package.json
COPY --from=build --chown=root:root /app/apps/agent-think/dist          ./apps/agent-think/dist

COPY --chown=root:root docker-entrypoint.sh /usr/local/bin/autocosm
# Strip any CR the file may have picked up on a Windows checkout. A `#!/bin/sh\r` shebang makes
# the kernel look for an interpreter literally named `/bin/sh\r`, which fails as an inscrutable
# "no such file or directory" against the entrypoint itself. .gitattributes prevents it; this
# makes the image correct even when built from a working tree that predates it.
RUN sed -i 's/\r$//' /usr/local/bin/autocosm && chmod 0555 /usr/local/bin/autocosm

USER autocosm
EXPOSE 8080

# Jobs have no ingress and exit on their own; the healthcheck only matters for `web`.
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "if(process.env.AUTOCOSM_MODE!=='web')process.exit(0);fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/autocosm"]
CMD ["web"]
