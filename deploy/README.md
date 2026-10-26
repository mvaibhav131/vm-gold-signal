# Deployment (B31)

Everything that puts VM Gold Signal on a server and keeps it there. The decisions are in
[`docs/06_Phases_and_Setup.md`](../docs/06_Phases_and_Setup.md) section 4; this file is the runbook.

| File                                            | What it is                                                                                                                                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                                    | Two images from one file: `app` (the worker, the api, the migrations and the backup jobs; Node 24, `pg_dump` 17, `age`, `rclone`) and `web` (Caddy with the built web app inside). Built on the VM, so the A1 builds `arm64` natively. |
| `docker-compose.yml`                            | `db`, `migrate`, `worker` (always); `backup`, `drill`, `owner` (profile `ops`); `api`, `caddy` (profile `web`). Only `caddy` publishes ports.                                                                                          |
| `Caddyfile`                                     | TLS, security headers, the web app, the proxy to the api (B31b).                                                                                                                                                                       |
| `env.example`                                   | Every variable of the VM's `.env`, with how to make each one.                                                                                                                                                                          |
| `scripts/vm-setup.sh`                           | One-time preparation of the VM: updates, time, Docker, SSH, secrets directory, timers.                                                                                                                                                 |
| `scripts/deploy.sh`                             | Backup, checkout, build, environment check, migrations, `up -d`, smoke test.                                                                                                                                                           |
| `scripts/smoke.sh`                              | What must be true after a deploy (also `--telegram`, `--public`).                                                                                                                                                                      |
| `scripts/backup.sh`, `scripts/restore-drill.sh` | Run inside the image by the systemd timers (`systemd/`).                                                                                                                                                                               |
| `scripts/drill.sh`                              | The failure drills: crash the worker, stop the database, block the feed.                                                                                                                                                               |
| `scripts/duckdns.sh`                            | The DuckDNS address update (timer every 5 minutes).                                                                                                                                                                                    |
| `scripts/compose.sh`                            | The one way to call `docker compose` for this stack.                                                                                                                                                                                   |
| `drills/`                                       | Compose files for the drills and for trying the backup without the bucket.                                                                                                                                                             |

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
you when something stops. The web app and the API are the next step (section 6); they stay off until you ask for them.

### Making yourself the owner (B29)

There is no sign-up page and no "forgot password": the owner is made, and got back into, on the server. Once the stack
is up (`DB_PASSWORD_API` is one of the passwords of the `.env` from the first deploy: compose refuses to run
without it, and the migrate step gives the role its login), then:

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

The API and Caddy are the profile `web` of the compose file. They stay off until you turn them on, so a stack that only
records data needs neither the key nor the ports. To turn them on:

1. In the `.env`: `COMPOSE_PROFILES=web` and `APP_ENCRYPTION_KEY` (`openssl rand -hex 32`; keep it apart from the
   passwords; losing it makes the second step unreadable and `owner:totp-off` is the way out). `PUBLIC_HOST` is the
   DuckDNS name; `DB_PASSWORD_API` is there since the first deploy.
2. In the Oracle security list: ingress 80 and 443 from everywhere (they were in the list of section 1).
3. `sudo /opt/vmgs/deploy/scripts/deploy.sh`. It builds the web image (Caddy with the web app inside: nothing to copy
   by hand), checks the environment of the api in its own container (`env:check api`: the key and the role, named but
   never printed), starts the api and waits for its health.
4. Make the owner (above), then `sudo /opt/vmgs/deploy/scripts/smoke.sh --public`. The first request makes Caddy get
   the certificate (a few seconds; DuckDNS must already point at the VM and 80 and 443 must be open).

The api publishes no port: only Caddy reaches it, on the compose network, and `API_TRUSTED_PROXY_HOPS=1` makes the
client the address Caddy saw. Its health is `curl http://127.0.0.1:3000/api/v1/health/live` (alive), and
`/api/v1/health/ready` says whether the schema is current and the worker has been heard from. `smoke.sh` checks the
containers, that only Caddy publishes a port, and that the api says ready; with `--public` it also looks from the
outside, through Caddy: ready, HSTS, a screen of the API closed without a session (401), and port 80 going to https.
The API holds one connection for the event stream (`LISTEN`) besides its pool of 10, and `reverse_proxy` does not
buffer, so the stream reaches the browser as it is written. The `Caddyfile` has the headers, the fallback to the index
for a single-page app, no cache for `/api` and `/health`, and the redirect to HTTPS.

The web image is built with the live client (`VITE_DATA_SOURCE=live`, the default of the Dockerfile): the page talks to the API of the same origin, through Caddy. A build with `--build-arg VITE_DATA_SOURCE=mock` is the simulated preview, which is never what a release carries.

To try the whole thing on a PC beside other containers (high ports, a certificate of Caddy's own for `localhost`):
`deploy/drills/local-web.yml` (its header says how). For looking at the live data on your own PC there is a short way, `pnpm local up` (`scripts/local-live.mjs`, plain Node: the same commands in PowerShell, cmd, Git Bash or WSL): it makes random passwords in `.local/` (never committed), builds, and starts the worker on the real feed, the API and the web app at `https://localhost:18443`; `pnpm local owner` makes the login, `pnpm local import` puts the newest HistData months in so that the chart is full and the engine warms up, `status`, `logs`, `down` (keeps the data) and `reset` (deletes it). It uses its own Docker project and loopback ports only.

**A look in a browser (U5c).** `smoke.sh` asks with curl; a browser tells what curl cannot: that the policy of Caddy for scripts and styles does not break the page, that the event stream reaches the page through the proxy, and that every screen shows real data without an error. With the stack up:

```powershell
$env:VMGS_STACK_URL = 'https://your-name.duckdns.org'   # default https://localhost:18443 (the drill)
$env:VMGS_STACK_PASS = '<your password>'                 # also VMGS_STACK_USER (default owner), VMGS_STACK_CODE (the 2-step code of the moment)
$env:VMGS_STACK_INSECURE = '1'                           # only for the drill: trusts Caddy's own certificate
pnpm e2e:stack
```

It only reads: it logs in, opens the twelve screens and tabs, looks at the headers, watches the price move and logs out, and it fails on any console error, refused request or `Could not load`. Run it from your PC against the VM after the first deploy, and again after each release.

**Web Push on your phone (U6).** The app installs from the browser and can show alerts like any other app; Telegram stays the reliable channel, Web Push is the second. What is tested here is everything up to the push service; the last step, a real push on a real phone, is yours:

1. Make the keys, once: `sudo /opt/vmgs/deploy/scripts/compose.sh run --rm --no-deps -T worker node --import tsx src/cli/main.ts vapid:generate`. It prints three lines. Put them in the `.env` (change the subject to a `mailto:` address of yours), then `sudo /opt/vmgs/deploy/scripts/deploy.sh`. The private key is printed once and belongs in the `.env` only.
2. Open System, Alerts, Web Push. It must say "No device is subscribed", not "not set up on the server".
3. On the phone, open the site and install it. Android (Chrome): the menu, then Install app. iPhone or iPad (Safari, iOS 16.4 or newer): Share, then Add to Home Screen, and open the app from the Home Screen: **Web Push does not exist on an iPhone for a page that is only in a Safari tab**, and the section says so.
4. In the installed app: System, Alerts, Subscribe this device, and allow notifications. It must say "This device is subscribed".
5. Send test notification. Within a few seconds a notification "TEST: Delivery works. Nothing here is a signal." must appear, and a tap must open the app. Switch on "Web Push alerts" (and choose the minimum grade) so that signals reach the phone too: the test goes out whatever the switch says.
6. If nothing comes: check that the phone is online and that notifications are allowed for the app in the settings of the phone. A device that the push service has dropped (it answered `404` or `410`) is removed by the worker; the section then says that the server does not know this browser's subscription: Unsubscribe this device, then subscribe again. The delivery of every message (status, attempts, last error) is a row of `notification_outbox`. Android may hold the notifications of an app that has been closed for long when the battery saver is on.

## 7. What was checked where

Checked on a PC with Docker (project `vmgs-b31test`, nothing else touched): image build, migrations and role passwords,
the worker against the live feed, the healthcheck, backup (without tick data), the restore drill, the drill failing
on a damaged file and on a wrong manifest, the offline key opening the backup, the three failure drills, the Caddyfile
(validated and run: headers, routes, redirect), `shellcheck` on every script. For B29, in the same way: the image with
the API, the Argon2 native binary on Alpine, the `owner` service (made the owner from a pipe, refused a second one and a
short password, a hidden prompt on a real terminal), and the API started from the image against the database with curl:
cookie flags, the 403 without `Origin` and `X-VMGS-CSRF`, logout, and the 429 with `Retry-After` on the sixth failure.

For B31b, in the same way (project `vmgs-b31btest`, `deploy/drills/local-web.yml`: Caddy on `127.0.0.1:18080` and `:18443`
with a certificate of its own for `localhost`; the checks go to Caddy with the TLS verified against that CA, never with
verification off): both images built; the stack up with the real feed; `smoke.sh --public` with 0 failures, and with 5
when Caddy is stopped; ready and live, the headers (no `Server`, no double `Cache-Control`), the web app, the index for
an address that is no file, a 404 for a missing file under `/assets`; the API closed without a session (also for an
address it does not have); login with 403 for no or a foreign `Origin`, 204 for the right one, a `__Host-` cookie with
`HttpOnly`, `Secure`, `SameSite=Strict`; the event stream (the `retry` line at once, the quotes every second, an `engine`
event a moment after a pause through the API, `: hb` after 15 s, replay with `Last-Event-ID`, `resync` for an unknown
id); seven wrong logins with seven different `X-Forwarded-For` counted as one client (429 from the sixth); a stop of
the api with a stream open (1.4 s, exit code 0); the owner made from a pipe; `env:check api` for a good and a short
key; the container of the api as `node`, read-only, no capability; the profile `web` off giving only `db`, `migrate`
and `worker`; `shellcheck` on every script. The run found and fixed: a Caddy `Cache-Control` on top of the api's
(twice), a missing file under `/assets` answered with the index (a tab of an older release would get a page as its
script), and the request log writing the address of the client (it now holds the method, the path and the status).

For U6, in the same way (project `vmgs-u6test`): `vapid:generate` run in the image, its three lines in the `.env`, and `pnpm e2e:stack` with six scenarios: the type of the manifest, the icons, the worker over HTTPS (Chromium needs `--ignore-certificate-errors` for the certificate of the drill: it does not hear the setting of Playwright when it fetches a worker), and the Web Push section reading the key through Caddy. A real push to a real phone was not tried: that is the list above.

For U5c, in the same way (project `vmgs-u5ctest`): the web image built with the default `live` (no mock data in the bundle), the stack up with the real worker on the real feed, the owner made from a pipe, and `pnpm e2e:stack` in Chromium against Caddy: its headers and policy (no violation), all twelve screens with real headlines, the real calendar and the real price, the price moving through the proxy, the worker's heartbeat, and the logout. Removed afterwards (containers, volumes, images, network).

Only the VM can check: the `arm64` build, `vm-setup.sh` (it was not run on Ubuntu), the Oracle bucket and its S3
settings, Healthchecks.io delivery, DuckDNS, and the certificate. The first run of each on the VM is the test: the
steps of section 2 stop at the first thing that does not work.
