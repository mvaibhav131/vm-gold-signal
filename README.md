# VM Gold Signal

Private XAU/USD decision-support system (manual execution). Design lives in [`docs/`](docs/01_HLD.md); delivery phases are in [`docs/06_Phases_and_Setup.md`](docs/06_Phases_and_Setup.md).

## Requirements

- Node 24 LTS (see `.nvmrc`; Node 22.22+ also works for development)
- pnpm 10 (`packageManager` in `package.json`)
- Docker (database integration tests, from phase B2; Testcontainers starts its own throw-away `pgvector/pgvector:pg17` container on a random port and does not touch other containers)

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
pnpm cli db:migrate | worker:alive | env:check [worker admin backup api] | backup:counts | backup:plan | backup:check   # B31: the operations commands the deploy and backup scripts use (they read the environment, see deploy/env.example)
pnpm api:cli owner:create <username>        # B29: makes the owner (asks for the password twice, no echo); owner:password, owner:totp-off, owner:status, sessions:revoke-all, throttle:reset. There is no sign-up route. On the VM: deploy/README.md, "Making yourself the owner"
pnpm api:start                              # the API (B29, B30); needs DATABASE_URL_API, PUBLIC_HOST, APP_ENCRYPTION_KEY in .env. With SITE_ORIGIN=http://localhost:5173 and VITE_DATA_SOURCE=live pnpm web:dev the preview talks to it (U5: Vite sends /api to port 3000)
sudo deploy/scripts/deploy.sh --first       # B31, on the VM: build, migrate, start, smoke test. The whole runbook is deploy/README.md
pnpm web:dev        # the UI preview on simulated data, http://localhost:5173 (login: owner / preview); the Dashboard has a "Preview state" picker, or open /login?scenario=stale (ids: two-open, open-buy, tp1-hit, wait, warming-up, stale, disconnected, market-closed, review-pending, paused, news-unknown, system-warning); the Signals screen lists 43 simulated signals over three months and the Analytics screen shows them next to a simulated 12-month backtest (switch at the top, or /analytics?scope=BACKTEST_OOS); the News screen shows the calendar, 14 headlines and 5 market moves (/news?tab=headlines); the System screen has the health, the storage, the strategies, the alert settings, the time zone and the security (/system?tab=alerts; in the preview a changed password is shown on the login page, and the code of the 2-step login is 123456)
pnpm e2e:install    # once: downloads Chromium for the e2e tests
pnpm e2e            # builds the web app and runs the Playwright scenarios (DOM and axe checks, no screenshots)
pnpm e2e:live       # U5b/U5c: builds the web app with --mode live and runs the scenarios against the whole API on a real Postgres (Docker) with a simulated worker that a test can move (a signal, a quiet feed, a dead worker), in a seeded world and then a fresh one (e2e/live/)
pnpm e2e:stack      # U5c: a read-only look in a browser at a stack that is running (the drill on this PC, or the VM): headers, every screen, the price moving. Needs VMGS_STACK_PASS; see deploy/README.md section 6
pnpm web:budget     # after a build: the initial route must stay under 400 KB gzip
```

## Layout

```text
apps/       web (React + Mantine; mock data in the preview, the live client of U5 for a build with VITE_DATA_SOURCE=live), api and worker
packages/   core (pure domain code), contracts (Zod schemas), config (env and strategy config), db, feed, ...
tools/      research and admin CLIs
deploy/     Dockerfile, compose stack, Caddyfile, deploy / backup / drill scripts, systemd timers (runbook: deploy/README.md)
e2e/        Playwright scenarios
docs/       architecture, specs, plan
```
