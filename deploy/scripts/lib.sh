#!/usr/bin/env bash
# Helpers shared by smoke.sh and drill.sh. Source it; it runs nothing.
# shellcheck shell=bash

HERE="${HERE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

compose() { "$HERE/compose.sh" "$@"; }
sql() { compose exec -T db psql -U vmgs_owner -d vmgs -X -At -c "$1" 2>/dev/null; }
say() { printf '%s %s\n' "$(date -u +%T)" "$*"; }

# Gold does not trade from Friday evening to Sunday evening: no ticks is then the right answer. The edges are
# wide on purpose (the exact hour moves with the summer time of New York).
market_open() {
  local dow hour
  dow="$(date -u +%u)"
  hour="$(date -u +%H)"
  hour=$((10#$hour))
  ((dow == 6)) && return 1
  ((dow == 5 && hour >= 21)) && return 1
  ((dow == 7 && hour < 22)) && return 1
  return 0
}

worker_id() { compose ps -q worker; }
restarts() { docker inspect -f '{{.RestartCount}}' "$(worker_id)" 2>/dev/null || echo -1; }
worker_alive() { compose exec -T worker node --import tsx src/cli/main.ts worker:alive 60 >/dev/null 2>&1; }
tick_age() { sql "SELECT coalesce(extract(epoch FROM now() - max(ts))::int, 999999) FROM ticks WHERE symbol = 'XAUUSD'"; }
ticks_flowing() {
  local age
  age="$(tick_age)"
  [[ "$age" =~ ^[0-9]+$ ]] && ((age <= 30))
}
db_healthy() { [[ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q db)" 2>/dev/null)" == healthy ]]; }
worker_healthy() { [[ "$(docker inspect -f '{{.State.Health.Status}}' "$(worker_id)" 2>/dev/null)" == healthy ]]; }
recovered() { worker_alive && { ! market_open || ticks_flowing; }; }

# "Since" checks look for a heartbeat and a tick written AFTER a given moment (epoch seconds of the database clock),
# so an old heartbeat that is still fresh cannot pass for a recovery.
now_epoch() { sql "SELECT floor(extract(epoch FROM now()))::bigint"; }
heartbeat_since() { [[ "$(sql "SELECT (extract(epoch FROM heartbeat_at) > $1)::int FROM worker_heartbeats WHERE worker_name = 'worker'")" == 1 ]]; }
tick_since() { [[ "$(sql "SELECT (coalesce(extract(epoch FROM max(ts)), 0) > $1)::int FROM ticks WHERE symbol = 'XAUUSD'")" == 1 ]]; }
working_since() { heartbeat_since "$1" && worker_alive; }
recovered_since() { working_since "$1" && { ! market_open || tick_since "$1"; }; }

# wait_for SECONDS DESCRIPTION COMMAND...: true when the command succeeds within the time
wait_for() {
  local limit=$1 what=$2 start=$SECONDS
  shift 2
  while ((SECONDS - start < limit)); do
    if "$@"; then
      say "  ok: $what (after $((SECONDS - start)) s)"
      return 0
    fi
    sleep 3
  done
  say "  NOT ok: $what (waited $limit s)"
  return 1
}
