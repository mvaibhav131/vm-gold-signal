# Deployment (B31)

Everything that puts VM Gold Signal on a server and keeps it there. The decisions are in
[`docs/06_Phases_and_Setup.md`](../docs/06_Phases_and_Setup.md) section 4; this file is the runbook.

| File                                            | What it is                                                                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                                    | One image for the worker, the migrations and the backup jobs (Node 24, `pg_dump` 17, `age`, `rclone`). Built on the VM, so the A1 builds `arm64` natively. |
| `docker-compose.yml`                            | `db`, `migrate`, `worker` (always); `backup`, `drill` (profile `ops`); `caddy` (profile `web`). Only `caddy` publishes ports.                              |
| `Caddyfile`                                     | TLS, security headers, the web app, the proxy to the api (B31b).                                                                                           |
| `env.example`                                   | Every variable of the VM's `.env`, with how to make each one.                                                                                              |
| `scripts/vm-setup.sh`                           | One-time preparation of the VM: updates, time, Docker, SSH, secrets directory, timers.                                                                     |
| `scripts/deploy.sh`                             | Backup, checkout, build, environment check, migrations, `up -d`, smoke test.                                                                               |
| `scripts/smoke.sh`                              | What must be true after a deploy (also `--telegram`, `--public`).                                                                                          |
| `scripts/backup.sh`, `scripts/restore-drill.sh` | Run inside the image by the systemd timers (`systemd/`).                                                                                                   |
| `scripts/drill.sh`                              | The failure drills: crash the worker, stop the database, block the feed.                                                                                   |
| `scripts/duckdns.sh`                            | The DuckDNS address update (timer every 5 minutes).                                                                                                        |
| `scripts/compose.sh`                            | The one way to call `docker compose` for this stack.                                                                                                       |
| `drills/`                                       | Compose files for the drills and for trying the backup without the bucket.                                                                                 |

## 1. What you create (once, all free)

1. **Oracle Cloud VM**: Ampere A1 Flex, 2 OCPU, 12 GB, Ubuntu 24.04 (aarch64), a public IP, your SSH public key. In the
   VCN security list: ingress 22 only from your own address, 80 and 443 from everywhere, nothing else.
2. **DuckDNS name** (`duckdns.org`, login with Google or GitHub): create `vmgs-yourname`, put the VM's public IP in it,
   copy the token.
3. **Healthchecks.io** (free Hobbyist plan): three checks, each with your Telegram or email integration:
   `worker` (period 1 minute, grace 5 minutes), `backup` (period 1 day, grace 3 hours), `drill` (period 31 days,
   grace 1 day). Copy the three ping URLs.
4. **Object storage bucket** (OCI, Standard, private; 20 GB are free) and a **Customer Secret Key** (profile, "Customer
   secret keys": gives an access key and a secret) for the S3-compatible API.
5. **An age key pair on your own PC** (not on the VM): `age-keygen -o vmgs-backup.key`. The line `# public key: age1...`
   goes into `BACKUP_AGE_RECIPIENT`. The private file stays offline: it is the only way to open the backups if the
   VM is lost.

## 2. First deploy

On the VM, as your normal user (the one with your SSH key). The repository is private, so the VM gets a read-only
**deploy key**: make it on the VM, add the public half in GitHub (repository, Settings, Deploy keys, "Add deploy key",
leave "Allow write access" off), then clone over SSH:

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/vmgs_deploy -C "vmgs-vm"
cat ~/.ssh/vmgs_deploy.pub                      # paste this line into GitHub as the deploy key
printf 'Host github.com\n  IdentityFile ~/.ssh/vmgs_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
chmod 600 ~/.ssh/config
sudo mkdir -p /opt/vmgs && sudo chown "$USER" /opt/vmgs
git clone git@github.com:mvaibhav131/vm-gold-signal.git /opt/vmgs
sudo bash /opt/vmgs/deploy/scripts/vm-setup.sh
```

`vm-setup.sh` turns on updates and time sync, installs Docker, switches SSH to keys only (only if your key is already
there), makes `/opt/vmgs/secrets` and the drill key, and enables the three timers. Open a second SSH session to check
that you can still log in before you close the first.

Then the two secret files:

```bash
sudo install -m 600 -o root -g root /opt/vmgs/deploy/env.example /opt/vmgs/.env
sudo nano /opt/vmgs/.env          # openssl rand -hex 24 for every password; the age public key; the ping URLs
sudoedit /opt/vmgs/secrets/rclone.conf
```

`rclone.conf` (the remote name is the part of `BACKUP_RCLONE_REMOTE` before the colon):

```ini
[oci]
type = s3
provider = Other
access_key_id = YOUR_ACCESS_KEY
secret_access_key = YOUR_SECRET
region = YOUR_REGION
endpoint = https://YOUR_NAMESPACE.compat.objectstorage.YOUR_REGION.oraclecloud.com
```

```bash
sudo /opt/vmgs/deploy/scripts/deploy.sh --first
sudo /opt/vmgs/deploy/scripts/compose.sh --profile ops run --rm backup       # the first backup, by hand
sudo /opt/vmgs/deploy/scripts/compose.sh --profile ops run --rm drill        # and its restore drill
sudo /opt/vmgs/deploy/scripts/drill.sh                                       # the failure drills (about 5 minutes)
```

From that day the worker records ticks, spreads, the calendar and the headlines, and Telegram and Healthchecks.io tell
you when something stops. The web app and the API come with B30 and U5 (section 6).

### Making yourself the owner (B29)

There is no sign-up page and no "forgot password": the owner is made, and got back into, on the server. Once the stack
is up, put `DB_PASSWORD_API` (`openssl rand -hex 24`) into `/opt/vmgs/.env`, run `deploy.sh` again (the migrate step
gives the role its login), then:

```bash
sudo /opt/vmgs/deploy/scripts/compose.sh --profile ops run --rm owner owner:create yourname
```

It asks for the password twice and shows nothing while you type (at least 12 characters, one that you use nowhere
else: a password manager is the place for it). The same service has `owner:status`, `owner:password` (a new password;
ends every session), `owner:totp-off` (the phone with the authenticator app and the recovery codes are both lost) and
`sessions:revoke-all`. `throttle:reset` is for one case: you are at a place that has never logged in (a new phone, a new
network), you are told "too many failed attempts" and you did not cause them (somebody is trying passwords against the
login). It forgets the failed tries; log in at once, and that place is then known and is no longer stopped by what
others do. Do not put the password in the command line: it would stay in the history of the shell. To
script it, pipe it in (`printf '%s\n' "$PW" | ... run -T --rm owner owner:create yourname`).

## 3. Every day

```bash
sudo /opt/vmgs/deploy/scripts/compose.sh ps                   # what runs
sudo /opt/vmgs/deploy/scripts/compose.sh logs -f worker       # the log (JSON lines)
sudo /opt/vmgs/deploy/scripts/smoke.sh                        # the checks of the deploy, any time
systemctl list-timers 'vmgs-*'                                # next backup, drill and DuckDNS update
sudo journalctl -u vmgs-backup.service -n 50                  # how the last backup went
```

A new release: as your normal user `cd /opt/vmgs && git pull` (or `git fetch --tags && git checkout v0.2.0`), then
`sudo /opt/vmgs/deploy/scripts/deploy.sh`. It backs up first, builds, checks the environment, migrates and starts.
(`deploy.sh --ref TAG` does the fetch itself, but as root, which has no deploy key: it works only if the deploy key is
also in `/root/.ssh`.) Rolling back: check out the previous tag the same way and run `deploy.sh` again; if a migration
ran in between, the older code refuses the newer database, so restore the backup that the deploy took first
(section 5).

Download a backup copy to your own PC from time to time: `rclone copy remote:bucket/db ./backups` (the files are
encrypted; only your offline key opens them).

## 4. How a failure shows

| What fails                      | What happens                                                                                  | You are told by                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| The worker crashes or is killed | Docker restarts it; it rebuilds its state from the database and writes the gap as an incident | The `worker` check, if it stays down; Telegram `WORKER` health alert when it comes back late |
| The database stops              | The worker stops, Docker starts it again until the database is back                           | The `worker` check                                                                           |
| The feed is cut off             | The worker stays up, opens a `STALE`/`DISCONNECT` incident, closes it when ticks return       | Telegram feed alert                                                                          |
| The VM is off                   | Nothing runs                                                                                  | The `worker` check (pings stop)                                                              |
| A backup fails or does not run  | The previous backups stay                                                                     | The `backup` check; the daily digest says how old the last backup is                         |
| A backup cannot be restored     | Nothing is lost yet                                                                           | The `drill` check                                                                            |

## 5. Restore

The drill restores into a scratch database every month. To put a backup in place of the live database (a lost
database, or a rollback that needs the old data), with the worker stopped:

```bash
cd /opt/vmgs
sudo deploy/scripts/compose.sh stop worker
sudo deploy/scripts/compose.sh --profile ops run --rm -T drill bash -c '
  set -euo pipefail
  name=vmgs-YYYYMMDDTHHMMSSZ.dump.age            # rclone lsf shows the names
  psql "${DATABASE_URL_ADMIN%/*}/postgres" -c "DROP DATABASE vmgs WITH (FORCE)" -c "CREATE DATABASE vmgs"
  rclone cat "${BACKUP_RCLONE_REMOTE%/}/$name" | age -d -i /run/secrets/drill.key | pg_restore --dbname="$DATABASE_URL_ADMIN" --no-owner --exit-on-error'
sudo deploy/scripts/compose.sh run --rm migrate      # gives the roles their passwords again and applies newer migrations
sudo deploy/scripts/compose.sh up -d worker
sudo deploy/scripts/smoke.sh
```

On a **new VM** the drill key is a new one and cannot open the old backups: copy your offline private key to
`/opt/vmgs/secrets/drill.key` for the restore (then run `vm-setup.sh` again later to make a fresh drill key after you
have moved the old file away). Tick data is not in the backups (`pg_dump` skips it); the ticks of the last 14 days are
gone after a restore, and the candles, signals, results, rollups and settings are back.

## 6. The web side (B31b)

When B30 (the rest of the API) and U5 (web) exist: the `api` service joins `docker-compose.yml` (the image already
carries it, with `API_TRUSTED_PROXY_HOPS=1` and `APP_ENCRYPTION_KEY` in the `.env`), `apps/web` is built into
`VMGS_WEB_DIST`, and `COMPOSE_PROFILES=web` in `.env` makes `deploy.sh` start `caddy` too. Then
`smoke.sh --public` calls `https://PUBLIC_HOST/health/ready`. The `Caddyfile` is ready and checked: headers, the
fallback to the index for a single-page app, no cache for `/api` and `/health`, the redirect to HTTPS.

## 7. What was checked where

Checked on a PC with Docker (project `vmgs-b31test`, nothing else touched): image build, migrations and role passwords,
the worker against the live feed, the healthcheck, backup (without tick data), the restore drill, the drill failing
on a damaged file and on a wrong manifest, the offline key opening the backup, the three failure drills, the Caddyfile
(validated and run: headers, routes, redirect), `shellcheck` on every script. For B29, in the same way: the image with
the API, the Argon2 native binary on Alpine, the `owner` service (made the owner from a pipe, refused a second one and a
short password, a hidden prompt on a real terminal), and the API started from the image against the database with curl:
cookie flags, the 403 without `Origin` and `X-VMGS-CSRF`, logout, and the 429 with `Retry-After` on the sixth failure.

Only the VM can check: the `arm64` build, `vm-setup.sh` (it was not run on Ubuntu), the Oracle bucket and its S3
settings, Healthchecks.io delivery, DuckDNS, and the certificate. The first run of each on the VM is the test: the
steps of section 2 stop at the first thing that does not work.
