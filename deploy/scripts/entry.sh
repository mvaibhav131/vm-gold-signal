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

stop_all() {
  local pid
  for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
}

start_worker() {
  # in `both` the port belongs to the website; the health page of the worker is for a container that only records
  if [[ "$role" == both ]]; then
    (cd /app/apps/worker && exec env -u PORT node --import tsx src/main.ts) &
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
    cd /app/apps/worker || exit 1
    exec node --import tsx src/main.ts
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
