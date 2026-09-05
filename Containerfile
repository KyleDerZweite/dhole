FROM docker.io/library/node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS base
WORKDIR /app

FROM base AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10.29.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/node/package.json ./apps/node/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY apps/server ./apps/server
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared
RUN pnpm --filter @dhole-control/shared build \
    && pnpm --filter @dhole-control/server build \
    && pnpm --filter @dhole-control/web build \
    && pnpm --filter @dhole-control/server deploy --legacy --prod /production/server \
    && npm --prefix /production/server rebuild better-sqlite3 \
    && node -e "const Database = require('/production/server/node_modules/better-sqlite3'); const db = new Database(':memory:'); db.close()"

FROM base AS runtime
ENV NODE_ENV=production \
    DHOLE_HOST=0.0.0.0 \
    DHOLE_PORT=4173 \
    DHOLE_DATABASE=/app/data/dhole.db
COPY --from=build /production/server/node_modules ./apps/server/node_modules
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/migrations ./apps/server/migrations
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY LICENSE THIRD_PARTY_NOTICES.md ./
RUN mkdir -p /app/data /run/secrets \
    && chown 1000:1000 /app/data \
    && chmod 0700 /app/data
USER 1000:1000
EXPOSE 4173
STOPSIGNAL SIGTERM
ENTRYPOINT ["/bin/sh", "-c", "chmod 0700 /app/data && exec \"$@\"", "--"]
CMD ["node", "--enable-source-maps", "apps/server/dist/index.js"]
