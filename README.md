# VM Gold Signal

Private XAU/USD decision-support system (manual execution). Design lives in [`docs/`](docs/01_HLD.md); delivery phases are in [`docs/06_Phases_and_Setup.md`](docs/06_Phases_and_Setup.md).

## Requirements

- Node 24 LTS (see `.nvmrc`; Node 22.22+ also works for development)
- pnpm 10 (`packageManager` in `package.json`)
- Docker (database integration tests, from phase B2)

## Commands

```text
pnpm install
pnpm check          # typecheck + lint + format check + tests + audit of production dependencies
pnpm test:watch
```

## Layout

```text
apps/       web, api, worker (added in their phases)
packages/   core (pure domain code), contracts (Zod schemas), db, feed, ...
tools/      research and admin CLIs
docs/       architecture, specs, plan
```
