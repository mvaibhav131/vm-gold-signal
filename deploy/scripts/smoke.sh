#!/usr/bin/env bash
# Smoke test of the stack (06_Phases_and_Setup section 4): what must be true after a deploy.
#   sudo /opt/vmgs/deploy/scripts/smoke.sh [--telegram] [--public]
# --telegram  queues one test message to the owner's Telegram chat (needs the bot token and a linked chat)
# --public    also calls https://PUBLIC_HOST/health/ready (B31b, when caddy and the api are up)
# Exit 0 when nothing failed. A warning is not a failure (the market may be closed, a Telegram token may be missing).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

telegram=false
public=false
for arg in "$@"; do
  case "$arg" in
    --telegram) telegram=true ;;
    --public) public=true ;;
    *) echo "usage: smoke.sh [--telegram] [--public]" >&2; exit 2 ;;
  esac
done

failed=0
warned=0
ok() { say "ok    $*"; }
bad() { say "FAIL  $*"; failed=$((failed + 1)); }
warn() { say "warn  $*"; warned=$((warned + 1)); }

if db_healthy; then ok "the database is healthy"; else bad "the database is not healthy"; fi

migrate_id="$(compose ps -a -q migrate 2>/dev/null | head -n 1)"
if [[ -n "$migrate_id" && "$(docker inspect -f '{{.State.ExitCode}}' "$migrate_id" 2>/dev/null)" == 0 ]]; then
  ok "the migrations were applied (the migrate step exited with 0)"
else
  bad "the migrate step did not finish with exit code 0"
fi

state="$(docker inspect -f '{{.State.Status}}' "$(worker_id)" 2>/dev/null || echo missing)"
if [[ "$state" == running ]]; then ok "the worker container is running (restarts: $(restarts))"; else bad "the worker container is $state"; fi

if worker_alive; then ok "the worker's heartbeat is fresh"; else bad "the worker's heartbeat is stale or missing"; fi

if market_open; then
  age="$(tick_age)"
  if ticks_flowing; then ok "ticks arrive (newest $age s old)"; else bad "no fresh tick (newest $age s old) while the market is open"; fi
else
  warn "the market is closed: ticks are not expected (newest $(tick_age) s old)"
fi

published="$(docker ps --filter "label=com.docker.compose.project=${VMGS_PROJECT:-vmgs}" --format '{{.Names}} {{.Ports}}' | grep -E '(db|worker)-[0-9]+ .*(0\.0\.0\.0|\[::\]):' || true)"
if [[ -z "$published" ]]; then ok "the database and the worker publish no port"; else bad "a port is published: $published"; fi

errors="$(compose logs --since 10m worker 2>/dev/null | grep -c '"level":"error"' || true)"
if [[ "$errors" == 0 ]]; then ok "no error in the log of the worker (10 minutes)"; else warn "$errors error lines in the log of the worker (compose.sh logs worker)"; fi

if $telegram; then
  if compose exec -T worker node --import tsx src/cli/main.ts telegram:test; then
    ok "a test message was queued: look at the Telegram chat"
  else
    bad "the test message could not be queued"
  fi
fi

if $public; then
  host="$(grep -E '^PUBLIC_HOST=' "${VMGS_ENV_FILE:-$HERE/../../.env}" | cut -d= -f2-)"
  body="$(curl -fsS -m 15 "https://$host/health/ready" 2>&1 || true)"
  if [[ "$body" == *ok* ]]; then ok "https://$host/health/ready answers ok"; else bad "https://$host/health/ready did not answer ok: $body"; fi
fi

say "smoke test: $failed failed, $warned warnings"
((failed == 0))
