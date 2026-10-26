# One image for everything that runs this repository's code: the worker, the migrations, the backup, the restore
# drill (and, later, the api). It is built on the VM itself from the tagged release, so the A1 builds linux/arm64
# natively. Build context: the repository root (`docker compose -f deploy/docker-compose.yml build`).
#
# The code runs with tsx, as it does in development: what runs in production is what the tests ran.
ARG NODE_IMAGE=node:24.22.1-alpine3.24

FROM ${NODE_IMAGE} AS deps
RUN npm install --global pnpm@10.34.7
WORKDIR /app
# The manifests of every project of the workspace come first (the lockfile describes all of them), so that a change
# of code does not install the packages again.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY e2e/package.json e2e/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/feed/package.json packages/feed/
COPY tools/research/package.json tools/research/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@vmgs/worker..."

FROM ${NODE_IMAGE} AS app
# postgresql17-client (pg_dump, pg_restore, psql) matches the database image; age and rclone are for the backup.
RUN apk add --no-cache tini bash curl ca-certificates postgresql17-client age rclone
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/ ./
COPY tsconfig.base.json ./
COPY apps/worker/ apps/worker/
COPY packages/config/ packages/config/
COPY packages/contracts/ packages/contracts/
COPY packages/core/ packages/core/
COPY packages/db/ packages/db/
COPY packages/feed/ packages/feed/
COPY --chmod=755 deploy/scripts/backup.sh deploy/scripts/restore-drill.sh /opt/vmgs/bin/
USER node
WORKDIR /app/apps/worker
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "src/main.ts"]
