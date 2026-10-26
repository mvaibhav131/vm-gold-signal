#!/usr/bin/env bash
# Smoke test of the stack (06_Phases_and_Setup section 4): what must be true after a deploy.
#   sudo /opt/vmgs/deploy/scripts/smoke.sh [--telegram] [--public]
# --telegram  queues one test message to the owner's Telegram chat (needs the bot token and a linked chat)
# --public    also looks at the site from the outside, through Caddy (B31b, when COMPOSE_PROFILES has `web`): the API
#             says ready, HSTS is sent, a screen of the API is closed without a session, port 80 goes to https
# For a try on a PC (deploy/drills/local-web.yml), VMGS_PUBLIC_BASE and VMGS_PUBLIC_HTTP_BASE name the local address and
# VMGS_CURL_ARGS adds what curl needs to reach it (the certificate that Caddy made, --connect-to).
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

state="$(container_state "$(worker_id)")"
if [[ "$state" == running ]]; then ok "the worker container is running (restarts: $(restarts))"; else bad "the worker container is $state"; fi

if worker_alive; then ok "the worker's heartbeat is fresh"; else bad "the worker's heartbeat is stale or missing"; fi

if market_open; then
  age="$(tick_age)"
  if ticks_flowing; then ok "ticks arrive (newest $age s old)"; else bad "no fresh tick (newest $age s old) while the market is open"; fi
else
  warn "the market is closed: ticks are not expected (newest $(tick_age) s old)"
fi

# Only Caddy may publish a port: not the database, not the worker, not the api.
published="$(docker ps --filter "label=com.docker.compose.project=${VMGS_PROJECT:-vmgs}" --format '{{.Names}} {{.Ports}}' | grep -E '(0\.0\.0\.0|\[::\]):' | grep -v -E -- '-caddy-[0-9]+ ' || true)"
if [[ -z "$published" ]]; then ok "nothing but caddy publishes a port"; else bad "a port is published: $published"; fi

errors="$(compose logs --since 10m worker 2>/dev/null | grep -c '"level":"error"' || true)"
if [[ "$errors" == 0 ]]; then ok "no error in the log of the worker (10 minutes)"; else warn "$errors error lines in the log of the worker (compose.sh logs worker)"; fi

if web_on; then
  api="$(api_id)"
  state="$(container_state "$api")"
  if [[ "$state" == running ]] && api_healthy; then
    ok "the api container is running and healthy (restarts: $(docker inspect -f '{{.RestartCount}}' "$api" 2>/dev/null || echo -1))"
  else
    bad "the api container is $state, health $(container_health "$api")"
  fi

  ready="$(compose exec -T api curl -sS -m 10 http://127.0.0.1:3000/api/v1/health/ready 2>&1 || true)"
  if [[ "$ready" == *'"ok"'* ]]; then
    ok "the api says it is ready (the schema is current and the worker has been heard from)"
  else
    bad "the api is not ready: $ready"
  fi

  state="$(container_state "$(caddy_id)")"
  if [[ "$state" == running ]]; then ok "the caddy container is running"; else bad "the caddy container is $state"; fi

  errors="$(compose logs --since 10m api 2>/dev/null | grep -c '"level":"error"' || true)"
  if [[ "$errors" == 0 ]]; then ok "no error in the log of the api (10 minutes)"; else warn "$errors error lines in the log of the api (compose.sh logs api)"; fi
  if compose logs api 2>/dev/null | grep -q 'there is no owner yet'; then
    warn "there is no owner yet: compose.sh --profile ops run --rm owner owner:create yourname"
  fi
elif $public; then
  bad "--public needs the web side: put COMPOSE_PROFILES=web in the .env and deploy again"
fi

if $telegram; then
  if compose exec -T worker node --import tsx src/cli/main.ts telegram:test; then
    ok "a test message was queued: look at the Telegram chat"
  else
    bad "the test message could not be queued"
  fi
fi

if $public && web_on; then
  host="$(env_value PUBLIC_HOST)"
  base="${VMGS_PUBLIC_BASE:-https://$host}"
  http_base="${VMGS_PUBLIC_HTTP_BASE:-http://$host}"
  curl_tls=(-sS -m 15)
  read -r -a curl_extra <<<"${VMGS_CURL_ARGS:-}"
  curl_tls+=("${curl_extra[@]}")

  body="$(curl -f "${curl_tls[@]}" "$base/api/v1/health/ready" 2>&1 || true)"
  if [[ "$body" == *'"ok"'* ]]; then ok "$base/api/v1/health/ready answers ok"; else bad "$base/api/v1/health/ready did not answer ok: $body"; fi

  headers="$(curl "${curl_tls[@]}" -D - -o /dev/null "$base/" 2>&1 || true)"
  if grep -qi '^strict-transport-security:' <<<"$headers"; then ok "the site sends HSTS"; else bad "the site does not send HSTS: $headers"; fi

  code="$(curl "${curl_tls[@]}" -o /dev/null -w '%{http_code}' "$base/api/v1/market/snapshot" 2>&1 || true)"
  if [[ "$code" == 401 ]]; then ok "the API is closed without a session (401)"; else bad "the API answered $code to a request without a session (401 expected)"; fi

  redirect="$(curl "${curl_tls[@]}" -o /dev/null -w '%{http_code} %{redirect_url}' "$http_base/" 2>&1 || true)"
  if [[ "$redirect" =~ ^30[1278]\ https:// ]]; then ok "port 80 goes to https ($redirect)"; else bad "port 80 does not go to https: $redirect"; fi
fi

say "smoke test: $failed failed, $warned warnings"
((failed == 0))
