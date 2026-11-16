#!/usr/bin/env bash
# What a container of the image of the root Dockerfile runs, chosen by VMGS_ROLE:
#   worker (the default)  the worker alone: prices, the engine, Telegram
#   site                  the api and the website (Caddy) in one container, for a host that gives the container its TLS
#   both                  the two in one container (only if it has the memory for both: see deploy/README.md, section 10)
# Every process that stops takes the container down with it, so that the host restarts it: a container whose api died but
# whose Caddy still answers would look alive. SIGTERM stops everything and exits 0.
set -uo pipefail

role="${VMGS_ROLE:-worker}"
pids=()
stopping=0

# A host that tells the container its own public name (Render: RENDER_EXTERNAL_HOSTNAME, for a web service) needs no
# PUBLIC_HOST in the settings: the website is told where it lives by the host itself, so the first deploy is the only one.
# A PUBLIC_HOST that is set (a custom domain) wins; the placeholder of `pnpm aiven setup` does not.
if [[ "$role" != worker && -n "${RENDER_EXTERNAL_HOSTNAME:-}" ]]; then
  if [[ -z "${PUBLIC_HOST:-}" || "$PUBLIC_HOST" == pending.invalid || "$PUBLIC_HOST" == localhost ]]; then
    export PUBLIC_HOST="$RENDER_EXTERNAL_HOSTNAME"
  fi
fi

stop_all() {
  local pid
  for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
}

start_worker() {
  if [[ "$role" == both ]]; then
    # the port belongs to the website; the health page of the worker is for a container that only records
    (cd /app/apps/worker && exec env -u PORT node --import tsx src/main.ts) &
  elif [[ -n "${PORT:-}" ]]; then
    # The host looks at PORT a few seconds after the start, and the worker needs about 15 s on a quarter of a CPU before
    # it listens. A small program answers on PORT at once and passes the questions to the health page of the worker, which
    # listens one port higher (deploy/scripts/early-health.mjs).
    inner=$((PORT + 1))
    node /opt/vmgs/bin/early-health.mjs "$PORT" "$inner" &
    pids+=("$!")
    (cd /app/apps/worker && exec env PORT="$inner" node --import tsx src/main.ts) &
  else
    (cd /app/apps/worker && exec node --import tsx src/main.ts) &
  fi
  pids+=("$!")
}

start_site() {
  (cd /app/apps/api && exec env API_PORT=3000 node --import tsx src/main.ts) &
  pids+=("$!")
  caddy run --config /etc/caddy/Caddyfile.site --adapter caddyfile &
  pids+=("$!")
}

case "$role" in
  worker)
    if [[ -z "${PORT:-}" ]]; then
      cd /app/apps/worker || exit 1
      exec node --import tsx src/main.ts
    fi
    start_worker
    ;;
  site) start_site ;;
  both)
    start_worker
    start_site
    ;;
  *)
    echo "entry.sh: VMGS_ROLE is worker, site or both, not \"$role\"" >&2
    exit 2
    ;;
esac

trap 'stopping=1; stop_all' TERM INT
wait -n
code=$?
stop_all
wait
if ((stopping)); then exit 0; fi
((code != 0)) || code=1
echo "entry.sh: a process of the container ended (exit code $code); the container stops so that its host starts it again" >&2
exit "$code"
