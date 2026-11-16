# Free for good: Aiven + Render (+ your PC)

The way that was run for real in November 2026: **no card, no time limit, nothing to pay**. The runbook for your own server
(a VM with Docker) is [`README.md`](README.md); this file is the free way.

## 1. What runs where

```text
 Biquote feed ──► worker ──► Aiven PostgreSQL ◄── api + website ◄── your browser / phone
                    │                                  (one Render service, VMGS_ROLE=both)
                    ├──► Telegram (alerts)
                    └──► Healthchecks.io (the worker pings it every minute)

 UptimeRobot ──► the Render service, every 5 minutes (keeps it awake; mails you if the worker is not heard from)
```

- **Aiven** keeps all the state (a free PostgreSQL). The worker and the website have none of their own.
- **Render** runs one free web service from the `Dockerfile` of this repository. In it the worker, the api and Caddy
  (the website) run together (`VMGS_ROLE=both`, see `deploy/scripts/entry.sh`). Caddy serves the web app, passes `/api` to
  the api and sets the security headers; it has no certificate part (`deploy/Caddyfile.site`), because Render does the
  https. If any of the three stops, the container stops and Render starts it again.
- **UptimeRobot** asks the service for a page every 5 minutes. Render puts a free service to sleep after 15 minutes
  without a request, and a sleeping worker records nothing.
- **Your PC** can run the same worker in Docker (`pnpm aiven here`) on the days when Render is not running it.

What the free plans give (read on their pages in November 2026):

| Service      | Free plan                                                                                                                                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aiven        | PostgreSQL with 1 CPU, 1 GB RAM, 1 GB disk, `max_connections` 20 (3 to 6 reserved), no pooling, no fixed IP, one service per organisation, no card, no end date. Aiven may power it off when there is no activity (the worker writes every second) and may change its cloud or region. |
| Render       | One free web service: 0.1 CPU and 512 MB, 750 instance hours a month for the workspace (one service can run all month, a second one cannot), asleep after 15 minutes without a request, restarted by Render at any time, a permanent `onrender.com` address with TLS.                  |
| UptimeRobot  | HTTP monitors every 5 minutes (a shorter interval is a paid feature), e-mail alerts.                                                                                                                                                                                                   |
| Healthchecks | The free Hobbyist plan, a check with an e-mail or Telegram alert.                                                                                                                                                                                                                      |

## 2. Set up once

### 2.1 Aiven (about 10 minutes)

1. Sign up at Aiven (no card) and make one **free PostgreSQL** service. In the run: PostgreSQL 18, a DigitalOcean region
   near India. Wait until it says Running.
2. On its Overview page copy the **Service URI** (a line that starts with `postgres://`) and download the **CA certificate**
   (`ca.pem`). Save the certificate as `.local\aiven-ca.pem` in this repository (make the folder `.local` if it is not
   there).
3. Leave the IP allow list as it is (open): a free host has no fixed address. The connection is TLS with the CA of Aiven
   checked; a wrong or missing CA stops the worker, and TLS verification is never switched off.

### 2.2 On your PC: `pnpm aiven setup`

In a terminal in this repository: `pnpm install` once, then `pnpm aiven setup`.

It asks for the Service URI (hidden while you paste), the place of the certificate (Enter if you used the name above),
the token of your Telegram bot (hidden; Enter to skip) and the ping link of the Healthchecks `worker` check (Enter to
skip). Then it sets up the tables and the three database roles, imports the history if the HistData zips are in
`data/histdata` (how to get them: `docs/06_Phases_and_Setup.md`, "HistData download and import"), and writes three files
in `.local\`: `render-vars.txt`, `render-site-vars.txt` and `worker-vars.txt`, one `NAME=value` per line. It stops at the first
problem and says what to fix; running it again is harmless (the passwords and the key of the login are kept).

**Those files hold passwords. Never commit them, never paste them in a chat, never send them to anyone.**

"Migration 5 ran its fallback file" in its output is normal: Aiven's admin is not a superuser and cannot grant
`pg_read_all_data`, so `0005_backup_role.fallback.sql` runs instead.

### 2.3 Render: the service

1. Sign up at `render.com` with GitHub. This way is for free with no card: if Render asks for one, stop here and use
   `pnpm aiven here` (section 4) until you have decided.
2. **New**, **Web Service**, **Git Provider**, the repository. **Name** anything (the address is
   `https://<name>.onrender.com`), **Region** the one nearest to your Aiven region, **Branch** `main`, **Language**
   `Docker` (the `Dockerfile` at the root is the default), **Instance Type** `Free`.
3. **Environment Variables**: one per line of `.local\render-vars.txt` (the name before the first `=`, the rest is the
   value; the long `DATABASE_CA_PEM` is one value). There is no `PUBLIC_HOST` in it: Render tells the container its own name
   (`RENDER_EXTERNAL_HOSTNAME`) and `entry.sh` uses it.
4. **Health Check Path**: `/`.
5. **Auto-Deploy: off** (Settings). Every deploy restarts the container, and the worker records nothing for the minutes
   of it (about two); deploy by hand with **Manual Deploy** when you mean to.
6. **Create Web Service.** The first build takes several minutes. When the log says "Your service is live", open the
   address. Some `502` lines from Caddy in the log during the first minutes are normal: the api needs about 90 seconds
   before it listens on a 0.1 CPU.

### 2.4 The owner (your login)

There is no sign-up page and no "forgot password": the owner is made on your PC, against the database.

```text
pnpm aiven owner        # asks for the password twice (at least 12 characters; nothing is shown while you type)
```

Then open the address of the service and log in as `owner`.

| What                                          | Command                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| Forgot the password                           | `pnpm aiven admin owner:password owner`                                     |
| "Too many failed attempts" and it was not you | `pnpm aiven admin throttle:reset` (then log in at once)                     |
| The phone with the authenticator app is lost  | `pnpm aiven admin owner:totp-off owner`                                     |
| Who is logged in; end every session           | `pnpm aiven admin owner:status`, `pnpm aiven admin sessions:revoke-all`     |
| Is the worker running?                        | `pnpm aiven status` (ALIVE when its heartbeat is less than two minutes old) |

The failed-login limit is five per client in 15 minutes. If a host's proxy is not on a private address, all visitors count
as one client: that can lock you out for a while (`throttle:reset`) and never lets a stranger in.

### 2.5 UptimeRobot: keep the service awake

1. `uptimerobot.com`, sign up with your e-mail (no card).
2. **New monitor**, type **HTTP(s)**, URL `https://<name>.onrender.com/api/v1/health/ready`, interval **5 minutes** (the
   shortest on the free plan), your e-mail as the alert contact.

That page answers 200 while the worker has written a heartbeat and 503 when it has not, so the monitor also tells you
that the recording stopped. Do not use 15 minutes: that is exactly when Render puts the service to sleep.

### 2.6 Healthchecks.io

One check, `worker` (period 1 minute, grace 5 minutes), with your e-mail or Telegram as the integration. Paste its ping
URL when `pnpm aiven setup` asks (or put it in the Render variable `HEALTHCHECKS_PING_URL`). The worker pings it by itself
every minute; do not put this URL anywhere else (a monitor that calls it would keep the check green with a dead worker).
The `backup` and `drill` checks belong to the server way and are not used here.

### 2.7 Telegram

1. Make a bot with `@BotFather` and give its token to `pnpm aiven setup` (or run it again, and Enter keeps the other values).
2. `pnpm aiven link` prints a one-time code (good for 10 minutes; void after 5 wrong tries). Send the bot `/link <code>`.
3. `pnpm aiven test` queues a test message; the running worker sends it within seconds.

The strategies are in forward testing: treat every alert as a test, not as an instruction to trade.

## 3. When something stops

| What happens                                  | What you see                                                                              | What to do                                                                                                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Render restarts the service (or you deploy)   | A gap of about two minutes; the engine says it recovers from a data gap for about an hour | Nothing. The worker starts again by itself.                                                                                                                                          |
| Render puts the service to sleep              | `pnpm aiven status` says NOT ALIVE; UptimeRobot mails                                     | Open the address once (it wakes in about a minute). If it keeps happening, check that the UptimeRobot monitor is up and the interval is 5 minutes.                                   |
| The Aiven database is restarted (maintenance) | The worker stops with it; Render starts the container again                               | Look at **Maintenance** on the Aiven page for the window (in the run: Tuesdays after 21:29 UTC). The worker was heard from again about 30 s after a database restart on the test PC. |
| The feed is cut                               | Telegram feed alert; the worker stays up and records the incident                         | Nothing; it closes the incident when prices return.                                                                                                                                  |
| Render suspends or stops the service          | NOT ALIVE for good; an e-mail from Render                                                 | Read the mail. Run the worker on your PC meanwhile (section 4).                                                                                                                      |

A minute in which no worker ran has no ticks and stays a gap. It can be filled only from the HistData files
(`pnpm aiven import`), and only when a file that covers it exists: the feed has no replay of old ticks.

## 4. The worker on your PC

When the worker of Render is not running, the same worker can run on your PC in Docker, against the same database and
the same Telegram bot:

```text
pnpm aiven here          # builds the image of the root Dockerfile and starts the worker (it restarts with Docker)
pnpm aiven status        # ALIVE after about a minute and a half
pnpm aiven here logs     # its log (Ctrl+C leaves it running)
pnpm aiven here stop     # removes it
```

It uses `.local\worker-vars.txt` (written again every time), 384 MB and one CPU, a read-only file system and no extra rights.
It records **only while the PC is on, Docker Desktop is running** (Settings, "Start Docker Desktop when you sign in") **and
the PC does not sleep**. The website on Render shows the live data as long as it runs.

**Never run it at the same time as the worker of Render**: two workers write the same ticks and take turns on the one
Telegram bot. Stop one of them first (`pnpm aiven here stop`, or suspend the Render service).

To run only the website on Render and the worker here, use `.local\render-site-vars.txt` (`VMGS_ROLE=site`) in Render
instead of `render-vars.txt`.

## 5. Settings reference

The lines of `render-vars.txt`. Any host that runs the image of the root `Dockerfile` takes the same variables.

| Variable                                      | Value and meaning                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `VMGS_ROLE`                                   | `worker` (the default), `site` (api and website) or `both`. `entry.sh` starts what the role says; a process that ends stops the container.  |
| `PORT`                                        | The port of the website (`both`, `site`: Render uses 10000) or of the health page of the worker (`worker`).                                 |
| `NODE_ENV`, `LOG_LEVEL`                       | `production`, `info`.                                                                                                                       |
| `FEED_PROVIDER`, `FEED_SYMBOLS`               | `biquote`, `XAUUSD,DXY,XAGUSD`.                                                                                                             |
| `DATABASE_URL_WORKER`, `DATABASE_URL_API`     | The Aiven URL with the role `vmgs_worker` or `vmgs_api` and its password, `?sslmode=require`.                                               |
| `DATABASE_CA_PEM`                             | The text of `ca.pem` (one line; `\n` for the line breaks is fine). The connection is verified against it.                                   |
| `DATABASE_POOL_MAX`                           | Connections per program (1 to 20). 5 for `both`: the api and the worker stay under the 20 of the free database, with room for you.          |
| `APP_ENCRYPTION_KEY`                          | 32 random bytes in hex. The second step of the login is encrypted with it: it is made once and never changed (losing it: `owner:totp-off`). |
| `API_TRUSTED_PROXY_HOPS`                      | `2`: Caddy and the proxy of the host (`deploy/Caddyfile.site`).                                                                             |
| `TELEGRAM_BOT_TOKEN`, `HEALTHCHECKS_PING_URL` | Optional: without the token no Telegram message is sent; without the URL nothing is pinged.                                                 |
| `PUBLIC_HOST`                                 | Only for a host that is not Render: the public name of the website. On Render it comes from `RENDER_EXTERNAL_HOSTNAME`.                     |

The Postgres side: three roles, one per program (`vmgs_worker`, `vmgs_api`, `vmgs_backup`), made by the migrations with the
passwords of `pnpm aiven setup`.

## 6. What was measured, and what was not

Measured on a PC, with Docker limited to the free size of Render (0.1 CPU, 512 MB), the image built the way Render builds
it, a Postgres with the same three months of HistData (21,505 candles) as the real Aiven, and the real Biquote feed (three
runs):

- Caddy answers `/` at once; the api listens after about 90 to 104 seconds; the worker is warmed up about 25 seconds
  later; `/api/v1/health/ready` is 200 at 90 to 104 seconds.
- After that the pages answer in 12 to 40 ms and the container uses 1 to 2 % of its CPU at rest.
- Memory peaked at 210 MiB. (In a 256 MB container the same two programs peaked at 255 MiB: too tight.)
- Database connections: 6 for the api and 2 for the worker at a pool of 6, hence `DATABASE_POOL_MAX=5`.
- Network: about 8 KB/s in and 5 KB/s out, about 0.4 GB a day out.
- `docker stop` took 1.3 s with exit code 0.
- The size of the data: 3 months of candles are 13 MB; ticks are about 1.6 a second at 219 bytes a row with the indexes, so
  the 14 days that are kept are about 290 MB, which fits the 1 GB.

Run for real: Aiven (PostgreSQL 18, DigitalOcean) with the migrations and the fallback, the history imported, the worker
ALIVE, Telegram delivering a test message and a real market-spike alert, the website live on Render with HTTPS, HSTS and a
content policy, the login made, UptimeRobot monitoring it.

**Not verified on Render itself**: that Render does not count a service that writes to a database all day as "uncommonly
high service-initiated traffic" (its documentation says it may suspend such a service); that it accepts a monitor that
keeps the service awake; how often it restarts a free service; and that its 0.1 CPU behaves like the limit of Docker.
Aiven's own backups on the free plan (how many, for how long) were not checked: this way has no backup of its own (the
encrypted nightly backups belong to the server way). The candles can be imported again from the HistData files; the
ticks of the last 14 days exist only in the database.

## 7. What went wrong on the way (and is fixed)

- **A migration as a non-superuser.** `0005` grants `pg_read_all_data`, which Aiven's admin cannot: a fallback file runs
  after that refusal.
- **A builder that ignores `COPY --chmod`**: the entry script had no executable bit ("Permission denied"). The Dockerfile
  sets the bits with `RUN chmod` and the entry point starts the script through `bash`.
- **A host that redeploys on every push to GitHub** stops the worker for the minutes of the deploy: Auto-Deploy is off
  on Render.
- **A free container host that locked the account** without a reason that was told: the worker moved to Render, and
  `pnpm aiven here` is the way out on any day.
- **Test clocks.** Two tests of the preview data had the numbers of one month in them and failed in the next one; the
  clock of those tests is fixed.
