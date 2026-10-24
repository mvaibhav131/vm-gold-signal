# API, Realtime Stream and Notifications

Contracts live as Zod schemas in `packages/contracts` and are shared by `apps/api` and `apps/web`. Tests validate every response against them.

## 1. Conventions

- Base path `/api/v1`. JSON only. Timestamps are ISO 8601 UTC. The UI converts to the owner's display time zone (default `Asia/Kolkata`).
- Prices are JSON numbers with at most 3 decimals. R values are numbers with 2 decimals.
- Every route except `GET /health/live`, `GET /health/ready` and `POST /auth/login` requires the session cookie. Unauthenticated calls return `401`. Authentication failure never falls back to open access.
- State-changing requests (`POST`, `PATCH`, `DELETE`) also require `Origin` equal to the site origin and the header `X-VMGS-CSRF: 1`.
- Errors use RFC 9457 `application/problem+json`: `{ type, title, status, code, detail }`. `code` is a stable machine value such as `rate_limited` or `snapshot_pruned`.
- Lists use cursor pagination: `limit` (default 50, max 200), `cursor`; the response has `items` and `nextCursor`.
- All authenticated responses carry `Cache-Control: no-store`.
- No endpoint can create, edit or delete a signal, an event or an outcome. Those are written only by the worker.

## 2. REST endpoints

### Auth

| Method and path | Purpose |
|---|---|
| `POST /auth/login` `{username, password, totp?}` | `204` and sets the session cookie. Generic `401` on any failure. `429` when throttled. |
| `POST /auth/logout` | Revokes the current session. |
| `GET /auth/me` | `{username, totpEnabled, sessionExpiresAt}` |
| `POST /auth/password` `{current, next}` | Changes the password and revokes all other sessions. |
| `POST /auth/totp/setup`, `/enable`, `/disable` | Optional second factor (behind a feature flag). |
| `GET /auth/sessions`, `DELETE /auth/sessions/:id` | List and revoke sessions. |

There is no registration route. A test asserts that it does not exist.

### Market and engine

| Path | Returns |
|---|---|
| `GET /market/snapshot` | `{symbol, bid, ask, mid, spread, sourceAt, receivedAt, ageMs, feedState, session, regime, mode, engine}` where `feedState` is `LIVE`, `STALE`, `DISCONNECTED`, `MARKET_CLOSED` or `WARMING_UP`, `mode` is `LIVE` or `SIMULATED`, and `engine` is `{status: RUNNING or PAUSED, pausedSince?, openCount, openRiskR, warmup: {ready, progressPct}, waitReasons: [{code, label}], evaluatedAt}` |
| `GET /market/candles?tf=5m&limit=500&before=ISO&overlays=ema20,ema50,ema200,supertrend&objects=trendlines,zones,patterns,fib` | `{candles: [{t,o,h,l,c}], overlays: {name: [number or null]}, levels: [{key,label,price}], objects: [{id,type,tf,points:[{t,price}],meta}]}` (PDH, PDL, session highs and lows, round numbers). Overlays are computed with `packages/core`, so the chart and the engine agree. |
| `POST /engine/pause` `{minutes?}`, `POST /engine/resume` | Owner pause or resume. Data recording continues while paused. |

### Signals

| Path | Returns |
|---|---|
| `GET /signals/open` | All open signals (there can be several), each with live fields (`status`, current price, unrealised R, MFE, MAE, current stop, time to time stop), plus `openCount` and total `openRiskR`. |
| `GET /signals?from&to&result&strategy&side&session&regime&cause&grade&limit&cursor` | Rows of `signal_history_v`. |
| `GET /signals/:id` | `{signal, state, events[], outcome|null, autopsy|null, snapshotAvailable}`. `signal` includes `explanation` and `evidence` exactly as created. |
| `GET /signals/:id/snapshot` | Full feature snapshot, or `404 snapshot_pruned` after the retention window. |

### Analytics (computed from `signal_outcomes` and the rollup tables, cached for 30 s)

| Path | Returns |
|---|---|
| `GET /analytics/overview?from&to&strategy&scope=FORWARD|BACKTEST_OOS` | `generated, resolvedValid, wins, partials, losses, timeExits, cancelled, dataInvalid, winRate, ci95, netR, expectancyR, profitFactor, maxDrawdownR, avgDurationS, tp1Rate, tp2Rate, currentStreak` |
| `GET /analytics/monthly?months=12&strategy` | One row per month: `generated, resolvedValid, wins, partials, losses, timeExits, cancelled, dataInvalid, winRate, netR, profitFactor` |
| `GET /analytics/breakdown?by=strategy|side|session|regime|volatility|news|grade` | Rows with `n, winRate, ci95, expectancyR, profitFactor` and a `lowSample` flag. |
| `GET /analytics/failures?from&to` | Failure causes: `code, category, n, share, sumR` and the ranking of weak groups at entry. |
| `GET /analytics/groups?strategy` | Win rate by evidence group and state (the "which indicator group was right" view). |
| `GET /analytics/score-calibration` | Quality-score bands against realised win rate with `n`. |
| `GET /analytics/equity?from&to` | Cumulative net R points. |
| `GET /analytics/drift` | Rolling 50-trade win rate against the strategy's evidence interval, with status. |
| `GET /analytics/news-impact` | Per topic and impact level: `n`, share of headlines after which gold moved 1 ATR or more within 10 minutes with its interval, average absolute move in ATR, baseline share, lift over baseline, `lowSample`. |

"Properly tracked" in the UI and in reports means `resolvedValid`: signals with a valid result that count in statistics (excludes `CANCELLED` and `DATA_INVALID`, which are always shown separately).

### Strategies, news, system, settings

| Path | Purpose |
|---|---|
| `GET /strategies`, `PATCH /strategies/:key` `{enabled, alerts}` | Status (`FORWARD_TESTING` and so on), version, enabled, last signal, evidence. Config is read-only. |
| `GET /news/state`, `GET /news/events?from&to&importance` | `{state: CLEAR|IN_WINDOW|UNKNOWN, next, last, sourceAgeS}` and calendar events with actual, forecast, previous, revised previous. |
| `GET /news/headlines?from&to&minImpact&topic&limit&cursor` | Clustered headlines: `{id, title, sources[], publishedAt, firstSeenAt, delayS, topics[], impact, url, goldMoveSincePublish: {usd, atr}}` and per-source health. |
| `GET /news/moves?from&to` | Detected market moves with `{detectedAt, kind, windowS, moveUsd, moveAtr, spread, headlines[]}`; the headline list is the frozen copy. |
| `GET /system/health` | Feed age, ticks per second, worker heartbeat, event-loop lag, DB reachability, Telegram last send and last error, clock skew, last backup, last maintenance. |
| `GET /system/storage` | DB size, per-table sizes, retention rules, budget percentage, last maintenance run. |
| `GET /system/latency` | p50 and p95 for feed lag, candle-to-signal, DB commit, notification dispatch. |
| `GET /settings`, `PATCH /settings` | `{displayTz, locale: en|hinglish, alerts: {telegram: {enabled, minGrade, kinds[]}, webpush: {enabled, minGrade}}, advisoryGates: {newsWindow, rollover, offHours, nearLevel: warn or block}, strategyAlerts: {<key>: on or off}, newsAlerts: {minImpact, topics: {<topic>: on or off}, marketMoves: on or off}}`. |
| `POST /notifications/test` `{channel}` | Queues a clearly labelled test message. |
| `POST /push/subscribe`, `DELETE /push/subscribe` | Web Push subscription management. |

### Health

- `GET /health/live`: process is up. Public, no details.
- `GET /health/ready`: DB reachable, migrations at the expected version, worker heartbeat younger than 60 s. Public, returns only `ok` or `not_ready`. Used by deploy smoke tests. The uptime alert is a heartbeat from the worker to Healthchecks.io, not a call to this endpoint.

## 3. Realtime stream (SSE)

`GET /stream` (authenticated). Headers: `Content-Type: text/event-stream`, `Cache-Control: no-store`, `X-Accel-Buffering: no`. Caddy proxies it with response buffering disabled. A comment line `: hb` is sent every 15 s.

| Event | Payload | Rate |
|---|---|---|
| `quote` | `{bid, ask, spread, ageMs, feedState}` | at most 1 per second |
| `signal` | `{id}`; the client fetches the canonical row | on creation |
| `signal_update` | `{id, status, unrealisedR, stop}` | on state change and at most once per 5 s while open |
| `engine` | `{status, waitReasons, regime, session}` | on change |
| `news` | `{state, next, headline?}` | on change and on each new HIGH-impact headline |
| `health` | compact health map | on change and every 30 s |
| `resync` | `{}` | sent when `Last-Event-ID` is unknown or too old; the client reloads state over REST |

Event ids are `<bootId>:<n>`. The API keeps the last 200 non-quote events in memory for `Last-Event-ID` replay. After an API restart the first reconnect receives `resync`. Quotes are never replayed.

## 4. Telegram

### Setup and security

1. The owner creates a bot with @BotFather and puts `TELEGRAM_BOT_TOKEN` in the VM `.env`.
2. `pnpm cli telegram:link` prints a one-time code valid for 10 minutes.
3. The owner sends `/link <code>` to the bot. The worker stores the chat id in `app_settings`. From then on only that chat is served; all other chats are ignored silently.
4. The worker uses long polling (`getUpdates`), so no inbound port is needed. Messages are sent with `sendMessage` using HTML parse mode, with all dynamic text escaped.

### Commands (owner chat only)

| Command | Reply |
|---|---|
| `/status` | Feed state, engine state (running, paused, warming up), market session, regime, next high-impact event, strategy statuses |
| `/open` | All open signals with live R and the total open risk, or "no open signal" with the current wait reasons |
| `/last` | The last closed signal with its result and review |
| `/today` | Today's signals, results and net R |
| `/month` | The monthly summary (same content as section 4.4) |
| `/pause`, `/resume` | Pause or resume new signals |
| `/help` | Command list |

### Delivery rules

- Every message is written to `notification_outbox` inside the same transaction as the event that causes it, and is sent only after commit. `UNIQUE(event_key, channel)` prevents duplicates.
- A single sender loop with a 1 message per second limit. Priority: `SIGNAL_NEW`, then `SIGNAL_TP1` and `SIGNAL_CLOSED`, then everything else.
- Retry with backoff 2 s, 5 s, 15 s, 45 s, 2 min, then every 5 min until `expires_at`. `429` honours `retry_after`.
- `expires_at`: `SIGNAL_NEW` = entry validity (3 min; a late entry alert is dropped as `EXPIRED`), `SIGNAL_TP1` and `SIGNAL_CLOSED` = 6 h (results are still useful late), calendar news = event time, headlines and market moves = 30 min, system = 1 h.
- Length: stay under 3500 characters. If the text is too long, research-only lines are dropped first, then low-value facts. Levels, stop, targets and the evidence line are never trimmed.
- Every message of a paper strategy starts with `FORWARD-TEST (paper)`, replay data with `SIMULATED`.
- Locale: `en` (default) or `hinglish`. The templates are fixed dictionaries (labels only; numbers and levels are identical). Tests assert that both locales contain every required field.
- Delivery audit: created, attempts, sent time, provider message id, last error. The System page shows the last send and the last error.

### 4.1 Message catalogue

Examples show the `en` locale. Times are in the display time zone.

**SIGNAL_NEW**: defined in `02_Signal_Engine.md` section 14. It always contains: direction, strategy and version, id, paper-test label, entry and do-not-chase level, stop with distance, TP1 and TP2 with R and the partial-exit instruction, validity, quality score and grade, the full "why" list (one line per evidence group with the actual indicator values), weak and research-only items, macro state, advisory warnings, open signals with total open risk, historical evidence with sample size and interval, and the statement that this is a historical frequency and not a guarantee.

**SIGNAL_TP1**
```text
TP1 HIT #S-0042  +1.0R on 50%
Price 4023.84 at 11:49 IST (6 min after entry).
ACTION: close half, move stop to entry 4017.37.
Runner target TP2 4030.31. Time stop 13:40 IST.
```

**SIGNAL_CLOSED, win**
```text
WIN #S-0042  +1.47R net  (TP2 4030.31 at 12:20 IST, 37 min)
Max favourable +2.1R, max adverse -0.4R.
What worked: trend and structure stayed STRONG until the target; no news event in the trade.
```

**SIGNAL_CLOSED, partial win**
```text
PARTIAL WIN #S-0042  +0.46R net  (TP1 hit, then stopped at entry 12:05 IST)
Review (preliminary): 15m CHoCH at 4019.80 (12:01 IST) after TP1, so the runner was stopped at entry.
The trade is still a win because TP1 paid +0.5R.
```

**SIGNAL_CLOSED, loss**: defined in `02_Signal_Engine.md` section 14. It shows the result and net R, the exit, the primary cause with its category (Setup failure, Market event, Execution, Data), supporting causes with numbers, the evidence groups that were weak at entry, and a note that the final review follows.

**SIGNAL_CLOSED, time exit**
```text
TIME EXIT #S-0043  -0.18R net  (120 min, price 4015.40)
Cause: TIME_DECAY, best move in favour +0.5R. No stop or target was reached.
```

**SIGNAL_CANCELLED**
```text
CANCELLED #S-0044 (not counted in win rate)
Reason: market data went stale for 40 s during the 3 minute entry window.
If you already entered, manage the trade manually.
```

**SIGNAL_REVIEW_FINAL** (only when the final cause differs from the preliminary one, or counterfactual data is new)
```text
FINAL REVIEW #S-0042
Cause updated: STOP_HUNT_REVERSAL. Price reached TP1 4023.84 seven 5m candles after the stop.
The idea was right but the stop sat inside the liquidity sweep. Tracked in Analytics (n=9 this month).
```

**NEWS_UPCOMING**
```text
HIGH-IMPACT USD EVENT in 30 min: CPI m/m (18:00 IST)
Forecast 0.3  Previous 0.4.  Signals are still sent, but from 17:15 IST until volatility normalises after 18:20 IST they carry a NEWS WINDOW warning.
```

**NEWS_RELEASED**
```text
CPI m/m released 18:00 IST: actual 0.5, forecast 0.3, previous 0.4 (surprise +2.1 sigma).
Gold 15 s after: -3.1 USD, spread 0.9. Signals in this window carry a NEWS WINDOW warning until spread and ATR normalise.
```

**NEWS_HEADLINE** (HIGH-impact cluster; minimum impact and topics are owner settings)
```text
HEADLINE (HIGH) | Geopolitics, Trump policy
"Trump announces new tariffs on ..."
Seen in: BBC, CNBC. Published 21:42 IST, detected 21:44 IST (2 min later).
Gold since publication: +3.8 USD (0.9 x ATR 5m), spread 0.21.
Topic history: HIGH geopolitics headlines moved gold by 1 ATR or more in 38% of cases (n=52, normal 14%). Example numbers; below n=30 this line says "not enough data yet".
Link: https://...
This is context, not a signal. Whether the headline caused the move is not known.
```

**MARKET_MOVE**
```text
GOLD SPIKE UP +9.8 USD in 4 min (2.8 x ATR 5m), spread 0.35 at 21:47 IST.
Possible causes, not confirmed (headlines in the previous 30 min, by impact):
1. HIGH  "Missile strike reported near ..." (BBC, 21:31 IST)
2. MED   "Treasury yields fall as ..." (CNBC, 21:40 IST)
3. (unclassified, timing only) "..." (Al Jazeera, 21:44 IST)
If no headline matched, this line reads: No matching headline found in the free feeds. The move may be technical, flow-driven, or the news may not be in these feeds yet.
Open signals: #S-0046 BUY (+1.4R).
```

**SYSTEM_DEGRADED / SYSTEM_RECOVERED**
```text
FEED STALE since 14:02 IST (no tick for 18 s). New signals are blocked. Open trade #S-0045 cannot be tracked.
```
```text
FEED RECOVERED 14:07 IST. Gap back-filled. New signals resume after 12 five-minute candles of warm-up (about 15:07 IST).
```

**ENGINE_PAUSED** (only when the owner pauses; the system never pauses itself)
```text
ENGINE PAUSED by you at 22:10 IST. New signals are not sent. Data recording and tracking of open signals continue. /resume to continue.
```

**STORAGE_WARNING**
```text
STORAGE 82% of the 20 GB budget. Tick retention shortened to 3 days. Largest table: ticks (9.4 GB).
```

**DAILY_DIGEST** (end of the trading day)
```text
DAY SUMMARY 23 Oct: 3 signals, 2 valid results: 1 win +1.47R, 1 loss -1.04R. 1 still open.
Top weak group today: Trigger and momentum.
```

### 4.2 Monthly report (sent at the start of each month, also available with `/month` and in Analytics)

Example numbers are illustrative.

```text
MONTHLY REPORT October 2026 (FORWARD-TEST)
Signals generated: 41
Properly tracked (valid results): 39   Cancelled: 1   Data invalid: 1
Results: win 14, partial win 6, loss 15, time exit 4 (1 positive, 3 negative)
Win rate 53.8% (21 of 39)  95% CI 38-68%   Net +7.9R   Expectancy +0.20R   PF 1.48   Max drawdown -4.8R
By strategy: Trend Pullback 24 (54%), Sweep Reversal 11 (45%), Squeeze Retest 4 (n too small)
Top failure causes: NORMAL_LOSS 6, HTF_STRUCTURE_BREAK 3, NEWS_SHOCK 2, NO_FOLLOW_THROUGH 2, STOP_HUNT_REVERSAL 2
Best session: London 58% (n=19). Worst: Asia 33% (n=9, low sample)
Score check: quality 75+ won 61% (n=18); 65-74 won 43% (n=21)
Data: feed uptime 99.2%, 3 incidents. Storage: DB 1.1 GB. Last backup OK.
```

A win means net R above zero after costs. Time exits count as wins or losses by the sign of net R.

## 5. Web Push

- Payload: title `BUY XAUUSD #S-0042 (Strong 78)`, body `Entry 4017.37, stop 4010.90, TP1 4023.84, TP2 4030.31`, click opens `/signals/<id>`.
- TTL 180 s for `SIGNAL_NEW` (same validity as the entry), urgency high. Results use TTL 6 h.
- VAPID keys live in `.env`. The service worker handles push and notification click only; it does not cache API responses.
- iPhone and iPad need the PWA installed to the home screen before Web Push works. Telegram is the reliable primary channel.

## 6. Outbox event keys

```text
signal:<id>:confirmed   signal:<id>:tp1   signal:<id>:closed   signal:<id>:review
news:<eventId>:upcoming   news:<eventId>:released   news:<clusterId>:headline   move:<id>:spike
health:<incidentId>:degraded   health:<incidentId>:recovered
engine:<pauseId>:paused   storage:<yyyymmdd>:warning
report:daily:<yyyymmdd>   report:monthly:<yyyymm>
test:<uuid>
```

Kinds stored in `notification_outbox.kind`: `SIGNAL_NEW`, `SIGNAL_TP1`, `SIGNAL_CLOSED`, `SIGNAL_CANCELLED`, `SIGNAL_REVIEW_FINAL`, `NEWS_UPCOMING`, `NEWS_RELEASED`, `NEWS_HEADLINE`, `MARKET_MOVE`, `SYSTEM_DEGRADED`, `SYSTEM_RECOVERED`, `ENGINE_PAUSED`, `STORAGE_WARNING`, `DAILY_DIGEST`, `MONTHLY_REPORT`, `TEST`.

## 7. Tests for this document

- Contract tests: every endpoint response parses with its Zod schema; unknown fields fail the test.
- Security tests: no registration route, `401` without a cookie on every private route, cookie flags, `no-store`, `Origin` and CSRF header enforcement, login throttling, session revocation.
- SSE tests: heartbeat, ordering, replay with `Last-Event-ID`, `resync` after restart.
- Telegram tests: outbox idempotency, expiry, retry and `retry_after`, chunking and trimming order, HTML escaping, both locales contain every required field, non-owner chat is ignored.
- Formatter golden tests: fixed signals produce byte-identical messages.
- News tests: classification golden tests per topic, clustering of duplicate stories, impact thresholds, market-move detection, the "no matching headline" wording, feed outage handling, and that no message ever states a causal claim without the words "possible cause".
