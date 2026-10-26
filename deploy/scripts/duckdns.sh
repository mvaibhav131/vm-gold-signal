#!/usr/bin/env bash
# Tells DuckDNS the current address of the VM (vmgs-duckdns.timer runs it every 5 minutes), so that the name keeps
# pointing here if Oracle ever changes the address. The token reaches curl through a config on stdin: it is in no
# process list and in no log.
set -euo pipefail

ENV_FILE="${VMGS_ENV_FILE:-/opt/vmgs/.env}"
read_var() { grep -E "^$1=" "$ENV_FILE" | head -n 1 | cut -d= -f2- || true; }

domain="$(read_var DUCKDNS_DOMAIN)"
token="$(read_var DUCKDNS_TOKEN)"
domain="${domain%.duckdns.org}"

if [[ -z "$domain" || -z "$token" ]]; then
  echo "duckdns: set DUCKDNS_DOMAIN and DUCKDNS_TOKEN in $ENV_FILE" >&2
  exit 1
fi
[[ "$domain" =~ ^[a-z0-9-]+(,[a-z0-9-]+)*$ ]] || { echo "duckdns: DUCKDNS_DOMAIN is not a DuckDNS name" >&2; exit 1; }
[[ "$token" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo "duckdns: DUCKDNS_TOKEN is not a DuckDNS token" >&2; exit 1; }

# an empty ip= makes DuckDNS use the address the request comes from
answer="$(printf 'url = "https://www.duckdns.org/update?domains=%s&token=%s&ip="\n' "$domain" "$token" |
  curl -fsS -m 20 -K -)"
if [[ "$answer" != OK ]]; then
  echo "duckdns: the answer was '$answer' (KO: a wrong name or token)" >&2
  exit 1
fi
echo "duckdns: $domain updated"
