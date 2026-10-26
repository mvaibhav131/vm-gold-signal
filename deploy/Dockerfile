# Two images come out of this file, both built on the VM itself from the tagged release (the A1 builds linux/arm64
# natively). Build context: the repository root (`deploy/scripts/compose.sh build`).
#
#   target `app`  one image for everything that runs this repository's code: the worker, the migrations, the backup,
#                 the restore drill and the api (compose runs the api with the `web` profile). The code runs with tsx,
#                 as it does in development: what runs in production is what the tests ran.
#   target `web`  Caddy with the built web app inside (`/srv/web`): the release is one thing, there is no dist
#                 directory to copy by hand.
ARG NODE_IMAGE=node:24.22.1-alpine3.24
ARG CADDY_IMAGE=caddy:2.11-alpine

# The manifests of every project of the workspace come first (the lockfile describes all of them), so that a change
# of code does not install the packages again.
FROM ${NODE_IMAGE} AS manifests
RUN npm install --global pnpm@10.34.7
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY e2e/package.json e2e/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/feed/package.json packages/feed/
COPY tools/research/package.json tools/research/

FROM manifests AS deps
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@vmgs/worker..." --filter "@vmgs/api..."

# The web app: Vite bundles it (and the code of `core` and `contracts` that it uses) into static files. Typechecking is
# a gate of the repository (`pnpm typecheck`), not a step of the image, so `tsc` is not needed here.
FROM manifests AS web-build
# `mock` until the screens are wired to the API (U5); the build of U5 turns it to `live`.
ARG VITE_DATA_SOURCE=mock
ENV VITE_DATA_SOURCE=${VITE_DATA_SOURCE}
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@vmgs/web..."
COPY tsconfig.base.json ./
COPY packages/core/ packages/core/
COPY packages/contracts/ packages/contracts/
COPY apps/web/ apps/web/
RUN pnpm --filter @vmgs/web exec vite build

FROM ${CADDY_IMAGE} AS web
COPY --from=web-build /app/apps/web/dist /srv/web

FROM ${NODE_IMAGE} AS app
# postgresql17-client (pg_dump, pg_restore, psql) matches the database image; age and rclone are for the backup.
RUN apk add --no-cache tini bash curl ca-certificates postgresql17-client age rclone
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/ ./
COPY tsconfig.base.json ./
COPY apps/worker/ apps/worker/
COPY apps/api/ apps/api/
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
