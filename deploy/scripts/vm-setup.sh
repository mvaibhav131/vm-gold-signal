#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu 24.04 VM (x86_64 or arm64) at any provider, run as root from the checkout:
#   sudo bash /opt/vmgs/deploy/scripts/vm-setup.sh [--no-ssh-hardening]
# It is safe to run again. What it does (06_Phases_and_Setup section 4, "VM hardening"):
#   - security updates now and automatically (no automatic reboot: reboot on a weekend when the System page asks)
#   - 2 GB of swap on a VM with less than 3 GB of memory
#   - UTC time kept by chrony
#   - Docker from Docker's own apt repository, with log rotation
#   - SSH by key only, no root login (only when your user already has a key: it never locks you out)
#   - /opt/vmgs/secrets (mode 700) and the drill key of the restore drill
#   - the systemd timers: nightly backup, monthly restore drill, DuckDNS update
# The firewall of the cloud provider (security list, firewall rules) is the perimeter: open 22
# only to your own address, and 80 and 443. The stack publishes no other port (the database has none); the last step
# lists what listens.
set -euo pipefail

step() { printf '\n==> %s\n' "$*"; }
((EUID == 0)) || { echo "vm-setup.sh: run it as root (sudo)" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
HARDEN_SSH=true
[[ "${1:-}" != --no-ssh-hardening ]] || HARDEN_SSH=false

# shellcheck disable=SC1091
. /etc/os-release
[[ "$ID" == ubuntu ]] || { echo "vm-setup.sh: made for Ubuntu (this is $ID)" >&2; exit 1; }
[[ "$ROOT" == /opt/vmgs ]] || echo "note: the units and scripts expect the checkout at /opt/vmgs (it is at $ROOT)"
export DEBIAN_FRONTEND=noninteractive

step "updates and tools"
apt-get update -q
apt-get -y -q upgrade
apt-get -y -q install ca-certificates curl git gnupg chrony unattended-upgrades age

step "swap: 2 GB on a VM with less than 3 GB of memory (the database and the worker peak together at a restart)"
mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
if [[ -n "$(swapon --show --noheadings)" ]]; then
  echo "there is swap already: $(swapon --show --noheadings | awk '{print $1 " " $3}' | paste -sd, -)"
elif ((mem_kb >= 3 * 1024 * 1024)); then
  echo "not needed: $((mem_kb / 1024)) MB of memory"
else
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  # swap is the way out of a peak, not a place to live in
  printf 'vm.swappiness=10\n' >/etc/sysctl.d/99-vmgs.conf
  sysctl -q -p /etc/sysctl.d/99-vmgs.conf
  echo "made /swapfile (2 GB), swappiness 10"
fi

step "time: UTC, kept by chrony"
timedatectl set-timezone UTC
systemctl enable --now chrony
chronyc tracking | head -n 3 || true

step "automatic security updates (no automatic reboot)"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat >/etc/apt/apt.conf.d/52vmgs-unattended-upgrades <<'EOF'
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF

step "docker"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get -y -q install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
install -d /etc/docker
daemon_json='{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}'
if [[ "$(cat /etc/docker/daemon.json 2>/dev/null || true)" != "$daemon_json" ]]; then
  printf '%s\n' "$daemon_json" >/etc/docker/daemon.json
  systemctl restart docker
fi
systemctl enable --now docker
docker --version
docker compose version

step "ssh: keys only, no root login"
admin="${SUDO_USER:-}"
keys="$(getent passwd "${admin:-root}" | cut -d: -f6)/.ssh/authorized_keys"
if ! $HARDEN_SSH; then
  echo "skipped (--no-ssh-hardening)"
elif [[ -z "$admin" || "$admin" == root ]]; then
  echo "skipped: run it with sudo from your own user, so that it can check that you have a key"
elif [[ ! -s "$keys" ]]; then
  echo "skipped: $keys is empty, and turning passwords off now would lock you out"
else
  cat >/etc/ssh/sshd_config.d/10-vmgs.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
EOF
  sshd -t
  systemctl reload ssh
  echo "done: keep this session open and open a second one to check that you can still log in"
fi

step "git: let root read the checkout (it belongs to your user)"
git config --global --get-all safe.directory | grep -qx "$ROOT" || git config --global --add safe.directory "$ROOT"

step "secrets directory and the drill key"
install -d -m 700 -o root -g root "$ROOT/secrets"
if [[ ! -f "$ROOT/secrets/drill.key" ]]; then
  age-keygen -o "$ROOT/secrets/drill.key" 2>&1 | sed 's/^/  /'
  chmod 600 "$ROOT/secrets/drill.key"
fi
echo "drill key (public part): $(age-keygen -y "$ROOT/secrets/drill.key")"
[[ -f "$ROOT/secrets/rclone.conf" ]] || echo "still to do: $ROOT/secrets/rclone.conf (deploy/README.md, \"The backup bucket\")"

step "systemd timers: backup, restore drill, DuckDNS"
for unit in "$ROOT"/deploy/systemd/*.service "$ROOT"/deploy/systemd/*.timer; do
  install -m 644 "$unit" /etc/systemd/system/
done
systemctl daemon-reload
systemctl enable --now vmgs-backup.timer vmgs-restore-drill.timer vmgs-duckdns.timer
systemctl list-timers 'vmgs-*' --no-pager

step "what listens"
ss -tlnH | awk '{print "  " $4}' | sort -u
echo "Expected: ssh (22) only, until the stack is up; then also 80 and 443 when the web profile runs."
echo "No 5432 here: the database is on the Docker network only."
printf '\nNext: copy deploy/env.example to /opt/vmgs/.env (mode 600), fill it, then run deploy/scripts/deploy.sh --first\n'
