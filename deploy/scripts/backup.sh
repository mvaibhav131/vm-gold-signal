#!/usr/bin/env bash
# The nightly backup (06_Phases_and_Setup section 4). It runs inside the app image as the one-shot service `backup`
# (vmgs-backup.timer starts it). In one stream: pg_dump (custom format, without the data of the tick partitions),
# age (to the owner's offline key and to the drill key of the VM) and rclone to the object storage. Then the
# manifest (row counts taken just before the dump, for the restore drill), the pruning (7 daily, 4 weekly, 3
# monthly) and the heartbeat `backup` that the digest and the System page read.
# A failure pings /fail of the Healthchecks.io check of the backup; a night without a ping alerts too.
set -Eeuo pipefail

log() { printf '%s [backup] %s\n' "$(date -u +%FT%TZ)" "$*"; }

: "${DATABASE_URL_BACKUP:?}" "${BACKUP_AGE_RECIPIENT:?}" "${BACKUP_RCLONE_REMOTE:?}"
REMOTE="${BACKUP_RCLONE_REMOTE%/}"
export RCLONE_CONFIG="${RCLONE_CONFIG:-/run/secrets/rclone.conf}"
DRILL_KEY="${BACKUP_DRILL_KEY_FILE:-/run/secrets/drill.key}"

cli() { (trap - ERR; cd /app/apps/worker && node --import tsx src/cli/main.ts "$@"); }

ping() {
  [[ -n "${HEALTHCHECKS_BACKUP_URL:-}" ]] || return 0
  local data=()
  [[ -z "${2:-}" ]] || data=(--data-raw "$2")
  curl -fsS -m 10 --retry 3 -o /dev/null "${data[@]}" "${HEALTHCHECKS_BACKUP_URL%/}${1:-}" ||
    log "the external check could not be reached"
}

PARTIAL=""
fail() {
  trap - ERR
  log "FAILED at line $1"
  # a half-written upload must not be taken for a backup
  [[ -z "$PARTIAL" ]] || rclone deletefile "$PARTIAL" 2>/dev/null || true
  ping /fail "backup failed at line $1"
  exit 1
}
trap 'fail $LINENO' ERR

ping /start
cli env:check backup

recipients=(-r "$BACKUP_AGE_RECIPIENT")
if [[ -r "$DRILL_KEY" ]]; then
  recipients+=(-r "$(age-keygen -y "$DRILL_KEY")")
else
  log "WARNING: no drill key, so the restore drill cannot open this backup"
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="vmgs-${stamp}.dump.age"
manifest="vmgs-${stamp}.manifest.json"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cli backup:counts >"$work/$manifest"
log "rows before the dump: $(cat "$work/$manifest")"

# The upload gets its final name only when the whole stream has gone through (a failure in any stage fails the pipe).
PARTIAL="$REMOTE/$name.partial"
pg_dump --dbname="$DATABASE_URL_BACKUP" --format=custom --no-owner --exclude-table-data='ticks_*' |
  age "${recipients[@]}" |
  rclone rcat "$PARTIAL"
rclone moveto "$PARTIAL" "$REMOTE/$name"
PARTIAL=""

bytes="$(rclone lsf --format s --files-only --include "$name" "$REMOTE" | head -n 1)"
if [[ ! "$bytes" =~ ^[0-9]+$ ]] || ((bytes < 1024)); then
  log "the uploaded backup is missing or too small ($bytes bytes)"
  false
fi
rclone copyto "$work/$manifest" "$REMOTE/$manifest"
log "uploaded $name ($bytes bytes)"

kept=0
removed=0
while IFS= read -r line; do
  case "$line" in
    "KEEP "*) kept=$((kept + 1)) ;;
    "REMOVE "*)
      old="${line#REMOVE }"
      rclone deletefile "$REMOTE/$old"
      rclone deletefile "$REMOTE/${old%.dump.age}.manifest.json" 2>/dev/null || true
      removed=$((removed + 1))
      ;;
  esac
done < <(rclone lsf --files-only "$REMOTE" | cli backup:plan)
log "pruned: kept $kept, removed $removed"

psql "$DATABASE_URL_BACKUP" -X -q -v ON_ERROR_STOP=1 -v file="$name" -v bytes="$bytes" <<'SQL'
INSERT INTO worker_heartbeats (worker_name, heartbeat_at, metadata)
VALUES ('backup', now(), jsonb_build_object('file', :'file', 'bytes', :'bytes'::bigint))
ON CONFLICT (worker_name) DO UPDATE
SET heartbeat_at = EXCLUDED.heartbeat_at, metadata = EXCLUDED.metadata;
SQL

ping "" "backup $name ($bytes bytes)"
log "done"
