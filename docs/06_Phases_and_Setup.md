# Delivery Plan, Owner Setup and Operations

## 1. Phases and gates

The work is split into small phases so that every step can be built, tested and reviewed on its own. There are two tracks. The **backend track (B)** builds the engine and everything behind it. The **UI track (U)** builds the screens first against typed mock data (always labelled `SIMULATED`), so the owner sees and judges the real interface early; the data layer is then switched to the live API one screen at a time.

Rule for every phase: `pnpm typecheck`, `pnpm lint` and all tests pass before the phase is called done. UI phases also pass their `pnpm e2e` scenarios. Each phase ends with a short report: what changed, what was tested, assumptions, open questions. The next phase does not start on failing tests.

### Backend track

| Phase | Scope | Exit criteria |
|---|---|---|
| B0 Repository and tooling | pnpm 10 workspace (`packageManager` pinned), TypeScript 6.0.3, ESLint 10, Prettier, Vitest, CI skeleton on Node 24 (`typecheck`, `lint`, `test`, `pnpm audit --prod`) | The four commands pass locally and in CI |
| B1 Contracts and config | Zod schemas for ticks, candles, signals, explanations, outcomes and API payloads; environment and strategy-config schemas | Schema round-trip tests; invalid inputs rejected |
| B2 Database | SQL migrations from `03_Data_Model.sql`, migration runner, roles, Testcontainers harness, generated Kysely types | Migrations apply on an empty database; append-only triggers reject UPDATE, DELETE and TRUNCATE; config immutability; partition functions; generated types are up to date |
| B3 Candle builder and sessions | Ticks to 1m and higher timeframes, trading day, IANA sessions, late-tick and gap handling | Fixture tests incl. DST changes and weekend gaps; replay is byte-identical across runs |
| B4 Indicators I (trend, volatility) | EMA, SMA, WMA, Hull, ATR (Wilder), Bollinger, Keltner, Donchian, Supertrend, Parabolic SAR, Aroon, Heikin-Ashi, Choppiness, efficiency ratio, regression | Hand-checked reference vectors plus an independent cross-check against `trading-signals` (test dependency only) |
| B5 Indicators II (momentum, strength) | RSI, StochRSI, MACD, ROC, CCI, Williams %R, Awesome Oscillator, ADX and DI, Ichimoku, realised and Garman-Klass volatility, anchored mean price | Same as B4; incremental and batch results are identical |
| B6 Pivots and structure | Swing pivots, HH/HL/LH/LL, BOS, CHoCH, displacement, FVG, order block, sweep and reclaim | Synthetic fixtures for every primitive; no-look-ahead test (truncated and full history agree up to time t) |
| B7 Levels and zones | PDH/PDL, session highs and lows, round numbers, classic and Camarilla pivot points, equal highs and lows, support and resistance zones, Fibonacci | Fixture tests; zone clustering and flip rules verified |
| B8 Trendlines and channels | Trendline, channel, break and retest algorithms of `02_Signal_Engine.md` 4.1 | Synthetic fixtures (clean, noisy, broken lines); touch counts and validity rules verified |
| B9 Chart patterns | Double top and bottom, head and shoulders, triangles, flags and pennants, wedges, rectangles | Synthetic fixtures plus negative near-miss cases; triggers and targets verified |
| B10 Candlesticks and divergence | Pin bar, engulfing, inside bar, NR7, stars; RSI and MACD divergence | Fixture tests |
| B11 Feed package | Provider interface, replay and simulated providers, Biquote SignalR adapter (reconnect, validation, clock check) | Adapter tested against a local fake SignalR server; manual live probe; replay determinism |
| B12 Recorder (record-only worker) | Batched tick and candle persistence, restart back-fill, gap incidents, database heartbeat | `pnpm worker:soak`: rejected quotes accounted for, persisted tick count matches accepted ticks, at least one candle and gap, no late ticks or queued frames |
| B13 Regime and context | Regime classifier, news-shock flag, session and macro proximity inputs | Fixture tests per regime |
| B14 Gates and advisory flags | Blocking gates, advisory flags and their owner switches | One test per gate and per flag; flags never block unless switched |
| B15 Strategy A | Trend pullback | Positive and negative fixtures; no-look-ahead |
| B16 Strategy B | Liquidity sweep reversal | Same |
| B17 Strategy C | Squeeze breakout and retest | Same |
| B18 Strategy D | Trendline break and retest | Same |
| B19 Strategy E | Chart pattern breakout | Same |
| B20 Scoring, risk, fills | Quality score, risk, exit profiles, fill and outcome model with configurable slippage and manual-execution delay (`02` section 9); strategy E's 1.5 R measured-move rule is checked again with the real fill (`02` section 7.5) | R accounting for every exit path; ties resolved against the trade; a delay moves the fill to the first tick after it, and a delayed price beyond `maxValidEntry` is skipped |
| B21 Explanation and messages | Explanation builder; Telegram and Web Push formatters for the messages about a signal (new, TP1, closed, cancelled, final review) in English plus Hinglish labels, with escaping, the length guard and the lifetimes of messages (`02` section 14.1). News, system, digest and report formatters come with B24, B25 and B26, on the same words and helpers | Golden tests; every required field present in both languages; length limits; the explanation parses with the contract schema |
| B22 Review and statistics | Failure attribution rules with the order of the primary cause and the preliminary and final reviews (`02` section 12.1), Wilson interval, expectancy, profit factor, drawdown, streak, equity curve, bucket keys and fallback with the choice of the evidence (`02` section 13.1) | One test per cause code; statistics checked against published and hand-computed samples; a SELL is the exact mirror of a BUY; the preview statistics of the dashboard equal the core ones |
| B23 Lifecycle | Signal transaction (signal, working state, `CREATED` event, entry alerts, `NOTIFY`), outcome tracker on the stored ticks for many open signals (cancelled and data-invalid rules, also on the clock), restart recovery by replaying the stored ticks, the messages of TP1, result, cancellation and final review, preliminary and final reviews (`02` section 11.1) | Integration tests on Postgres incl. kill and restart mid-trade at every point (the same events, outcomes, messages and reviews as a worker that never stopped); one store contract run against memory and Postgres |
| B24 Alerts | Outbox sender (priority, 1 message per second, retry with `retry_after`, expiry, crash recovery), thin Telegram client on native fetch (sendMessage, getUpdates long polling), owner-only bot with the commands and the one-time link flow, Web Push sender, health watcher (feed down and recovered), system messages, CLI `telegram:link` and `telegram:test` (details in `04` section 4, "Delivery details"). The sender, the bot and the watcher run inside the worker when `TELEGRAM_BOT_TOKEN` and the VAPID keys are set | Fake Telegram server (a real local HTTP server) and PostgreSQL: idempotency, expiry, retry, rate limit, owner-only, link flow, crash recovery |
| B25a Calendar | Calendar poller on Biquote's `/api/Calendar` into `macro_events` (US events, 5 min, 15 s around a watched release, backoff 30 s to 5 min, a 14-day backfill the first time) with the time of the last good reading (`UNKNOWN` news state and a "calendar feed is unavailable" line in `/status` when it is older than 15 minutes), the surprise in sigma from the provider history joined with the own archive, `NEWS_UPCOMING` (30 min ahead, exact times only) and `NEWS_RELEASED` (the figures, the surprise, gold 15 s later) alerts with the news window they open; the engine reads the stored events in B26b (details in `04` section 4, "Calendar alerts") | Fake Biquote calendar server (a real local HTTP server) with rows of the real service as fixtures; one store contract run against memory and Postgres; poller schedule, backoff and availability; alerts once and only once (also after a restart); `UNKNOWN` state on outage |
| B25b Headlines and market moves | RSS and Biquote news pollers (each feed on its own clock, every 60 s, conditional requests, backoff 2, 5 and 10 min, a 2 MB limit), the rule classifier `1.0.0` with its relevance filter, clustering of the same story from several outlets, the 2-hour buffer of unclassified headlines, impact measurement per topic (2, 5 and 10 minutes after a story, `news_topic_stats` with the baseline of ordinary windows), `NEWS_HEADLINE` and `MARKET_MOVE` alerts (with possible causes, the open signals and the headlines frozen into `market_events`), the outage notice of the headline feeds, `NewsContextReader` for the engine; the headline line in signals, `HEADLINE_RECENT` and `NEWS_SHOCK` are connected in B26b (details in `02` section 16, "As built (B25b)", and `04` section 4) | Classification golden tests per topic; duplicate clustering; move-detection fixtures; recorded feed samples (BBC, Al Jazeera, CNBC, Federal Reserve, Biquote); a fake feed server (a real local HTTP server) with ETag, `304`, gzip, hanging, dropped and endless answers; HTML entities such as &#39; decoded; one store contract run against memory and Postgres; a Postgres flow test from the feed to the outbox; outage notice; no causal wording without "possible cause" |
| B26 Rollups and maintenance | Bucket, monthly, evidence-group and failure rollups kept in the transactions that create, close and review a signal (migration `0003`: a `winners` column, sign checks, the narrow snapshot-trimming exception of the `signals` trigger; `0004`: the worker's rights), with nightly reconciliation from the signals that repairs any difference; retention jobs (ticks, 1m candles, feature snapshots, outbox, rejections, incidents, headlines, market events, maintenance runs); the hourly size guard (tick retention 14, 7, 3, 1 days, `STORAGE_WARNING`); `DAILY_DIGEST` and `MONTHLY_REPORT` with their scheduler; the same previews (details in `02` section 13.2 and `04` section 4, "Reports and the storage warning"). The purge of sessions, login attempts and the security audit is done by the API process (B29/B30). | Rollups equal a full recomputation (property tests, 160 random signals on Postgres, concurrent closings, a damaged table repaired); retention test (seed, prune, history intact, rights of the worker role); the guard's ladder, restore and daily warning; report schedule, periods, keys and idempotence; feed uptime without the weekly closure |
| B26b Decision engine | The step that turns a closed 5m candle into a signal (`01` section 5, steps 1 to 4): one incremental `DecisionEngine` fed the closed candles of 5m, 15m and 1h in close order (features, regime, structure, levels, trendlines, gates and flags, strategies A to E, plan, score, explanation, evidence from the rollups) that the warm-up, the live worker and the backtester (B28) all use, so a replay is the same code path; the worker loop around it (warm-up from the database, one decision per closed 5m candle on the first quote after the close, pause state, open-signal count, `rejections`, wait reasons, `SignalCreator`, the engine state in `app_settings.engineState` for `/status`, `/open` and the dashboard); the `ContextSource` of B23 (regime at the close, 15m and 1h changes of character) so that `REGIME_SHIFT` and `HTF_STRUCTURE_BREAK` work; the headline line, `HEADLINE_RECENT`, the news window and the calendar state are connected. Built after B25a (news state) and B26 (evidence) because it needs both; it is why B23 had no signal source of its own. The history that fills the warm-up of a new database is B27 (details in `02` section 10.1) | Replay of stored candles gives the same signals every run and equals the live loop; no look-ahead (the answer for a candle does not change when later candles arrive); one test per way a setup is rejected; a restart rebuilds the warm-up and makes no duplicate signal (Postgres flow test from candles and a quote to the signal, its rollup and the engine state); the signal parses with `signalDraftSchema` |
| B27 Research data | `tools/research` (pnpm research): HistData importer (zip via fflate; fixed UTC-5 to UTC; M1 bars are bid-only while tick files carry bid and ask, so ticks are preferred if available for XAUUSD; both formats are read), checks that count and never repair a bad line, spread model from the recorded 5m spreads by UTC hour (turns bid into mid, and gives B28 its spread), gap report (weekend, daily break, feed holes, coverage), and the history bootstrap for the engine's warm-up: 5m, 15m, 1h, 4h and 1d candles with `source = histdata_bootstrap`, only before the first live minute and never over an existing candle; commands `histdata:check`, `histdata:import [--dry-run]` and `spread:model` (details in `02` section 2.1). The Biquote OHLC gap fill and the MT5 import are not built | Line parsers (time zone with a summer date, every refusal reason, the price bounds), zip and CRLF reading, bars to mid, tick import equal to the live `CandleBuilder`, gap classes, spread model (thresholds, pooling, rounding), the write plan (edge of the live start, hole in trading hours), the commands on a memory store, and the Postgres store (re-import writes nothing, live candles untouched, the spread query); a run of the CLI on a sample zip |
| B28 Backtester | Replay on `core` (the live `DecisionEngine` over the HistData minutes, one signal for each setup), the fill and cost model of the three scenarios on bars (a stop and a target in one bar: the stop; a delayed fill drifts against the trade), train, validation and test splits with the holdout guard (the replay reads no bar of the test period unless asked, and a second look is refused without `--holdout-again`), the experiment registry (`reports/experiments.jsonl`, trials counted), the ablation command, the written report and the decision gate (`pnpm research backtest:run` and `backtest:ablate`; details in `02` section 15.1). **Decision gate** | Deterministic and look-ahead free; first written report that shows the three execution cost scenarios A, B and C of `02` section 15; the gate needs a positive net expectancy in B and C too |
| B29 Auth and security | Login, sessions, throttling, optional TOTP, headers | Security tests: no registration route, cookie flags, CSRF, throttling, revocation |
| B30 API and stream | All endpoints of `04_API_and_Notifications.md`, SSE | Contract, SSE and replay tests |
| B31 Deployment | Delivered in two steps. **B31a (record-only stack, built):** the image (`deploy/Dockerfile`, one image for the worker, the migrations and the backup jobs), the compose stack (`db`, `migrate`, `worker`; the jobs `backup` and `drill` in the profile `ops`), the `.env` template (`deploy/env.example`), `vm-setup.sh` (hardening, Docker, time, secrets, timers), `deploy.sh` and `smoke.sh`, the nightly backup (`vmgs_backup` role, migration `0005`; `pg_dump` without tick data, age, rclone, pruning 7/4/3, manifest, heartbeat `backup`), the monthly restore drill, the Healthchecks.io heartbeat of the worker (`apps/worker/src/ops`), the DuckDNS updater, the failure drills (`drill.sh`), the runbook `deploy/README.md`. **B31b (when B30 and U5 exist):** the `api` service, `caddy` in the stack (the `Caddyfile` and its compose entry are ready and checked), the smoke test on the public URL. | B31a: image, migrations, backup, restore drill (also failing on a damaged file and a wrong manifest) and the three failure drills (crash the worker, stop the database, block the feed) run on a PC with Docker; unit tests of the retention plan, the manifest check, the pinger and the commands; integration tests of the provisioning and of the backup role. Still to do on the VM: the `arm64` build, `vm-setup.sh`, the Oracle bucket, the heartbeats and the certificate (the steps of `deploy/README.md` section 2). B31b: smoke test on the public URL |
| B32 Forward paper test | Continuous run, weekly review reports, drift monitoring | Strategy status changes only by the rules in `02_Signal_Engine.md` section 15 |

### UI track

| Phase | Scope | Exit criteria |
|---|---|---|
| U0 Design system and shell | Mantine theme, app shell, routing, typed mock data layer, login screen | e2e: login flow, navigation, `SIMULATED` badge, axe clean. **Owner sees the look and feel** |
| U1 Dashboard | Status bar, chart with overlays (EMA, levels, trendlines, zones, patterns), open-signal cards, why panel, evidence, wait reasons, all states | e2e scenarios E2 to E6 and E15 on mock data. Owner review |
| U2 History and Detail | Filters, table, signal detail with timeline, result and review | e2e E7 to E9. Owner review |
| U3 Analytics | KPIs, monthly table, equity, breakdowns, failure analysis, group effectiveness, calibration, drift | e2e E10. Owner review |
| U4 News and System | News page, health, storage, strategies, alert and advisory switches, security | e2e E11 to E14. Owner review |
| U5 Live wiring | Switch each screen from mock data to the real API and SSE, one screen at a time (after B30), against the replay stack | The same e2e scenarios pass on the replay stack; contract tests |
| U6 PWA and Web Push | Manifest, service worker, push subscription | e2e E17; manual device test |

Suggested order: B0, B1, U0 (so the UI is visible early), B2, B3, U1, then B4 to B10 with U2 to U4 interleaved, then B11 onward. The tracks only meet at U5.

### Later (not scheduled)

L1 trade journal (`/took S-0042 4017.45` records the owner's own fill so slippage between the signal and the real broker can be measured), L2 MT5 quote reference for broker parity, L3 optional LLM wording, L4 calibrated probability model after several hundred forward trades.

Parallel start: the Oracle VM and the Telegram bot (owner tasks below) should be created while B0 to B10 are built. As soon as the VM exists and B12 is done, the record-only worker is deployed so that real ticks, spreads and calendar data accumulate from that day.

### Decision gate after B28

**Result of the first report (2026-10-25, [reports/backtest-20261025-173635.md](../reports/backtest-20261025-173635.md)): `NO_EDGE`, because every strategy is `INSUFFICIENT`.** On 2022 to 2024 (the test period untouched; the split was changed afterwards to train 2022-2024, validation 2025, test 2026, before any later bar was read) the five strategies with their default config made only 28 signals in three years, so there is no strategy with 30 trades and nothing can be said about an edge either way (reasons and numbers in `02` section 15.1). The choices are those that follow. If no strategy shows a positive net expectancy after costs on out-of-sample data, I report this plainly with the numbers. We then decide together: revise strategies as new versions (re-testing from scratch), or keep running forward tests only to collect evidence. UI and deployment work does not hide a failing edge.

**Yield study (train years only, [reports/yield-study-20261025.md](../reports/yield-study-20261025.md)).** The owner asked for 7 to 15 signals a day. Loosening the gates gives more trades but not a better result (67, 101 and 187 trades in three years, -0.12 to -0.18 R each). Trees over 36 price and indicator features, tested on held-out years, lose -0.04 R per trade at 5m, 15m and 1h entries (zero cost: about 0 R); about 1,440 fixed-rule settings (session ranges, previous-day levels, hour of day) give one fragile candidate (fade of the first break of the 12:00-12:30 UTC range, summer months only, about +0.09 R, 0.9 a day) and nothing that reaches 7 signals a day. So the number of signals is not a quantity to be set: from price alone, more signals means more losing trades. VALIDATION (2025) and TEST (2026) were not read in this study.

## 2. What I do and what only the owner can do

I write and test all code, migrations, Docker and Caddy files, deploy and backup scripts, GitHub Actions workflows, message templates, UI and e2e tests, runbooks, and I run local commands on the owner's PC. I give exact step-by-step instructions for everything below.

Only the owner can:

| Task | Needed by | Notes |
|---|---|---|
| Create a private GitHub repository | B0 | Free. Used for CI and for the VM to pull code. |
| Create the Oracle Cloud account and the VM (A1 Flex, 2 OCPU, 12 GB, Ubuntu aarch64) | Start early, needed for B12 recording | Sign-up may need a card for identity verification. If "out of capacity", retry another availability domain later. Paying is not required. In the VCN security list open 22 only to your own address, and 80 and 443. |
| Create the Telegram bot with @BotFather | B24 | Takes a couple of minutes. The token goes only into `.env` (never in git, never in a chat). Steps: in Telegram open @BotFather, send `/newbot`, give a name and a username that ends in `bot`, copy the token it answers with. |
| Create a DuckDNS name | B31 | Free; login with Google or GitHub. Put the VM's public IP in it and copy the token (the updater timer keeps the address current). |
| Create a free Healthchecks.io account with three checks (`worker`: period 1 minute, grace 5 minutes; `backup`: period 1 day, grace 3 hours; `drill`: period 31 days, grace 1 day), each with a Telegram or email alert | B31 | Free Hobbyist plan; the three ping URLs go into the VM `.env`. |
| Create an Object Storage bucket (private, 20 GB free) and a Customer Secret Key for its S3-compatible API | B31 | For the nightly backup; the access key and secret go into `secrets/rclone.conf` on the VM (`deploy/README.md`). |
| Make an age key pair on your own PC (`age-keygen -o vmgs-backup.key`) | B31 | The public key goes into `BACKUP_AGE_RECIPIENT`; the private file stays offline and opens the backups if the VM is lost. |
| Start Docker Desktop (the engine was not running on 2026-10-23) | B2 | Needed for the Testcontainers database tests. |
| Download HistData XAUUSD M1 files (and, if you want real spreads, the tick files of the same months) | B27 | Steps below ("HistData download and import"); the import tool is `pnpm research`. An MT5 export from the broker is not supported. |
| Review the Telegram message format | End of B24 | Run `pnpm cli telegram:preview` (needs only the bot token in `.env`), press START in the bot, and read the clearly labelled sample messages on the phone. `pnpm cli telegram:preview hinglish` for Hinglish. |
| Review each UI screen | U0 to U4 (on mock data first), again at U5 | Using the preview and later the simulated stack on the local machine. |
| Go or no-go on switching on live alerts | B32 | |

**HistData download and import (B27).**

1. Open `https://www.histdata.com/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/xauusd`. Every past year is one zip and the current year has one zip per month. For the warm-up of the engine one recent month is enough (it needs 25 days of hourly candles); for the backtest of B28 take the years from 2022 on. Tick files (`.../ascii/tick-data-quotes/xauusd`) are optional: they have the real bid and ask, so the spreads are real. Do not mix M1 and tick files in one import.
2. Put the downloaded zips, as they are, in a folder `data/histdata/` of the repository (`data/` is ignored by git; nothing is unpacked by hand).
3. Check them without touching the database: `pnpm research histdata:check data/histdata` (run it in the root folder of the repository). It lists what is wrong, if anything: the rows that were dropped as duplicates (a few hundred in a year is normal: the hour of the clock change and the forming minutes; see `02` section 2.1), the lines that were refused (the first ten with their line numbers), the longest holes and the coverage. A `WARNING` about a hole of days means a month is missing: download it and give it to the same command.
4. See what the import would do: `pnpm research histdata:import --dry-run data/histdata` (needs `DATABASE_URL_WORKER` in `.env` and a migrated database).
5. Import: `pnpm research histdata:import data/histdata`. It is safe to repeat. Give **all** the files of one import in one command. The result tells whether the history is enough for the warm-up and warns when too much time lies between its end and the first live candle: then add a newer month and import again.
6. `pnpm research spread:model` shows the spread by hour that the worker has recorded so far; run the import again after a few weeks of live data to take a better one.

No one can remove trading risk. Signals are decision support, executed manually.


## 3. Configuration

Static environment (root-owned `.env`, mode 600, never in git; the template with every variable is `deploy/env.example`):

```text
PUBLIC_HOST            vmgs-yourname.duckdns.org
POSTGRES_PASSWORD      schema owner (read only when the database is created; only the migrate step holds it)
DB_PASSWORD_WORKER     password of the role vmgs_worker  (DATABASE_URL_WORKER is built from it by compose)
DB_PASSWORD_BACKUP     password of the role vmgs_backup  (DATABASE_URL_BACKUP)
DB_PASSWORD_API        password of the role vmgs_api (set when the api is deployed; DATABASE_URL_API)
FEED_PROVIDER          biquote
FEED_SYMBOLS           XAUUSD,DXY,XAGUSD
TELEGRAM_BOT_TOKEN     from BotFather
VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
APP_ENCRYPTION_KEY     32 random bytes (TOTP secret encryption)
HEALTHCHECKS_PING_URL / HEALTHCHECKS_BACKUP_URL / HEALTHCHECKS_DRILL_URL    the three checks
BACKUP_AGE_RECIPIENT   age public key (the private key is kept offline by the owner)
BACKUP_RCLONE_REMOTE   remote:bucket/path, a section of secrets/rclone.conf
DUCKDNS_DOMAIN / DUCKDNS_TOKEN
```

Every password is `openssl rand -hex 24`: letters and digits only, because they go into URLs. The files `secrets/rclone.conf` (the bucket's keys) and `secrets/drill.key` (see below) are in a directory of mode 700 next to the `.env`.

Runtime settings live in `app_settings` and are editable on the System page: display time zone, language, alert switches and minimum grade, strategy enable flags. Strategy parameters are not runtime settings: they live in immutable strategy versions.

The B12 `pnpm worker:start` executable currently requires `FEED_PROVIDER=biquote`; `replay` remains available to deterministic tests but is not wired into the recorder runtime yet. The shared environment schema still permits `replay` for later replay-stack use. `pnpm worker:soak` runs a deterministic 10-minute simulation entirely in memory, so it does not need PostgreSQL or Docker. The PostgreSQL integration suite (`pnpm test:int`) requires Docker Desktop.

## 4. Deployment and operations

Topology: `docker compose` (`deploy/docker-compose.yml`, always called through `deploy/scripts/compose.sh`) with `db`, `migrate` (one run before the worker), `worker`, and later `api` and `caddy` (B31b). The jobs `backup` and `drill` run on demand (profile `ops`, started by systemd timers). Only Caddy publishes ports (80 and 443); the database publishes none. Containers use `restart: unless-stopped` and Docker log rotation (3 files of 10 MB); the application containers run as a non-root user with a read-only root file system, no capabilities and `no-new-privileges`. One image (`deploy/Dockerfile`, Node 24 on Alpine with `pg_dump` 17, `age` and `rclone`) serves the worker, the migrations and the backup jobs; it runs the TypeScript with `tsx`, as in development.

Database roles: the `migrate` step is the only process that holds the schema owner's URL. It applies the migrations and gives each application role its login password from the `.env` (`pnpm cli db:migrate`; the migrations create the roles without a login, so no secret lives in git). Roles: `vmgs_worker`, `vmgs_api`, and `vmgs_backup` (migration `0005`: reads everything for `pg_dump`, writes only its own heartbeat).

Deploy (run on the VM, over SSH: `sudo deploy/scripts/deploy.sh [--ref TAG]`; the first time with `--first`):

1. Take a database backup (not on the first deploy).
2. `git fetch` and check out the release tag.
3. Build the image (the A1 VM builds `linux/arm64` natively).
4. Check the environment (`pnpm cli env:check`: names the variable and the rule of a problem, never the value).
5. Run migrations (forward only; the backup in step 1 is the rollback path).
6. `docker compose up -d`.
7. Smoke test (`deploy/scripts/smoke.sh`): database healthy, migrations applied, worker running with a fresh heartbeat, ticks arriving while the market is open, no published port on the database or the worker; with `--telegram` one test message; with `--public` (B31b) `/health/ready` on the public URL.

Rollback: `deploy.sh --ref PREVIOUS_TAG`. The older code refuses a database that is newer than itself, so when a migration ran in between, restore the pre-deploy backup first (`deploy/README.md`, "Restore").

VM hardening (`deploy/scripts/vm-setup.sh`, run once): security updates now and automatically (no automatic reboot), `chrony` and UTC, Docker with log rotation, SSH by key only without root login (only when the owner's key is already there, so it cannot lock the owner out), the secrets directory (mode 700). The cloud firewall is the perimeter: 22 only from the owner's address, 80 and 443 public, no published database port.

Backups and restore drill:

- Nightly (03:30 UTC, `vmgs-backup.timer`) `pg_dump` (custom format, without the data of the tick partitions) in one stream into `age` and `rclone` to OCI Object Storage (20 GB free); the upload gets its final name only when the whole stream has gone through. The backup is encrypted to two recipients: the owner's offline key (the only way to open it if the VM is lost) and the **drill key** of the VM (`secrets/drill.key`), so that the drill can open it without the owner's key. Next to each dump goes a manifest with the row counts of a few tables taken just before the dump. Pruning keeps the newest backup of each of the last 7 days, 4 weeks and 3 months that have one (days and weeks with no backup do not count, so an outage never deletes the only backups). The job writes the heartbeat `backup` (read by the daily digest and the System page: "OK" up to 36 hours).
- The owner downloads a copy to their own PC from time to time.
- Monthly (the 3rd, `vmgs-restore-drill.timer`) `restore-drill.sh` restores the newest backup into a scratch database and compares it with its manifest and with the live database: the append-only tables (signals, signal events, outcomes, strategy versions, schema migrations) must hold at least what the manifest says and at most what the live database holds now, and `candles` must not be empty. The scratch database is dropped in any case. The backup job and the drill each ping their own Healthchecks.io check (`/fail` on a failure, and a missed run alerts after the grace time), which alerts the owner by Telegram or email; the drill does not need a bot of its own.
- Failure drills (`deploy/scripts/drill.sh`): crash the worker (SIGKILL; Docker restarts it), stop the database (the worker stops and Docker starts it again until the database is back), block the feed (the worker stays up, opens a feed incident, closes it when ticks return). Each passes only when a heartbeat and a tick written after the failure are seen.

External check: the worker sends a heartbeat to Healthchecks.io (free Hobbyist plan) every minute (`HEALTHCHECKS_PING_URL`) while its own database heartbeat is fresh, and `/fail` when it is stale; Healthchecks.io alerts the owner by Telegram or email when the pings stop. The recorder writes its database heartbeat every 15 seconds. A scheduled GitHub Actions job was rejected because one run every 10 minutes would likely exceed the 2,000 free monthly minutes of a private repository.

Oracle idle-reclaim awareness: the System page shows CPU, memory and network use. If the VM sits close to the thresholds that Oracle documents for idle instances, we review sizing or consider the owner's own always-on machine. Upgrading the Oracle account to pay-as-you-go keeps Always Free resources free per Oracle's documentation but needs a card and a budget alert; that is the owner's choice and not part of the plan.

## 5. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Biquote changes or stops | No data, no signals | Provider interface, recorded history, stale-feed gate, alert; replacement adapter is a contained task |
| Biquote prices differ from the owner's broker | Entry and stop slightly off | `maxValidEntry`, spread gate, paper-test labelling, later optional MT5 reference |
| No tradable edge after costs | Signals lose money | Honest evidence display, decision gate after B28, forward test before trust, drift detection |
| Real-money trading legality and broker risk (offshore CFD broker, very high leverage) | Legal, tax and capital loss | Paper trading on a demo account first; independent legal and tax advice before any real money; this system only produces signals and never touches funds (see `01_HLD.md` section 14) |
| Overfitting to history | Fake confidence | Time splits, untouched holdout behind a flag, experiment registry with trial counts, feature ablation |
| Oracle capacity or reclaim | Downtime | Retry creation, utilisation monitoring, portable Docker stack, restore drill |
| Telegram delivery delay or outage | Late or missed alert | Outbox retry, entry-alert expiry, dashboard and Web Push as second channel |
| Disk or DB growth | Free tier exhausted | Retention jobs, size guard with automatic tightening, storage page |
| Intrabar ambiguity in backtests | Over-optimistic results | Stop wins ties, ambiguity flagged and counted |
| Secrets leak | Account misuse | `.env` mode 600, no secrets in git or the web bundle, token never logged, owner-chat allow-list |
| Headline feeds delayed, down, or their terms change | News context late or missing | Detection delay is shown, outage banner, configurable source list, headline and link only, "possible cause" wording |
| Free-feed latency about 1 s | Slightly stale fills | Closed-candle decisions on 5m, so 1 s is immaterial for the strategy; shown in latency stats |

## 6. Definition of done for V1

1. All phase gates passed with tests green in CI.
2. Telegram messages reviewed and accepted by the owner (entry, TP1, results, review, news, system, monthly).
3. Dashboard, History, Detail, Analytics, News and System screens pass their e2e scenarios and the owner's visual review.
4. Monthly table and failure analysis show real recorded data, with sample sizes and intervals.
5. Retention verified by test; storage page shows the budget; restore drill passed.
6. VM deployed behind HTTPS with the Healthchecks.io heartbeat active.
7. Forward paper test running; every alert labelled with the strategy status.
8. No fabricated number anywhere in code, UI or messages.

## 7. After V1 (not scheduled)

Optional LLM wording on top of the deterministic explanation (advisory), MT5 quote reference for broker parity, calibrated probability model after several hundred forward trades, additional strategies through the same research gate.
