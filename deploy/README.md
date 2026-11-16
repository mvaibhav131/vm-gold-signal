# Deployment (B31)

Everything that puts VM Gold Signal on a server and keeps it there. The decisions are in
[`docs/06_Phases_and_Setup.md`](../docs/06_Phases_and_Setup.md) section 4; this file is the runbook.

| File                                            | What it is                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                                    | Two images from one file: `app` (the worker, the api, the migrations and the backup jobs; Node 24, `pg_dump` 17, `age`, `rclone`) and `web` (Caddy with the built web app inside). Built on the VM, so the A1 builds `arm64` natively; or on your PC with `pnpm ship:images` for a VM too small to build (section 8). |
| `docker-compose.yml`                            | `db`, `migrate`, `worker` (always); `backup`, `drill`, `owner` (profile `ops`); `api`, `caddy` (profile `web`). Only `caddy` publishes ports.                                                                                                                                                                         |
| `small-vm.yml`                                  | The compose changes for a VM of 1 GB (Google Cloud e2-micro): a small database cache, heap limits, more time for the worker to start (section 8).                                                                                                                                                                     |
| `Caddyfile`                                     | TLS, security headers, the web app, the proxy to the api (B31b).                                                                                                                                                                                                                                                      |
| `env.example`                                   | Every variable of the VM's `.env`, with how to make each one.                                                                                                                                                                                                                                                         |
| `scripts/vm-setup.sh`                           | One-time preparation of the VM: updates, time, Docker, SSH, secrets directory, timers.                                                                                                                                                                                                                                |
| `scripts/deploy.sh`                             | Backup, checkout, build (or `--images FILE`: the images made on your PC), environment check, migrations, `up -d`, smoke test.                                                                                                                                                                                         |
| `scripts/smoke.sh`                              | What must be true after a deploy (also `--telegram`, `--public`).                                                                                                                                                                                                                                                     |
| `scripts/backup.sh`, `scripts/restore-drill.sh` | Run inside the image by the systemd timers (`systemd/`).                                                                                                                                                                                                                                                              |
| `scripts/drill.sh`                              | The failure drills: crash the worker, stop the database, block the feed.                                                                                                                                                                                                                                              |
| `scripts/duckdns.sh`                            | The DuckDNS address update (timer every 5 minutes).                                                                                                                                                                                                                                                                   |
| `scripts/compose.sh`                            | The one way to call `docker compose` for this stack.                                                                                                                                                                                                                                                                  |
| `drills/`                                       | Compose files for the drills and for trying the backup without the bucket.                                                                                                                                                                                                                                            |

## 1. What you create (once, all free)

(On Google Cloud instead of Oracle: section 8 replaces items 1 and 4, and the bucket is a Cloud Storage one.)

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
On a VM that cannot build (section 8) the release is `pnpm ship:images` on your PC, `scp` of the file, and
`deploy.sh --images FILE` on the VM.
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

## 8. Google Cloud e2-micro (a small VM, almost free)

Oracle's free VM is the plan of sections 1 to 6. If its sign-up does not work for you, the Always Free machine of Google
Cloud can carry the same stack: **record data and forward-test, yes; a stack to trust for live alerts, not yet** (the
numbers are below). The steps are those of section 2, with these differences.

### What it costs

Taken from Google's pages of November 2026; look again before you sign up, they change.

|                   |                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Free, no end date | One non-preemptible `e2-micro` per month in `us-west1`, `us-central1` or `us-east1`; 30 GB of **standard** persistent disk; 1 GB of outbound data a month (Google may change it with 30 days' notice). Cloud Storage: 5 GB of regional storage in those same three regions.                                                                     |
| **Not free**      | The **public IPv4 address** of the VM: $0.005 an hour (the free tier covers one hour a month), so about **$3.6 a month** plus tax. The stack needs it to reach the feed. This is the only charge of a right setup.                                                                                                                              |
| Free for 90 days  | The sign-up gives $300 of credit for 90 days, which pays the address too. A card is needed (a hold of up to $1 that is released).                                                                                                                                                                                                               |
| **At day 90**     | You must press **Activate** (upgrade to a paid account) in the console before the 90 days end. If you do not, the account is closed, the VM is stopped and, after 30 more days, deleted. After the upgrade the Always Free part stays free and the remaining credit can still be used until day 90. Put a reminder in your calendar for day 80. |

What else can cost money, and the setting that prevents it:

- **A bigger machine, another region, a second VM, a Spot VM**: only one `e2-micro` in one of the three regions is free.
- **The disk**: choose "Standard persistent disk", 30 GB. The console proposes Balanced, which is charged.
- **The network tier**: keep Premium (the default). The free outbound GB does not apply to the Standard tier.
- **A reserved static IP**: do not make one. An address that is reserved and not used is charged at a higher rate. The
  ephemeral address changes only when you stop and start the VM, and the DuckDNS timer follows it within 5 minutes.
- **Outbound data above 1 GB a month**: incoming data (the feed) is free. An open dashboard sends the price every second,
  so a tab left open all day for weeks may add up. Look at Billing, Reports, grouped by SKU, after the first week.
- **Snapshots, Marketplace images, "Ubuntu Pro" images**: not needed. Use the plain Ubuntu 24.04 LTS image.
- **A budget** (Billing, Budgets and alerts: $5, alerts at 50, 90 and 100 percent, to your email) tells you early. A budget
  sends mails; it does not stop anything by itself.

### Steps

1. Sign up at `console.cloud.google.com/freetrial`, set the budget above, and put day 80 in your calendar.
2. Compute Engine, Create instance: region `us-central1` (or `us-west1`, `us-east1`), machine type **e2-micro**,
   boot disk **Ubuntu 24.04 LTS, x86/64**, type **Standard persistent disk**, **30 GB**, provisioning model Standard,
   firewall: tick "Allow HTTP traffic" and "Allow HTTPS traffic", your SSH public key in the metadata (or use the SSH
   button of the console). In the VPC firewall rules narrow `default-allow-ssh` to your own address.
3. In DuckDNS, put the external IP of the VM (section 1, item 2).
4. The backup bucket (instead of the Oracle one): Cloud Storage, a bucket in `us-central1` (or the region of the VM),
   class Standard, "Enforce public access prevention" on. Then Settings, Interoperability, "Create a key for a service
   account" (give that service account the role Storage Object Admin on this bucket only). `secrets/rclone.conf`:

   ```ini
   [gcs]
   type = s3
   provider = GCS
   access_key_id = YOUR_HMAC_ACCESS_KEY
   secret_access_key = YOUR_HMAC_SECRET
   endpoint = https://storage.googleapis.com
   ```

   and `BACKUP_RCLONE_REMOTE=gcs:your-bucket-name/db` in the `.env`. This was not tried against Google's storage: the
   first backup by hand (section 2) is the test. **A bucket is deleted with its account.** If you will move on to another
   cloud (section 9), keep the backups in a bucket outside this cloud instead (Backblaze B2 and Cloudflare R2 have a free
   tier and an S3 interface: `provider = Other` and their endpoint in `rclone.conf`; their current terms were not
   checked), or download the newest file to your own PC before the account ends (section 3).

5. In the `.env` of the VM add `VMGS_COMPOSE_FILES=deploy/small-vm.yml` (see `deploy/small-vm.yml`). Without it the
   database is sized for 12 GB.
6. `vm-setup.sh` makes 2 GB of swap on a VM with less than 3 GB of memory (the warm-up of the engine peaks the memory).
7. **The images are built on your PC, never on the VM** (a quarter of a CPU and 1 GB cannot build them). On your PC, with
   the release committed and pushed:

   ```bash
   pnpm ship:images                  # builds linux/amd64 images and writes .local/vmgs-images-<release>-amd64.tar.gz (about 140 MB)
   scp .local/vmgs-images-....tar.gz YOUR_USER@VM_IP:~/
   ```

   On the VM: `sudo /opt/vmgs/deploy/scripts/deploy.sh --first --images ~/vmgs-images-....tar.gz`. It loads the images,
   refuses ones of another processor than the VM's, and goes on as in section 2. The database image is pulled by the VM
   from Docker Hub. Every later release is the same two commands, `deploy.sh --images` without `--first`.

   After a good deploy the release is written to `/opt/vmgs/.version`, and `compose.sh` uses it: so the timers, the
   owner commands and `smoke.sh` find the images that were loaded, and never try to build one.

### What to expect

Measured on a PC with a "mini VM" of 768 MB of memory (1 GB less about 256 MB for the system) and 0.25 CPU in all, no swap,
the real feed, the stack with `deploy/small-vm.yml`:

| What                                 | Result                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Cold start, four services            | about 2 minutes to healthy; no out-of-memory kill                                                                     |
| 16 minutes, working normally         | 0.11 to 0.16 CPU of the 0.25, 580 to 650 MB of memory (with the cache of the system), no incident, ticks 3 to 5 s old |
| Restart of the worker (warm-up)      | **232 s** with three months of history (10 s with no limit); memory peak 707 of 768 MB; a gap of about 3 minutes      |
| History import while the worker runs | the worker fell behind: a `CLOCK_SKEW` incident (ticks up to 8 s late)                                                |
| Backup (`pg_dump`, no tick data)     | 8 s, no incident                                                                                                      |
| Browser check (`pnpm e2e:stack`)     | 6 of 6 passed, in 71 s (25 s with no limit)                                                                           |

So: it runs, with about 40 percent of the CPU in reserve. Every restart or release costs a gap of 2 to 4 minutes in the
record (the system writes it down as an incident, it does not hide it). Do not import history while the worker runs; on
a new VM the engine needs about a day of live data before it can think. A real e2-micro may burst for about 30 seconds,
so the warm-up there should be faster than 232 s; what the test did not cover: the CPU of the system itself (updates,
agents), the speed of a standard persistent disk, Telegram and the daily rollups, and the 1 GB of outbound data.

## 9. Free for about two years: the relay of free offers

No cloud gives an always-on VM with a public IPv4 address for nothing any more (Oracle's Always Free is the one
exception). Google, AWS and Azure each give a free start to a **new** customer, and the stack is built to move: the
images are made on your PC (`pnpm ship:images`), the data is in the backups, and the address is DuckDNS. So use the
offers one after the other. Taken from their pages of November 2026; look again before each step.

| Stage | Offer                                                                                                                                          | Free for                           | Use                                                                                                                                                                                                                                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Google Cloud Free Trial: $300 of credit (card needed; a hold of up to $1)                                                                      | 90 days                            | A bigger VM than the e2-micro (for example `e2-medium`, 2 vCPU and 4 GB: no `small-vm.yml` needed). Do **not** press Activate: let it end and move.                                                                                                                               |
| 2     | AWS Free plan: $100 on sign-up and up to $100 more for activities; a payment method is not always asked for. Not for anyone who had an account | 6 months, or until the credit ends | `t3.small` (2 GB) or `t3.micro`; at list prices (an estimate) the micro with a 30 GB disk and the address is about $14 a month, the small about $21. The account is suspended at the end and kept for 90 days.                                                                    |
| 3     | Azure free account: 750 hours each of `B2ats v2` (x86, 2 vCPU, 1 GiB) and `B2pts v2` (Arm), 2 disks of 64 GB, $200 of credit for 30 days       | 12 months                          | `B2ats v2` (the images are `amd64`, as for the e2-micro) with `deploy/small-vm.yml`. The public IPv4 address is not in the free list: $0.005 an hour (about $3.65 a month). A card (not prepaid) and a move to pay-as-you-go within 30 days are needed to keep the free services. |
| 4     | Your choice                                                                                                                                    | as long as you like                | The Google e2-micro (Always Free, plus about $3.65 a month for the address), a small paid VPS, your own PC (`pnpm local up`), or Oracle if its sign-up works later.                                                                                                               |

Two rules make it work:

- **Make each account only when its stage starts.** The free clock runs from the sign-up, not from the first VM. One
  account per cloud, in your own name: the offers are for new customers, and a second account would break their terms.
- **Keep the backups outside the cloud you are leaving** (section 8, step 4), and keep your offline age key.

### Moving to the next VM

This puts the checked parts together (sections 2, 5 and 8); the whole move was not run on two real VMs. Expect 20 to 40
minutes without a record, and the ticks of the last 14 days are not carried over (the backups skip them: section 5).

1. On the old VM: the last backup by hand, `sudo /opt/vmgs/deploy/scripts/compose.sh --profile ops run --rm backup`, and
   check that its file is in the bucket (`rclone lsf`).
2. On the new VM: make it (section 8 steps 2 and 6; section 1 for the keys), copy the old `.env` as it is (**the same
   `APP_ENCRYPTION_KEY` and passwords**: a new key makes the second login step unreadable), put your offline age private
   key in `/opt/vmgs/secrets/drill.key`, and `deploy.sh --first --images FILE`.
3. **Stop the old worker** (`compose.sh stop worker`; two workers on one Telegram bot token fight over its messages) and
   turn its DuckDNS timer off (`sudo systemctl disable --now vmgs-duckdns.timer`), or the two VMs take the name from each
   other.
4. On the new VM, restore the backup (section 5), then `smoke.sh --public` and `pnpm e2e:stack` from your PC.
5. When the new VM has recorded for a day and the System page is green, delete the old VM and its disk.

## 10. Free for good (not run on the real services yet): the database on Aiven, the worker on a free container

The idea of this section is that **only the worker has to run all the time**. The state lives in a free managed Postgres,
the worker is a container with no state of its own (so moving it to another host never touches the data again), and the
dashboard is only needed when you want to look. Alerts go to Telegram from the worker. What was read on the pages of
November 2026 and what was run on a PC (a Postgres made to behave like Aiven: TLS only, an admin that is not a
superuser, `max_connections` 20, 1 GB and 1 CPU; the real feed; the worker and the API in 256 MB and a quarter of a CPU):

| What                                       | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aiven free PostgreSQL                      | No card, no time limit, 1 CPU, 1 GB RAM, 1 GB disk, backups, pgvector, `max_connections` 20 (3 to 6 reserved), no pooling, no static IP, one per organisation. Aiven may power it off when there is no activity (the worker writes every second) and may change its cloud or region.                                                                                                                                                                                                                  |
| Migrations as a non-superuser admin        | **Found and fixed:** `0005` grants `pg_read_all_data`, which such an admin cannot. `0005_backup_role.fallback.sql` runs instead, only after that refusal; the command says so ("migration 5 ran its fallback file").                                                                                                                                                                                                                                                                                  |
| TLS                                        | Without the CA of Aiven a URL with `?sslmode=require` fails ("unable to verify the first certificate"); with `NODE_EXTRA_CA_CERTS=/path/ca.pem` it works with no change of code, and so does `DATABASE_CA_PEM` (the text of `ca.pem`, for a host that cannot mount a file: wrong CA, no CA and not-a-certificate were all refused, and the worker ran 28 s to its first heartbeat over TLS 1.3 with only that). `sslmode=verify-full&sslrootcert=` works. `sslmode=disable` is refused by the server. |
| Worker in 256 MB and 0.25 CPU              | Heard from after 27 s; 0.02 CPU on average; memory peak 151 MiB; one connection in steady state; no out-of-memory kill.                                                                                                                                                                                                                                                                                                                                                                               |
| API in 256 MB and 0.25 CPU                 | Ready; peak 114 MiB; the owner is made over TLS.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Size                                       | 3 months of candles: 13 MB. Ticks: about 1.6 a second, 219 bytes a row with the indexes, so the 14 days that are kept are about 290 MB. It fits the 1 GB.                                                                                                                                                                                                                                                                                                                                             |
| `pg_dump` as `vmgs_backup` (as the backup) | 400 KB, 245 entries, no tick data: the rights of the fallback are enough.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| The database restarts (a maintenance)      | The worker stops and the platform has to start it again; it was heard from again 30 s after the restart. **The host must restart a stopped container.**                                                                                                                                                                                                                                                                                                                                               |

### The short way, for someone new

**What runs where.** Two containers made from the same repository, and one database:

- **Aiven** is the database. Its address (the "Service URI") is used by the two containers and by you, not by a browser.
- **The worker container** (Back4app, below) takes the prices, records them, thinks, and sends the messages to Telegram. It
  has no page for people; only a small health page on its `PORT` for the host's own checks.
- **The website container** (a second app on the same host) is the dashboard: the API and the web app. The host gives it a
  public `https://` address. That address is the website you open, on your phone too.

1. **Aiven** (about 10 minutes): sign up (no card), make one free PostgreSQL service, wait until it says Running. On its
   Overview page copy the **Service URI** (a line that starts with `postgres://`) and download the **CA certificate**
   (`ca.pem`). Save the certificate as `.local\aiven-ca.pem` in this repository (make the folder `.local` if it is not
   there).
2. **On your PC**, in a terminal in this repository: `pnpm install` once, then `pnpm aiven setup`. It asks for the Service
   URI (hidden while you paste), the place of the certificate (Enter if you used the name above), your Telegram token
   (hidden; Enter to skip) and the Healthchecks link of the `worker` check (Enter to skip). It sets up the tables and the
   roles, imports the history if the HistData zips are in `data/histdata`, and writes two files: `.local\back4app-vars.txt`
   (the worker) and `.local\back4app-site-vars.txt` (the website), one `NAME=value` per line. It stops at the first problem
   and says what to fix; running it again is harmless. **Those files hold passwords: do not commit them and do not send them
   to anyone.**
3. **The worker on Back4app Containers**: sign up, connect your GitHub account, make a new container app from the repository,
   branch `main`, root directory `/` (the `Dockerfile` at the root builds the image), **Port `8080`** (it asks for it; the
   image also says `EXPOSE 8080`), and paste the lines of `back4app-vars.txt` as the environment variables. Choose the free
   size (0.25 CPU, 256 MB). What the first real deploy showed: Back4app builds with its own builder (kaniko), which ignores
   `COPY --chmod` (a script then had no executable bit: "Permission denied"; now set by `RUN chmod` and started through bash),
   it asks for a port, and it looks at that port about 10 s after the start with a timeout of 1 s, while the worker needs
   about 15 s on a quarter of a CPU before its own health page listens. So `deploy/scripts/early-health.mjs` answers on `PORT`
   at once (`200 starting`) and passes the questions to the health page of the worker, one port higher, as soon as it is up
   (measured on a PC at 256 MB and 0.25 CPU: first answer after about 1 s, `ok` after 16 s, memory peak 123 MB).
4. When the deploy finishes: `pnpm aiven status` must say **ALIVE**. The `worker` check of Healthchecks turns green. Pause the
   checks `backup` and `drill` there (this mode has no backup job of its own: Aiven keeps backups), or they will tell you
   every day that no backup came.
5. **The website on Back4app**: a second container app from the same repository, the same branch and root directory, and the
   lines of `back4app-site-vars.txt` as its environment variables (the line `VMGS_ROLE=site` is what makes it the website).
   The free size is enough (peak 150 MB of 256). When it is created, the host shows its address (for example
   `myname.b4a.run`). Then, on your PC:

   ```text
   pnpm aiven site myname.b4a.run     # puts the address into the settings of the website
   ```

   Replace the line `PUBLIC_HOST=...` of the website container with the one it prints and deploy it again: the login accepts
   only the address it was told (that is a safety rule, and the address is known only after the first deploy). Then:

   ```text
   pnpm aiven owner                   # your login: asks for the password twice (at least 12 characters)
   ```

   Open `https://myname.b4a.run` and log in. A forgotten password: `pnpm aiven admin owner:password owner`; "too many failed
   attempts" when it was not you: `pnpm aiven admin throttle:reset`.

6. Telegram: `pnpm aiven link`, send the bot `/link <the code it prints>`, then `pnpm aiven test`: a test message must
   arrive in Telegram within seconds.

If the host has only **one** free container: `VMGS_ROLE=both` runs the worker and the website in it. On a PC it ran in 256 MB
and 0.25 CPU (6 of 6 browser checks passed) but the memory peak was 255 of 256 MB: too close to count on. In 512 MB it is
comfortable; the two settings files are then merged into one (the worker's `DATABASE_URL_WORKER` is added to the website's
lines, and `PORT` belongs to the website).

If a host does not accept a container that only records (it wants a web page): the worker answers on `PORT` with `200 ok`
while its heartbeat is fresh, `200 starting` during its first two minutes, and `503` when the heartbeat is stale. The website
container answers `200` on `/api/v1/health/live`.

What was run on a PC for this (a Postgres made to behave like Aiven, a proxy that does what the host does: TLS in front and
`X-Forwarded-For`): the image of the root `Dockerfile` in both roles; `pnpm aiven setup`, `site`, `owner`, `admin`, `status`;
the worker and the website each in 256 MB and a quarter of a CPU (peaks 117 MB and 143 MB); `pnpm e2e:stack` 6 of 6 against
the website through the proxy (right after the start the engine is still warming up and the dashboard says so: two of six
checks failed in the first two minutes and passed after four); seven wrong logins with seven different spoofed
`X-Forwarded-For` counted as one visitor (the sixth got 429), and `throttle:reset` lifted it; a container whose api cannot
start stops by itself within seconds (so that the host restarts it). Not run: the real Back4app (its address, the TLS proxy,
whether a second free container exists, whether it sleeps). **If its proxy is not on a private address, all visitors count
as one**: the limit of failed logins is then shared, which can lock you out for a while (`throttle:reset`) and never lets a
stranger in.

### The website on Render (a permanent free address)

What the first real deploy on Back4app showed: its free plan gives a public address that is **temporary (60 minutes)**, with
"Upgrade for a Permanent URL". The worker needs no address and keeps running there; the website does need one. Render's free
web service has a permanent `onrender.com` address, managed TLS and builds the `Dockerfile` of the repository (its docs say so).
It **sleeps after 15 minutes without a visit** and wakes in about a minute: fine for a dashboard that is looked at now and then,
because all the state is in Aiven. Its pages were read for this, nothing was run on Render: its free size (memory, CPU), whether
it asks for a card, and the address of its proxy (see the note on `X-Forwarded-For` above) are not verified.

1. On your PC: `pnpm aiven render`. It writes `.local\render-site-vars.txt` (the settings of the website: `PORT=10000`, no
   `PUBLIC_HOST`: Render tells the container its own name in `RENDER_EXTERNAL_HOSTNAME`, and `entry.sh` uses it, so there is
   no second deploy). **The file holds passwords: do not commit it and do not send it to anyone.**
2. Sign up at `render.com` (with GitHub). If it asks for a card, stop there and use the dashboard on your PC instead.
3. Dashboard: **New**, **Web Service**, **Git Provider**, the repository `vm-gold-signal`. Fields: **Name** `vmgs-site` (the
   address is `https://vmgs-site.onrender.com` if the name is free; otherwise Render adds letters), **Region** the one nearest
   to Aiven (Bangalore: Singapore, if it is offered), **Branch** `main`, **Language** `Docker` (the `Dockerfile` of the root is
   the default), **Instance type** `Free`.
4. **Advanced**: **Environment Variables**: one per line of `render-site-vars.txt` (`NAME` and `value`; the long
   `DATABASE_CA_PEM` is one value). **Health Check Path**: `/`.
5. **Create Web Service.** The first build takes several minutes. When it is live, its address is at the top of the page.
   Then, on your PC: `pnpm aiven owner` (your login: the password twice, at least 12 characters), and open the address.
   The first visit after a sleep shows a loading page for about a minute.
6. Forgot the password: `pnpm aiven admin owner:password owner`. "Too many failed attempts" when it was not you:
   `pnpm aiven admin throttle:reset`.

### The same by hand

Steps (nothing here was run against Aiven itself):

1. Sign up at Aiven (no card) and make one free PostgreSQL service. On its page copy the host, the port, the user
   (`avnadmin`), the password, and download the CA certificate (`ca.pem`). The database is `defaultdb`.
2. On your PC, in the repository after `pnpm install`: three passwords with
   `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` (one run for each), then the schema and the
   roles (PowerShell):

   ```powershell
   $env:NODE_EXTRA_CA_CERTS = 'C:\path\to\ca.pem'
   $env:DATABASE_URL_ADMIN = 'postgres://avnadmin:PASSWORD@HOST:PORT/defaultdb?sslmode=require'
   $env:DB_PASSWORD_WORKER = '...'; $env:DB_PASSWORD_API = '...'; $env:DB_PASSWORD_BACKUP = '...'
   pnpm cli db:migrate        # applied 1, 2, 3, 4, 5, 6 (and: migration 5 ran its fallback file: that is normal here)
   ```

3. The history, before the worker starts (`docs/06`, "HistData download and import"), with
   `DATABASE_URL_WORKER=postgres://vmgs_worker:...@HOST:PORT/defaultdb?sslmode=require` in the environment:
   `pnpm research histdata:import <the newest three zips>`.
4. The worker, on any host that runs a Docker image and restarts it when it stops: the image of `deploy/Dockerfile`, target
   `app` (its default command is the worker), with `NODE_ENV=production`, `PUBLIC_HOST` (any name), `DATABASE_URL_WORKER`,
   `FEED_PROVIDER=biquote`, `FEED_SYMBOLS=XAUUSD,DXY,XAGUSD`, `PORT=8080`, `TELEGRAM_BOT_TOKEN`, `HEALTHCHECKS_PING_URL`, and the CA:
   `DATABASE_CA_PEM` = the text of `ca.pem` (one line with `\n` for the line breaks is fine), with the URL left as Aiven
   gives it (`?sslmode=require`). The connection is then verified against that CA; a wrong or missing CA stops the worker,
   and a value that is not a certificate is refused at start. (Where a file can be mounted, `NODE_EXTRA_CA_CERTS` does the
   same.) TLS verification is never switched off. 256 MB and 0.25 CPU are enough.
5. Telegram (`telegram:link`) and Healthchecks.io as in section 2.

Not built and not checked, so do not count on them yet: a real Aiven service (the rights of `avnadmin` and its CA are taken from its documentation, not
tried); a real free container host (Back4app Containers lists a free container of 0.25 CPU and 256 MB with Docker, 100 GB of
transfer and a US region; whether it sleeps, restarts a stopped container, builds from a private repository, and how many
free containers you get, its pages do not say); the delay between the host and the database (keep them on one continent:
every tick batch is a round trip); and the connection limit when the API runs beside the worker (the API has a pool of 10,
the worker of 8, the service allows 14 to 17 for you: measured use was 1 and 1).
