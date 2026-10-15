# syntax=docker/dockerfile:1.7
#
# Tournament Genie's image (ADR-0009, ADR-0011): the Nuxt server behind the kit's entrypoint (PUID/PGID, gosu,
# UMASK, optional Litestream). The entrypoint, litestream.yml and the Litestream installer come from
# @towerism/selfhost-kit through `selfhost-kit docker-assets`; this file is Genie's own.

ARG NODE_SLIM_IMAGE=node:24.21.0-slim
ARG NODE_ALPINE_IMAGE=node:24.21.0-alpine3.23
# Keep in step with package.json's packageManager: Renovate bumps both in one PR (the comment below is its marker).
# renovate: datasource=npm depName=pnpm
ARG PNPM_VERSION=11.28.5

FROM ${NODE_SLIM_IMAGE} AS app-build
ARG PNPM_VERSION
WORKDIR /app
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# No lifecycle scripts: `nuxt prepare` needs the sources (`nuxt build` prepares anyway), and better-sqlite3
# ships prebuilt binaries in its package.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm run build \
 && pnpm exec selfhost-kit docker-assets .output/selfhost-kit

# The one Litestream release the kit pins, verified by the kit's script; only the binary is copied on.
FROM ${NODE_ALPINE_IMAGE} AS litestream
ARG TARGETARCH
COPY --from=app-build /app/.output/selfhost-kit/fetch-litestream.sh /tmp/fetch-litestream.sh
RUN sh /tmp/fetch-litestream.sh /opt/litestream

FROM ${NODE_SLIM_IMAGE} AS app
# gosu: drop root after fixing /data ownership. tini: PID 1 that forwards SIGTERM.
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu tini \
 && rm -rf /var/lib/apt/lists/* \
 && gosu nobody true
WORKDIR /app
COPY --from=app-build /app/.output ./.output
COPY --from=app-build /app/server/db/migrations ./server/db/migrations
COPY --from=litestream /opt/litestream/litestream /usr/local/bin/litestream
COPY --from=app-build /app/.output/selfhost-kit/litestream.yml /etc/litestream.yml
COPY --from=app-build /app/.output/selfhost-kit/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN rm -rf .output/selfhost-kit
# Port 3001 sits beside attendance's 3000; the template publishes it only on the host's loopback (ADR-0013).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    PUID=99 \
    PGID=100 \
    UMASK=022 \
    NUXT_DATABASE_PATH=/data/app.db \
    NUXT_MIGRATIONS_DIR=/app/server/db/migrations \
    NITRO_SHUTDOWN_TIMEOUT=8000
VOLUME ["/data"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["tini", "--", "entrypoint.sh"]
CMD ["node", ".output/launcher.mjs"]
