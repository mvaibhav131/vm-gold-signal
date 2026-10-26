#!/usr/bin/env bash
# The one way to run docker compose for this stack: the project name, the compose file and the root-owned .env are
# always the same, whoever calls it (the deploy script, the systemd timers, the owner over SSH).
#   sudo /opt/vmgs/deploy/scripts/compose.sh ps
#   sudo /opt/vmgs/deploy/scripts/compose.sh logs -f worker
# VMGS_COMPOSE_FILES adds compose files (paths relative to the repository), VMGS_ENV_FILE another environment file,
# VMGS_PROJECT another project name: that is how the drills and the tests run beside a real stack.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${VMGS_ENV_FILE:-$ROOT/.env}"
[[ -f "$ENV_FILE" ]] || { echo "compose.sh: $ENV_FILE does not exist (copy deploy/env.example)" >&2; exit 1; }

files=(--file "$ROOT/deploy/docker-compose.yml")
for extra in ${VMGS_COMPOSE_FILES:-}; do
  files+=(--file "$ROOT/$extra")
done

exec docker compose \
  --project-name "${VMGS_PROJECT:-vmgs}" \
  --env-file "$ENV_FILE" \
  "${files[@]}" \
  "$@"
