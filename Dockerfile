FROM node:22-alpine

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

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js db.js ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
CMD ["node", "server.js"]

HEALTHCHECK --start-period=10s \
            --interval=15s \
            --timeout=5s \
            --retries=3 \
            CMD wget --spider -q "http://127.0.0.1:${PORT}/api/health" || exit 1
