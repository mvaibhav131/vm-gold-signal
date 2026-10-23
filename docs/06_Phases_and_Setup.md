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
| B12 Recorder (record-only worker) | Batched tick and candle persistence, back-fill, gap flags, heartbeat | Local soak run with measured drops and gaps. Ready to deploy early (see parallel start) |
| B13 Regime and context | Regime classifier, news-shock flag, session and macro proximity inputs | Fixture tests per regime |
| B14 Gates and advisory flags | Blocking gates, advisory flags and their owner switches | One test per gate and per flag; flags never block unless switched |
| B15 Strategy A | Trend pullback | Positive and negative fixtures; no-look-ahead |
| B16 Strategy B | Liquidity sweep reversal | Same |
| B17 Strategy C | Squeeze breakout and retest | Same |
| B18 Strategy D | Trendline break and retest | Same |
| B19 Strategy E | Chart pattern breakout | Same |
| B20 Scoring, risk, fills | Quality score, risk, exit profiles, fill and outcome model | R accounting for every exit path; ties resolved against the trade |
| B21 Explanation and messages | Explanation builder, Telegram and Web Push formatters (English, plus Hinglish labels) | Golden tests; every required field present; length limits |
| B22 Review and statistics | Failure attribution rules, Wilson interval, expectancy, profit factor, drawdown, bucket fallback | One test per cause code; statistics checked against known samples |
| B23 Lifecycle | Signal transaction, `signal_state`, outcome tracker (many open signals), restart recovery | Integration tests on Postgres incl. kill and restart mid-trade |
| B24 Alerts | Outbox, thin Telegram client on native fetch (sendMessage, getUpdates long polling, `retry_after`), commands, link flow, Web Push sender | Fake Telegram server: idempotency, expiry, retry, rate limit, owner-only |
| B25a Calendar | Calendar poller, news state, archive, advisory news flag | Tests with recorded API samples; `UNKNOWN` state on outage |
| B25b Headlines and market moves | RSS and Biquote news pollers (conditional requests, backoff), classifier, relevance filter and clustering, impact measurement per topic, `NEWS_HEADLINE` and `MARKET_MOVE` alerts, headline context in signals and reviews | Classification golden tests per topic; duplicate clustering; move-detection fixtures; recorded feed samples; HTML entities such as &#39; decoded; outage banner; no causal wording without "possible cause" |
| B26 Rollups and maintenance | Bucket, monthly, evidence-group and failure rollups with nightly reconciliation; retention jobs; size guard | Rollups equal a full recomputation; retention test (seed 30 days, prune, history intact) |
| B27 Research data | HistData importer (zip via fflate; fixed UTC-5 to UTC; M1 bars are bid-only while tick files carry bid and ask, so ticks are preferred if available for XAUUSD), spread model from recorded ticks | Import checks, gap report |
| B28 Backtester | Replay on `core`, costs, walk-forward splits, experiment registry, holdout guard, ablation CLI, report. **Decision gate** | Deterministic and look-ahead free; first written report |
| B29 Auth and security | Login, sessions, throttling, optional TOTP, headers | Security tests: no registration route, cookie flags, CSRF, throttling, revocation |
| B30 API and stream | All endpoints of `04_API_and_Notifications.md`, SSE | Contract, SSE and replay tests |
| B31 Deployment | Compose stack, Caddyfile, DuckDNS update, deploy script, VM hardening, backups, restore drill, external health check | Smoke test on the public URL; restore drill; failure drills (kill worker, stop DB, block the feed) |
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

If no strategy shows a positive net expectancy after costs on out-of-sample data, I report this plainly with the numbers. We then decide together: revise strategies as new versions (re-testing from scratch), or keep running forward tests only to collect evidence. UI and deployment work does not hide a failing edge.

## 2. What I do and what only the owner can do

I write and test all code, migrations, Docker and Caddy files, deploy and backup scripts, GitHub Actions workflows, message templates, UI and e2e tests, runbooks, and I run local commands on the owner's PC. I give exact step-by-step instructions for everything below.

Only the owner can:

| Task | Needed by | Notes |
|---|---|---|
| Create a private GitHub repository | B0 | Free. Used for CI and for the VM to pull code. |
| Create the Oracle Cloud account and the VM (A1 Flex, 2 OCPU, 12 GB, Ubuntu aarch64) | Start early, needed for B12 recording | Sign-up may need a card for identity verification. If "out of capacity", retry another availability domain later. Paying is not required. |
| Create the Telegram bot with @BotFather | B24 | Takes a couple of minutes. The token goes only into the VM `.env`. |
| Create a DuckDNS name | B31 | Free; login with Google or GitHub. |
| Create a free Healthchecks.io account with one check (heartbeat URL and a Telegram or email alert) | B31 | Free Hobbyist plan; the heartbeat URL goes into the VM `.env`. |
| Start Docker Desktop (the engine was not running on 2026-10-23) | B2 | Needed for the Testcontainers database tests. |
| Download HistData XAUUSD M1 monthly files (and optionally an MT5 history export from the broker) | B27 | I provide the exact steps and the import tool. |
| Review the Telegram message format | End of B24 | You receive a clearly labelled sample message. |
| Review each UI screen | U0 to U4 (on mock data first), again at U5 | Using the preview and later the simulated stack on the local machine. |
| Go or no-go on switching on live alerts | B32 | |

No one can remove trading risk. Signals are decision support, executed manually.

## 3. Configuration

Static environment (root-owned `.env`, mode 600, never in git):

```text
PUBLIC_HOST            vmgs-yourname.duckdns.org
DATABASE_URL_API       postgres role vmgs_api
DATABASE_URL_WORKER    postgres role vmgs_worker
FEED_PROVIDER          biquote | replay
FEED_SYMBOLS           XAUUSD,DXY,XAGUSD
TELEGRAM_BOT_TOKEN     from BotFather
VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
APP_ENCRYPTION_KEY     32 random bytes (TOTP secret encryption)
BACKUP_AGE_RECIPIENT   age public key (the private key is kept offline by the owner)
BACKUP_RCLONE_REMOTE   OCI Object Storage remote name
```

Runtime settings live in `app_settings` and are editable on the System page: display time zone, language, alert switches and minimum grade, strategy enable flags. Strategy parameters are not runtime settings: they live in immutable strategy versions.

## 4. Deployment and operations

Topology: `docker compose` with `caddy`, `api`, `worker`, `db`. Only Caddy publishes ports 80 and 443. Containers use `restart: unless-stopped` and Docker log rotation (3 files of 10 MB).

Deploy (run on the VM, over SSH):

1. Take a database backup.
2. `git pull` the release tag.
3. Build images (the A1 VM builds `linux/arm64` natively) or pull images built by CI.
4. Run migrations (forward only; the backup in step 1 is the rollback path).
5. `docker compose up -d`.
6. Smoke test: `/health/ready`, a login check, feed state, one test Telegram message.

Rollback: check out the previous tag, restore the pre-deploy backup only if a migration must be undone, `docker compose up -d`.

VM hardening: SSH keys only and limited to the owner's IP in the cloud firewall, automatic security updates, `chrony` for time sync, firewall allows 22 (restricted), 80 and 443 only, no published database port.

Backups and restore drill:

- Nightly `pg_dump` excluding tick partitions, compressed and encrypted with `age`, uploaded with `rclone` to OCI Object Storage (20 GB free). Keep 7 daily, 4 weekly, 3 monthly.
- The owner downloads a copy to their own PC from time to time.
- Monthly `restore-drill.sh` restores the newest backup into a scratch database and compares row counts and the schema version. A failed drill sends a Telegram alert.

External check: the worker sends a heartbeat to Healthchecks.io (free Hobbyist plan) every minute and Healthchecks.io alerts the owner by Telegram or email when the pings stop. This is how a dead VM or a stuck worker is noticed. A scheduled GitHub Actions job was rejected because one run every 10 minutes would likely exceed the 2,000 free monthly minutes of a private repository.

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
