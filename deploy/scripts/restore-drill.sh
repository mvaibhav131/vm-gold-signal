#!/usr/bin/env bash
# The restore drill (06_Phases_and_Setup section 4). It runs inside the app image as the one-shot service `drill`
# (vmgs-restore-drill.timer starts it every month). It takes the NEWEST backup from the object storage, opens it with
# the drill key of the VM, restores it into a scratch database and compares what is there with the manifest of the
# backup and with the live database (apps/worker/src/ops/manifest.ts). The scratch database is dropped in any case.
# A failed drill pings /fail of its Healthchecks.io check, which alerts the owner.
set -Eeuo pipefail

log() { printf '%s [drill] %s\n' "$(date -u +%FT%TZ)" "$*"; }

: "${DATABASE_URL_ADMIN:?}" "${DATABASE_URL_BACKUP:?}" "${BACKUP_RCLONE_REMOTE:?}"
REMOTE="${BACKUP_RCLONE_REMOTE%/}"
export RCLONE_CONFIG="${RCLONE_CONFIG:-/run/secrets/rclone.conf}"
DRILL_KEY="${BACKUP_DRILL_KEY_FILE:-/run/secrets/drill.key}"

cli() { (trap - ERR; cd /app/apps/worker && node --import tsx src/cli/main.ts "$@"); }

ping() {
  [[ -n "${HEALTHCHECKS_DRILL_URL:-}" ]] || return 0
  local data=()
  [[ -z "${2:-}" ]] || data=(--data-raw "$2")
  curl -fsS -m 10 --retry 3 -o /dev/null "${data[@]}" "${HEALTHCHECKS_DRILL_URL%/}${1:-}" ||
    log "the external check could not be reached"
}

scratch="vmgs_drill_$(date -u +%Y%m%d%H%M%S)"
# The scratch database lives next to the live one: the same server, another name.
export DRILL_URL="${DATABASE_URL_ADMIN%/*}/$scratch"
work="$(mktemp -d)"
created=""

cleanup() {
  [[ -z "$created" ]] || psql "$DATABASE_URL_ADMIN" -X -q -c "DROP DATABASE IF EXISTS $scratch WITH (FORCE)" || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  trap - ERR
  log "FAILED at line $1"
  ping /fail "restore drill failed at line $1"
  exit 1
}
trap 'fail $LINENO' ERR

ping /start
[[ -r "$DRILL_KEY" ]] || { log "no drill key at $DRILL_KEY"; false; }

newest="$(rclone lsf --files-only "$REMOTE" | grep -E '^vmgs-[0-9]{8}T[0-9]{6}Z\.dump\.age$' | sort | tail -n 1 || true)"
[[ -n "$newest" ]] || { log "there is no backup in $REMOTE"; false; }
log "newest backup: $newest"
rclone copyto "$REMOTE/${newest%.dump.age}.manifest.json" "$work/manifest.json"

psql "$DATABASE_URL_ADMIN" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $scratch"
created=yes
rclone cat "$REMOTE/$newest" | age -d -i "$DRILL_KEY" | pg_restore --dbname="$DRILL_URL" --no-owner --exit-on-error
log "restored into $scratch"

cli backup:counts DRILL_URL >"$work/restored.json"
cli backup:counts DATABASE_URL_BACKUP >"$work/live.json"
cli backup:check "$work/manifest.json" "$work/restored.json" "$work/live.json"

ping "" "restore drill of $newest passed"
log "done"
