#!/usr/bin/env bash
# Deploy (06_Phases_and_Setup section 4). Run on the VM over SSH, as root:
#   sudo /opt/vmgs/deploy/scripts/deploy.sh [--ref TAG_OR_BRANCH] [--first] [--skip-backup] [--images FILE]
# 1. a database backup (skipped on the first deploy, when there is nothing to save)
# 2. the release: git fetch and checkout of the ref (without --ref the checkout stays as it is)
# 3. the images: built here (the A1 builds linux/arm64 natively), or with --images FILE the ones that `pnpm ship:images`
#    built on your PC (a VM of 1 GB cannot build: the whole stack is the app image, and with COMPOSE_PROFILES=web the
#    one of caddy with the web app inside)
# 4. the environment check (with the web side also the one of the api)
# 5. the migrations (forward only; the backup of step 1 is the way back)
# 6. docker compose up -d
# 7. the smoke test, and then the release is written to .version, which compose.sh uses from then on
# Rolling back: deploy.sh --ref PREVIOUS_TAG. If a migration ran in between, the older code refuses the newer
# database; then restore the backup of step 1 first (deploy/README.md, "Restore").
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENV_FILE="${VMGS_ENV_FILE:-$ROOT/.env}"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

ref=""
images=""
skip_backup=false
while (($#)); do
  case "$1" in
    --ref) ref="${2:?--ref needs a tag or branch}"; shift 2 ;;
    --images) images="${2:?--images needs the file that pnpm ship:images made}"; shift 2 ;;
    --first) skip_backup=true; shift ;;
    --skip-backup) skip_backup=true; shift ;;
    *) echo "usage: deploy.sh [--ref TAG_OR_BRANCH] [--first] [--skip-backup] [--images FILE]" >&2; exit 2 ;;
  esac
done

((EUID == 0)) || { echo "deploy.sh: run it as root (sudo)" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "deploy.sh: $ENV_FILE is missing (copy deploy/env.example)" >&2; exit 1; }
if [[ "$(stat -c '%U %a' "$ENV_FILE")" != "root 600" ]]; then
  echo "deploy.sh: $ENV_FILE must be owned by root with mode 600 (chown root:root, chmod 600)" >&2
  exit 1
fi
[[ -r "${VMGS_SECRETS_DIR:-$ROOT/secrets}/rclone.conf" ]] || say "warning: no secrets/rclone.conf yet: the backup cannot run until it exists"

previous="$(git -C "$ROOT" describe --tags --always 2>/dev/null || echo unknown)"
if [[ -n "$ref" ]]; then
  [[ -z "$(git -C "$ROOT" status --porcelain)" ]] || { echo "deploy.sh: the checkout has local changes" >&2; exit 1; }
  say "fetching $ref"
  git -C "$ROOT" fetch --tags --prune origin
  git -C "$ROOT" checkout --detach "$ref"
fi
VMGS_VERSION="$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo local)"
web=false
if web_on; then web=true; fi
if [[ -n "$images" ]]; then
  say "loading the images made on your PC ($images)"
  VMGS_VERSION="$(load_images "$images")"
  if $web && ! docker image inspect "vmgs-web:$VMGS_VERSION" >/dev/null 2>&1; then
    echo "deploy.sh: $images has no vmgs-web:$VMGS_VERSION image, and COMPOSE_PROFILES has web" >&2
    exit 1
  fi
fi
export VMGS_VERSION
say "deploying $VMGS_VERSION (previous: $previous)"

if [[ -z "$images" ]]; then
  say "building the image (one image for the worker, the api, the migrations and the backup jobs)"
  compose build worker
  if $web; then
    say "building the web image (caddy with the web app inside)"
    compose --profile web build caddy
  fi
fi

say "checking the environment"
compose run --rm --no-deps -T migrate node --import tsx src/cli/main.ts env:check admin
compose run --rm --no-deps -T worker node --import tsx src/cli/main.ts env:check worker
compose --profile ops run --rm --no-deps -T backup node --import tsx src/cli/main.ts env:check backup
if $web; then
  # what the api service would get, checked in its own container (the key of the authentication, its database role)
  compose --profile web run --rm --no-deps -T -w /app/apps/worker api node --import tsx src/cli/main.ts env:check api
fi

if $skip_backup; then
  say "no backup before this deploy"
else
  say "backing up the database first"
  compose up -d db
  wait_for 120 "the database is healthy" db_healthy
  compose --profile ops run --rm -T backup
fi

say "migrating"
compose up -d db
wait_for 120 "the database is healthy" db_healthy
compose run --rm -T migrate

say "starting the stack"
compose up -d --remove-orphans
wait_for 300 "the worker is healthy" worker_healthy || true
if $web; then wait_for 120 "the api is healthy" api_healthy || true; fi

say "smoke test"
if "$HERE/smoke.sh"; then
  printf '%s %s (previous %s)\n' "$(date -u +%FT%TZ)" "$VMGS_VERSION" "$previous" >>"$ROOT/.deployed"
  printf '%s\n' "$VMGS_VERSION" >"$ROOT/.version"
  say "deployed $VMGS_VERSION"
else
  say "the smoke test failed. Look: compose.sh logs --tail 100 worker (or api, caddy). Way back: deploy.sh --ref $previous"
  exit 1
fi
