#!/usr/bin/env bash
# The one way to run docker compose for this stack: the project name, the compose file and the root-owned .env are
# always the same, whoever calls it (the deploy script, the systemd timers, the owner over SSH).
#   sudo /opt/vmgs/deploy/scripts/compose.sh ps
#   sudo /opt/vmgs/deploy/scripts/compose.sh logs -f worker
# VMGS_COMPOSE_FILES adds compose files (paths relative to the repository), VMGS_ENV_FILE another environment file,
# VMGS_PROJECT another project name: that is how the drills and the tests run beside a real stack.
# Without VMGS_COMPOSE_FILES in the environment the line of the .env is used (a 1 GB VM has `deploy/small-vm.yml` there),
# and without VMGS_VERSION the release that the last good deploy wrote to .version: so the systemd timers and the owner
# over SSH always see the stack that deploy.sh started. A different file list or image would make compose recreate the
# database or try to build an image on the VM.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${VMGS_ENV_FILE:-$ROOT/.env}"
[[ -f "$ENV_FILE" ]] || { echo "compose.sh: $ENV_FILE does not exist (copy deploy/env.example)" >&2; exit 1; }

extras="${VMGS_COMPOSE_FILES:-}"
if [[ -z "$extras" ]]; then
  extras="$(sed -n 's/^VMGS_COMPOSE_FILES=//p' "$ENV_FILE" | tail -n 1 | tr -d '"\r')"
fi
if [[ -z "${VMGS_VERSION:-}" && -r "$ROOT/.version" ]]; then
  VMGS_VERSION="$(head -n 1 "$ROOT/.version")"
  export VMGS_VERSION
fi

files=(--file "$ROOT/deploy/docker-compose.yml")
for extra in $extras; do
  files+=(--file "$ROOT/$extra")
done

exec docker compose \
  --project-name "${VMGS_PROJECT:-vmgs}" \
  --env-file "$ENV_FILE" \
  "${files[@]}" \
  "$@"
