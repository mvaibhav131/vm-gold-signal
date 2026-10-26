#!/usr/bin/env bash
# Failure drills (06_Phases_and_Setup section 4, B31): kill the worker, stop the database, block the feed. Each drill
# causes the failure, checks that the stack does what it should, puts everything back and says PASS or FAIL.
#   sudo /opt/vmgs/deploy/scripts/drill.sh [kill-worker] [stop-db] [block-feed]     (no argument: all three)
# Run it on a stack that is up. It touches nothing else: the worker is restarted, the database is stopped for a
# minute, and the feed is cut off for the worker only. The first minutes of the data of the drill are a real gap
# (the recorder writes it as an incident), as they would be in a real failure.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

BASE_FILES="${VMGS_COMPOSE_FILES:-}"
failures=0
results=()

restarted_since() { [[ "$(restarts)" -gt "$1" ]]; }
new_incident() { [[ "$(sql "SELECT count(*) FROM feed_incidents WHERE ended_at IS NULL AND kind IN ('STALE', 'DISCONNECT') AND started_at >= to_timestamp($1)")" -ge 1 ]]; }
no_open_incident() { [[ "$(sql "SELECT count(*) FROM feed_incidents WHERE ended_at IS NULL AND kind IN ('STALE', 'DISCONNECT')")" == 0 ]]; }

finish() { # finish NAME STATUS
  results+=("$2  $1")
  [[ "$2" == PASS ]] || failures=$((failures + 1))
  say "$2: $1"
}

drill_kill_worker() {
  # `docker kill` is a manual stop for Docker and is not restarted; a crash or the OOM killer is. So the drill kills
  # the node process inside, which is what a crash looks like from outside (the container exits with 137).
  say "== crash the worker (SIGKILL to its node process: no clean shutdown)"
  local before since ok=true
  before="$(restarts)"
  since="$(now_epoch)"
  compose exec -T worker pkill -9 node || ok=false
  wait_for 120 "the container was restarted by Docker" restarted_since "$before" || ok=false
  wait_for 180 "a new heartbeat and a new tick were written after the crash" recovered_since "$since" || ok=false
  if $ok; then finish "kill-worker" PASS; else finish "kill-worker" FAIL; fi
}

drill_stop_db() {
  say "== stop the database for 30 seconds"
  local before since ok=true
  before="$(restarts)"
  compose stop db >/dev/null || ok=false
  sleep 30
  compose start db >/dev/null || ok=false
  wait_for 90 "the database is healthy again" db_healthy || ok=false
  since="$(now_epoch)"
  wait_for 300 "a new heartbeat and a new tick were written after the database came back" recovered_since "$since" || ok=false
  say "  the worker restarted $(($(restarts) - before)) time(s) meanwhile (it stops when it loses the database, and Docker starts it again)"
  if $ok; then finish "stop-db" PASS; else finish "stop-db" FAIL; fi
}

drill_block_feed() {
  say "== block the feed (biquote.io resolves to nothing for the worker)"
  local since ok=true
  since="$(now_epoch)"
  VMGS_COMPOSE_FILES="$BASE_FILES deploy/drills/block-feed.yml" compose up -d --force-recreate --no-deps worker >/dev/null 2>&1 || ok=false
  wait_for 90 "the worker (started without a feed) writes heartbeats" working_since "$since" || ok=false
  if market_open; then
    wait_for 150 "a feed incident was opened (STALE or DISCONNECT)" new_incident "$since" || ok=false
  else
    say "  skipped: the market is closed, so there is no incident to see"
  fi
  # a new container starts at 0: more than one restart in these minutes is a crash loop
  if [[ "$(restarts)" -le 1 ]]; then
    say "  ok: the worker did not crash-loop (restarts: $(restarts))"
  else
    say "  NOT ok: the worker restarted $(restarts) times"
    ok=false
  fi
  say "  unblocking the feed"
  VMGS_COMPOSE_FILES="$BASE_FILES" compose up -d --force-recreate --no-deps worker >/dev/null 2>&1 || ok=false
  since="$(now_epoch)"
  wait_for 240 "a new heartbeat and a new tick were written with the feed back" recovered_since "$since" || ok=false
  if market_open; then wait_for 120 "the incident was closed" no_open_incident || ok=false; fi
  if $ok; then finish "block-feed" PASS; else finish "block-feed" FAIL; fi
}

requested=("$@")
((${#requested[@]})) || requested=(kill-worker stop-db block-feed)

worker_alive || { say "the worker is not working now: start the stack first (deploy.sh)"; exit 2; }

for name in "${requested[@]}"; do
  case "$name" in
    kill-worker) drill_kill_worker ;;
    stop-db) drill_stop_db ;;
    block-feed) drill_block_feed ;;
    *) say "unknown drill $name (kill-worker, stop-db, block-feed)"; exit 2 ;;
  esac
done

say "== result"
printf '  %s\n' "${results[@]}"
((failures == 0))
