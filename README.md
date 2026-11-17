# VM Gold Signal

XAU/USD decision-support system (manual execution only: it never trades). Design lives in [`docs/`](docs/01_HLD.md); delivery phases are in [`docs/06_Phases_and_Setup.md`](docs/06_Phases_and_Setup.md).

## Requirements

- Node 24 LTS (see `.nvmrc`; Node 22.22+ also works for development)
- pnpm 10 (`packageManager` in `package.json`)
- Docker (database integration tests, from phase B2; Testcontainers starts its own throw-away `pgvector/pgvector:pg17` container on a random port and does not touch other containers)

## Run it on your PC with live data

This starts the whole system on your own PC, in Docker: the real worker on the real feed (Biquote), the API, and the web app, at **https://localhost:18443**. Nothing else on the PC is touched: it has its own Docker project (`vmgs-local`) and uses only the ports 18080, 18443 and 15432 on `127.0.0.1`, so nobody else on your network can see it.

**One terminal is enough**, in the folder of this repository. Everything runs in the background inside Docker, so each command does its job and gives the prompt back. The commands are plain `pnpm local ...`, the same in PowerShell, cmd, Git Bash and WSL (tried on Windows). One difference: `pnpm local owner` and `pnpm local admin` ask for a password; PowerShell and Windows Terminal hide what you type, Git Bash shows it.

**Before the first start (once)**

1. Install Docker Desktop.
2. `pnpm install` (the history import needs it).
3. Optional, for a full chart at once: put the HistData zips in `data/histdata/` (how: `docs/06_Phases_and_Setup.md`, "HistData download and import"). Without them the system works too, but the chart fills only as live candles arrive and the engine needs about a day of live data before it can think.

### First time

Start Docker Desktop and wait until it says the engine is running. Then, one after the other:

```text
pnpm local up        # builds and starts everything (a few minutes the first time)
pnpm local owner     # makes your dashboard login: asks for a password twice (at least 12 characters)
pnpm local import    # fills the chart from the HistData zips and restarts the worker (optional)
pnpm local open      # opens https://localhost:18443
```

The browser warns about the certificate (Caddy made it for this PC only): choose Advanced, then Proceed to localhost. Log in with the user `owner` and the password of the second command.

### Every day

Start Docker Desktop, then:

```text
pnpm local up        # starts everything (about a minute)
pnpm local open      # opens the dashboard
```

When you are done: `pnpm local down` (stops everything and keeps all data).

**What you should see:** the price at the top moving every second, `FEED FRESH`, the chart, the news and the calendar. `Signals 0` is normal: a signal is rare, and after a start the engine says "Recovering from a data gap" until 12 clean 5-minute candles (about an hour) have come in. When the market is closed (Friday night to Sunday night, India time) the price does not move and the chip says `MARKET CLOSED`.

**Other commands**

| What                                                                   | Command                                                                                                                             |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Is the worker alive? Which containers run?                             | `pnpm local status` (it ends with "heartbeat is N s old")                                                                           |
| Watch the worker log                                                   | `pnpm local logs` (or `pnpm local logs api`; Ctrl+C stops watching, not the system)                                                 |
| Forgot the password                                                    | `pnpm local admin owner:password owner` (other commands: `owner:status`, `owner:totp-off`, `sessions:revoke-all`, `throttle:reset`) |
| Start again from nothing (**deletes** the recorded data and the login) | `pnpm local reset`, then `pnpm local up` and `pnpm local owner`                                                                     |

**If something goes wrong**

- "Docker Desktop is not running": start it and wait for "Engine running".
- A port is already used: something else holds 18443, 18080 or 15432. Close it, or run `pnpm local down` if it is an older copy of this.
- The page does not load right after `up`: wait half a minute and reload; `pnpm local status` shows if the api and the worker are healthy.
- The price does not move: it is the weekend, or the feed is down (`pnpm local logs`; the status bar says `STALE` or `DISCONNECTED`).
- A recorded gap: while Docker or the PC is off, no price is recorded, and that time never comes back. The system notices the gap and says so; a PC that is on only some hours gives a thin history.

This is for looking at the system and recording data on your PC. To run it all the time and for free, see the next section; a server of your own (always on, with a real certificate, backups and Telegram) is `deploy/README.md`.

## Run it 24/7 for free (Aiven + Render)

No card, nothing to pay. The data is in a free PostgreSQL on **Aiven**; the worker, the API and the website run together in one free **Render** web service; **UptimeRobot** keeps the service awake and **Healthchecks.io** and **Telegram** tell you when something stops. The full guide, with what was measured and what is not verified, is [`deploy/FREE_HOSTING.md`](deploy/FREE_HOSTING.md). The commands on your PC (one terminal, in this folder):

```text
pnpm aiven setup     # asks for the Aiven Service URI and its CA file, makes the tables and the passwords, writes .local/render-vars.txt
pnpm aiven owner     # makes your dashboard login (asks for the password twice)
pnpm aiven status    # is the worker running? "ALIVE" or not
pnpm aiven link      # the code that links your Telegram chat to the bot; pnpm aiven test sends a test message
pnpm aiven here      # the same worker on THIS PC in Docker, when Render is not running it (here stop, here logs)
pnpm aiven           # the full list
```

The lines of `.local/render-vars.txt` become the environment variables of the Render service (`deploy/FREE_HOSTING.md`, section 2.3). Those files hold passwords: they are never committed, and never go into a chat.

## Commands

```text
pnpm install
pnpm check          # typecheck + lint + format check + tests (unit and database integration) + audit of production dependencies
pnpm test:unit      # fast tests only, no Docker
pnpm test:int       # database integration tests (needs Docker)
pnpm --filter @vmgs/db codegen   # regenerate packages/db/src/types.generated.ts after a migration change
pnpm test:watch
pnpm research histdata:check data/histdata   # B27: reads HistData zips and reports what is in them (no database); histdata:import [--dry-run] writes the history for the engine's warm-up; spread:model prints the spread model. Steps: docs/06, "HistData download and import"
pnpm research backtest:run data/histdata     # B28: the strategies over the history under the three cost scenarios; report and registry go to reports/ (the test period 2025 on is not read unless --holdout); backtest:ablate --strategy k --set path=value compares a variant. See docs/02, section 15.1
pnpm cli db:migrate | worker:alive | env:check [worker admin backup api] | backup:counts | backup:plan | backup:check | vapid:generate   # B31: the operations commands the deploy and backup scripts use (they read the environment, see deploy/env.example)
pnpm api:cli owner:create <username>        # B29: makes the owner (asks for the password twice, no echo); owner:password, owner:totp-off, owner:status, sessions:revoke-all, throttle:reset. There is no sign-up route. On the VM: deploy/README.md, "Making yourself the owner"
pnpm api:start                              # the API (B29, B30); needs DATABASE_URL_API, PUBLIC_HOST, APP_ENCRYPTION_KEY in .env. With SITE_ORIGIN=http://localhost:5173 and VITE_DATA_SOURCE=live pnpm web:dev the preview talks to it (U5: Vite sends /api to port 3000)
sudo deploy/scripts/deploy.sh --first       # B31, on the VM: build, migrate, start, smoke test. The whole runbook is deploy/README.md
pnpm web:dev        # the UI preview on simulated data, http://localhost:5173 (login: owner / preview); the Dashboard has a "Preview state" picker, or open /login?scenario=stale (ids: two-open, open-buy, tp1-hit, wait, warming-up, stale, disconnected, market-closed, review-pending, paused, news-unknown, system-warning); the Signals screen lists 43 simulated signals over three months and the Analytics screen shows them next to a simulated 12-month backtest (switch at the top, or /analytics?scope=BACKTEST_OOS); the News screen shows the calendar, 14 headlines and 5 market moves (/news?tab=headlines); the System screen has the health, the storage, the strategies, the alert settings, the time zone and the security (/system?tab=alerts; in the preview a changed password is shown on the login page, and the code of the 2-step login is 123456)
pnpm e2e:install    # once: downloads Chromium for the e2e tests
pnpm e2e            # builds the web app and runs the Playwright scenarios (DOM and axe checks, no screenshots). The CI runs on Linux, whose font is wider than Windows': VMGS_TEST_FONT=Verdana pnpm e2e shows what the CI sees
pnpm e2e:live       # U5b/U5c: builds the web app with --mode live and runs the scenarios against the whole API on a real Postgres (Docker) with a simulated worker that a test can move (a signal, a quiet feed, a dead worker), in a seeded world and then a fresh one (e2e/live/)
pnpm local up        # the whole system on this PC with the real feed, at https://localhost:18443: the steps are in 'Run it on your PC with live data' above (scripts/local-live.mjs)
pnpm aiven setup     # the free 24/7 way (Aiven + Render): the database and the settings files; see 'Run it 24/7 for free' above (scripts/aiven-setup.mjs)
pnpm e2e:stack      # U5c: a read-only look in a browser at a stack that is running (the drill on this PC, or the VM): headers, every screen, the price moving. Needs VMGS_STACK_PASS; see deploy/README.md section 6
pnpm web:budget     # after a build: the initial route must stay under 400 KB gzip
```

## Layout

```text
apps/       web (React + Mantine; mock data in the preview, the live client of U5 for a build with VITE_DATA_SOURCE=live), api and worker
packages/   core (pure domain code), contracts (Zod schemas), config (env and strategy config), db, feed, ...
tools/      research and admin CLIs
deploy/     Dockerfile, compose stack, Caddyfile, deploy / backup / drill scripts, systemd timers (runbook of the server way: deploy/README.md; the free way, Aiven + Render: deploy/FREE_HOSTING.md)
e2e/        Playwright scenarios
docs/       architecture, specs, plan
```
