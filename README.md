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
pnpm web:dev        # the UI preview on simulated data, http://localhost:5173 (login: owner / preview); the Dashboard has a "Preview state" picker, or open /login?scenario=stale (ids: two-open, open-buy, tp1-hit, wait, warming-up, stale, disconnected, market-closed, review-pending, paused, news-unknown, system-warning); the Signals screen lists 43 simulated signals over three months and the Analytics screen shows them next to a simulated 12-month backtest (switch at the top, or /analytics?scope=BACKTEST_OOS); the News screen shows the calendar, 14 headlines and 5 market moves (/news?tab=headlines); the System screen has the health, the storage, the strategies, the alert settings, the time zone and the security (/system?tab=alerts; in the preview a changed password is shown on the login page, and the code of the 2-step login is 123456)
pnpm e2e:install    # once: downloads Chromium for the e2e tests
pnpm e2e            # builds the web app and runs the Playwright scenarios (DOM and axe checks, no screenshots)
pnpm web:budget     # after a build: the initial route must stay under 400 KB gzip
```

## Layout

```text
apps/       web (React + Mantine; mock data until phase U5), api and worker (added in their phases)
packages/   core (pure domain code), contracts (Zod schemas), config (env and strategy config), db, feed, ...
tools/      research and admin CLIs
e2e/        Playwright scenarios
docs/       architecture, specs, plan
```
