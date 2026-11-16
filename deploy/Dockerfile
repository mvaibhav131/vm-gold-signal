# Two images come out of this file, both built on the VM itself from the tagged release (the A1 builds linux/arm64
# natively). Build context: the repository root (`deploy/scripts/compose.sh build`).
#
# This file is at /Dockerfile and at /deploy/Dockerfile, the same text: a host that builds from a repository looks for
# ./Dockerfile (a plain `docker build .` builds the last stage, `all`: the worker, or the api and the website, by VMGS_ROLE),
# and the compose file and the scripts use deploy/Dockerfile with `--target app` and `--target web`. A test keeps the two
# files identical: change both.
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
# `live` is the API of the server, the only thing a release shows. `--build-arg VITE_DATA_SOURCE=mock` builds the simulated
# preview (it carries the `SIMULATED` badge) for a look at the screens without a backend.
ARG VITE_DATA_SOURCE=live
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

# The image for a host that builds from the repository and gives the container its TLS (a plain `docker build .`): the
# stage `app` plus the web app and Caddy. VMGS_ROLE picks what the container runs: the worker (the default), `site` (the api
# and the website) or `both` (deploy/scripts/entry.sh). The compose stack does not use this stage.
FROM app AS all
USER root
RUN mkdir -p /etc/caddy
COPY --from=web /usr/bin/caddy /usr/bin/caddy
COPY --from=web /srv/web /srv/web
COPY deploy/Caddyfile.site /etc/caddy/Caddyfile.site
COPY deploy/scripts/entry.sh /opt/vmgs/bin/
# The permissions are set by a command, not by `COPY --chmod`: the builder of some hosts (kaniko) ignores that flag, and
# a script made on Windows has no executable bit in git. The entry point also starts the script through bash, so it does
# not need the bit at all.
RUN chmod 755 /opt/vmgs/bin/entry.sh && chmod 644 /etc/caddy/Caddyfile.site
# the root of the container may be read-only: Caddy writes only under /tmp
ENV XDG_CONFIG_HOME=/tmp/caddy-config XDG_DATA_HOME=/tmp/caddy-data
# The port that the container listens on by default: the health page of the worker, or the website (PORT in the
# settings). Some hosts also ask for it in their own settings.
EXPOSE 8080
USER node
ENTRYPOINT ["/sbin/tini", "--", "bash", "/opt/vmgs/bin/entry.sh"]
CMD []
