# syntax=docker/dockerfile:1
# Production image for forvia-core — ghcr.io/nebula-syst/forvia-core, built and pushed by
# .github/workflows/docker-publish.yml. Build context is the repo root:
#
#   docker build -f docker/prod/Dockerfile .

# Runtime dependencies only, installed exactly as locked (npm ci fails on a stale lockfile
# instead of silently resolving something else).
FROM node:25-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:25-alpine

ARG VERSION=dev
ARG VCS_REF=dev
ARG BUILD_DATE=unknown

LABEL maintainer="Nebula Systems https://github.com/Nebula-Syst" \
    org.opencontainers.image.title="forvia-core" \
    org.opencontainers.image.description="Forvia's openGym-derived core: auth, sessions, workout/routine/nutrition sync, base admin panel." \
    org.opencontainers.image.source="https://github.com/Nebula-Syst/forvia-core" \
    org.opencontainers.image.url="https://github.com/Nebula-Syst/forvia-core/pkgs/container/forvia-core" \
    org.opencontainers.image.documentation="https://github.com/Nebula-Syst/forvia-core#readme" \
    org.opencontainers.image.licenses="AGPL-3.0-or-later" \
    org.opencontainers.image.version=$VERSION \
    org.opencontainers.image.revision=$VCS_REF \
    org.opencontainers.image.created=$BUILD_DATE

# tini: PID 1 that forwards SIGTERM, so `docker stop` doesn't wait out its 10 s timeout.
# su-exec: drops from root to `node` in the entrypoint once /data is owned by it.
RUN apk add --no-cache tini su-exec

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js db.js ./
COPY --chmod=755 docker/prod/entrypoint.sh /usr/local/bin/forvia-entrypoint
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--", "forvia-entrypoint"]
CMD ["node", "server.js"]

HEALTHCHECK --start-period=10s \
            --interval=15s \
            --timeout=5s \
            --retries=3 \
            CMD wget --spider -q "http://127.0.0.1:${PORT}/api/health" || exit 1
