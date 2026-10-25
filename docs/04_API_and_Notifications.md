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
| `POST /auth/password` `{current, next}` | Changes the password (at least 12 characters) and revokes all other sessions. |
| `POST /auth/totp/setup`, `/enable`, `/disable` | Optional second factor (behind a feature flag). `setup` answers `{secret, otpauthUrl}` (shown once). `enable` `{code}` answers `{recoveryCodes}`: eight codes of the form `xxxx-xxxx`, shown once. `disable` `{code}`. |
| `GET /auth/sessions`, `DELETE /auth/sessions/:id` | `{items: [{id, createdAt, lastSeenAt, expiresAt, current}]}`, the current session first, and revoke. Revoking the current session is a logout, so the UI offers "Log out" for it and "Revoke" for the others. |

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

`scope` (`FORWARD` by default, or `BACKTEST_OOS`) is a parameter of every endpoint that is computed from signal outcomes, so the scope switch of the Analytics page reaches every section that is about trades (the two scopes are never mixed, as for the evidence of a signal, 02 section 13). Two sections have no scope on purpose: the drift panel compares the forward trades with the evidence interval of the strategy (a backtest cannot drift), and the news impact is measured on headlines and gold moves, not on trades.

The figures of the overview, the monthly rows, the breakdowns and the equity curve are computed by `packages/core/src/stats` (definitions in `02` section 13.1): `wins` is the number of `WIN` results, while the win rate counts every counted trade with net R above zero.

| Path | Returns |
|---|---|
| `GET /analytics/overview?from&to&strategy&scope=FORWARD|BACKTEST_OOS` | `generated, resolvedValid, wins, partials, losses, timeExits, cancelled, dataInvalid, winRate, ci95, netR, expectancyR, profitFactor, maxDrawdownR, avgDurationS, tp1Rate, tp2Rate, currentStreak` |
| `GET /analytics/monthly?months=12&strategy&scope` | One row per month, oldest first, ending at the newest month that has a signal in the scope (months before the first signal are left out): `generated, resolvedValid, wins, partials, losses, timeExits, cancelled, dataInvalid, winRate, netR, profitFactor`. A month is a calendar month of the display time zone. |
| `GET /analytics/breakdown?by=strategy|side|session|regime|volatility|news|grade&from&to&strategy&scope` | Rows with `n, wins, winRate, ci95, expectancyR, profitFactor` and a `lowSample` flag, biggest `n` first. A key without a valid result is left out. `wins` counts results with net R above zero. |
| `GET /analytics/failures?from&to&scope` | Failure causes: `code, category, n, share, sumR` (the primary cause of every reviewed result, 02 section 12; `share` is of the reviewed results) and the ranking of weak groups at entry (`n` results in which the group was `WEAK` or `FAIL`, `share` of the reviewed results). |
| `GET /analytics/groups?strategy&scope` | Win rate by evidence group and state, one row per strategy, group and state that occurred (the "which indicator group was right" view). |
| `GET /analytics/score-calibration?scope` | Quality-score bands against realised win rate with `n`: 65-69, 70-74, 75-79, 80-84, 85-89 and 90-100. |
| `GET /analytics/equity?from&to&scope` | Cumulative net R points, one for each valid result, in the order they closed. |
| `GET /analytics/drift` | Rolling 50-trade win rate of the forward trades against the evidence interval of the strategy, with status. `INSUFFICIENT_DATA` below 30 trades. |
| `GET /analytics/news-impact` | Per topic and impact level: `n`, share of headlines after which gold moved 1 ATR or more within 10 minutes with its interval, average absolute move in ATR, baseline share, lift over baseline, `lowSample`. |

"Properly tracked" in the UI and in reports means `resolvedValid`: signals with a valid result that count in statistics (excludes `CANCELLED` and `DATA_INVALID`, which are always shown separately).

### Strategies, news, system, settings

| Path | Purpose |
|---|---|
| `GET /strategies`, `PATCH /strategies/:key` `{enabled, alerts}` | Status (`FORWARD_TESTING` and so on), version, enabled, last signal, evidence. `PATCH` answers with the updated entry. The `alerts` switch of a strategy and `strategyAlerts.<key>` of the settings are the same switch: changing one changes the other. |
| `GET /strategies/:key/config` | `{key, version, config}`: the config of the version in use, as JSON, for reading only (a strategy version is immutable; a change is a new version). |
| `GET /news/state`, `GET /news/events?from&to&importance` | `{state: CLEAR|IN_WINDOW|UNKNOWN, next, last, sourceAgeS}`, and calendar events, oldest first, as `{items, sourceAgeS}` (`sourceAgeS` is the age of the last successful calendar fetch). An event has `actual, forecast, previous, revisedPrevious` and, once released, `surpriseSigma` (actual minus forecast, in standard deviations of the past surprises of the same indicator) and `goldMoveAfter` `{usd, atr}` (gold's move in the 5 minutes after the scheduled time, from the recorded 1-minute candles). Both are null before the release and whenever the data to measure them is missing. `importance` limits the list to events of exactly that importance (it is not "and above"). Without `from` and `to` the list covers the 14 days before today to the 8 days after it. |
| `GET /news/headlines?from&to&minImpact&topic&limit&cursor` | Clustered headlines: `{id, title, sources[], publishedAt, firstSeenAt, delayS, topics[], impact, url, goldMoveSincePublish: {usd, atr}}`, newest first, and per-source health (`enabled`, `lastOkAt`, `lastError`). The UI says "feed unavailable" for a source that has an error, no successful poll yet or none for 10 minutes, so an empty list is never mistaken for "no news". |
| `GET /news/moves?from&to` | Detected market moves, newest first, with `{detectedAt, kind, windowS, moveUsd, moveAtr, spread, headlines[]}`; the headline list is the frozen copy. Without `from` the list covers the last 30 days. |
| `GET /system/health` | Feed age, ticks per second, worker heartbeat, event-loop lag, DB reachability, Telegram last send and last error, clock skew, last backup, last maintenance. A value that is not known is `null`. |
| `GET /system/incidents` | The last 30 feed incidents, newest first: `{id, kind, startedAt, endedAt|null, detail}`. `endedAt` is null while the incident goes on. |
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

The worker announces a changed signal with PostgreSQL `NOTIFY` on the channel `vmgs_signals` (sent inside the transaction, so it arrives only after the commit), payload `{"id": "<signal id>", "change": "created" | "state" | "closed" | "review"}`: `created` is a new signal, `state` an event such as TP1 with a new working state, `closed` the outcome, `review` the final review. The API listens, reads the canonical row and turns the notification into a `signal` or `signal_update` event. Changes of the excursions alone are not announced (the API reads `signal_state` itself at most once per 5 s while a signal is open).

## 4. Telegram

### Setup and security

1. The owner creates a bot with @BotFather and puts `TELEGRAM_BOT_TOKEN` in the VM `.env`.
2. `pnpm cli telegram:link` asks Telegram who the bot is (a wrong token is found now), then prints a one-time code of 8 digits (`1234-5678`). The database keeps only a hash of it (`app_settings.telegramLink`). The code works once, for 10 minutes, and is void after 5 wrong tries.
3. The owner sends `/link <code>` to the bot. The worker stores the chat id (`app_settings.telegramChat`) and forgets the code. From then on only that chat is served; all other chats are ignored silently. A new code from `telegram:link` moves the link to another chat.
4. The worker uses long polling (`getUpdates`), so no inbound port is needed. Messages are sent with `sendMessage` using HTML parse mode (bold, italic, `code`, quotes; see section 4.1, "The look"), with all dynamic text escaped, and without link previews.
5. `pnpm cli telegram:preview` is for the first look at the formats: it needs only the bot token (no database, no worker). The owner presses START in the bot; the command then sends one example of every message (`SIGNAL_NEW` as a BUY and as a SELL, `SIGNAL_TP1`, `SIGNAL_CLOSED` as a win and as a loss with its review, `SIGNAL_CANCELLED`, `SIGNAL_REVIEW_FINAL`, `SYSTEM_DEGRADED`, `SYSTEM_RECOVERED`, `ENGINE_PAUSED`, `NEWS_UPCOMING`, `NEWS_RELEASED`, `NEWS_HEADLINE`, `MARKET_MOVE` (with possible causes and with none), `SYSTEM_DEGRADED` and `SYSTEM_RECOVERED` for the headline feeds, `TEST`) made by the real formatters from fixed example data, each marked `[SAMPLE n/18: ..., not a real signal]`. `pnpm cli telegram:preview hinglish` sends them in Hinglish. It does not link the chat.
6. `pnpm cli telegram:test` queues a clearly labelled `TEST` message in the outbox, so the whole delivery path (outbox, sender, Telegram) can be checked. The worker must be running.

Who is answered: a private chat that is the linked one, and nobody else. Groups, other chats, plain text and anything that is not a command get no answer. The only command a stranger can send is `/link`, and the bot answers it only while a code is pending, so it does not show itself to a stranger. A command addressed to another bot (`/status@OtherBot`) is not ours.

### Commands (owner chat only)

| Command | Reply |
|---|---|
| `/status` | Feed state, engine state (running, paused, warming up), market session, regime, next high-impact event, strategy statuses |
| `/open` | All open signals with live R and the total open risk, or "no open signal" with the current wait reasons |
| `/last` | The last closed signal as it was told: the closed message and its final review, the stored Telegram texts of the latest signal that has them |
| `/today` | Today's signals, results and net R (the calendar day of the display time zone) |
| `/month` | The monthly summary (same content as section 4.4), for the calendar month of the display time zone |
| `/pause [minutes]`, `/resume` | Pause or resume new signals. `/pause` lasts until `/resume`, `/pause 30` ends by itself after 30 minutes (1 to 10080); a timed pause that has run out counts as running. The pause is written to `app_settings.engine`. The reply to `/pause` is the `ENGINE_PAUSED` message itself; the other channel gets it through the outbox under the same event key. |
| `/help`, `/start` | Command list; a short hello |

A reply is never longer than Telegram allows: long lists are cut with an "and N more" line. `/open` needs a quote no older than 2 minutes for the live R, and says so instead of guessing when there is none. Until the decision engine exists (B26b), `/status` shows the regime as "not known yet" and `/open` shows no wait reasons.

### Delivery rules

- Every message is written to `notification_outbox` inside the same transaction as the event that causes it, and is sent only after commit. `UNIQUE(event_key, channel)` prevents duplicates. For the messages about a signal the row already holds the finished message, written in the language and the time zone of the settings of that moment: `payload` is `{text, level, dropped}` for Telegram and `{title, body, url, ttlSec, urgency, tag}` for Web Push, and the sender delivers it as it is. A signal's messages go only to the channels that were told about its entry (`02` section 11.1).
- A single sender loop with a 1 message per second limit. Priority: `SIGNAL_NEW`, then `SIGNAL_TP1` and `SIGNAL_CLOSED`, then everything else.
- Retry with backoff 2 s, 5 s, 15 s, 45 s, 2 min, then every 5 min until `expires_at`. `429` honours `retry_after`.
- `expires_at`: `SIGNAL_NEW` = entry validity (3 min; a late entry alert is dropped as `EXPIRED`), `SIGNAL_TP1` and `SIGNAL_CLOSED` = 6 h (results are still useful late), calendar news = event time, headlines and market moves = 30 min, system = 1 h.
- Length: stay under 3500 characters. If the text is too long, research-only lines are dropped first, then low-value facts. Levels, stop, targets and the evidence line are never trimmed.
- Every message of a paper strategy starts with `FORWARD-TEST (paper)`, replay data with `SIMULATED`.
- Locale: `en` (default) or `hinglish`. The templates are fixed dictionaries (labels only; numbers and levels are identical). Tests assert that both locales contain every required field.
- Delivery audit: created, attempts, sent time, provider message id, last error. The System page shows the last send and the last error.

### Delivery details (as built in B24)

- **One sender, one rate limit.** `OutboxSender` runs on its own loop (it polls every 500 ms and can be woken). It claims one row at a time with `FOR UPDATE SKIP LOCKED`, most important first and oldest first within a priority, so two senders never take the same row. All Telegram traffic, the sender's and the bot's replies, goes through one `TelegramTransport`: at least 1 s between two messages, and a `429` closes it for `retry_after` for everybody.
- **What a failure means.** `400` is `DEAD` (the message itself is refused, never retried). `429` waits at least `retry_after`. `401`, `403`, `5xx`, a lost connection and a timeout are retried until the message expires (the owner can fix a token or unblock the bot). The wait after attempt n is 2 s, 5 s, 15 s, 45 s, 2 min, then 5 min, or `retry_after` if that is longer. A message whose next try would come after its expiry becomes `EXPIRED`. An expired message is never sent, so a late entry alert cannot reach the owner. A row without `expires_at` lives 1 hour from creation.
- **Crash safety.** A row is `SENDING` from the claim until its result is written. A row left `SENDING` for 120 s (the process died) is retried, so a message is delivered at least once: after a crash at the worst moment the owner may see it twice, never zero times. The result of every send is one statement.
- **No chat yet.** Telegram rows wait, as `FAILED`, until a chat is linked or they expire. Without `TELEGRAM_BOT_TOKEN` the channel is not served at all.
- **Web Push.** Sent with the `web-push` library behind the `WebPushSink` interface; VAPID keys per call. The TTL is the smaller of the payload TTL and the time the row has left; a row with less than a second left is `EXPIRED`. The `Topic` header is a hash of the tag, so a newer message for the same signal replaces an older one on the device. A row is `SENT` when at least one browser took it. A `404` or `410` removes that subscription. An incomplete payload is `DEAD`; no subscribed browser means the row waits.
- **System messages.** `ENGINE_PAUSED` (above), `SYSTEM_DEGRADED` and `SYSTEM_RECOVERED`, `STORAGE_WARNING` and `TEST` are built in `packages/core/src/alerts/system.ts`, expire after 1 hour and carry no signal id. The health watcher reads `feed_incidents` of the kinds `DISCONNECT` and `STALE` (the recorder writes an incident only after its grace time) every 5 s: an open incident is told once, with the numbers of the open signals that cannot be followed; the recovery is told only for an incident that was announced, and only if it ended in the last 10 minutes. Event keys carry the kind and the start of the incident, so a restart cannot tell it twice. `STORAGE_WARNING` is queued by the maintenance job (B31), whose message exists already.

### Calendar alerts and the calendar feed (as built in B25a)

- **The feed.** `CalendarPoller` reads Biquote's `GET /api/Calendar` (free, no key) for the United States (`countries=US`, currency USD, every importance) into `macro_events` (`source = 'biquote'`, `source_event_id` = the id of the release). The first reading goes back 14 days, every later one from 3 days back to 8 days ahead, every 5 minutes; from 1 minute before an event with an exact time, of a watched impact and without a value, until the value arrives (at most 10 minutes after the time), every 15 seconds. After a failed reading it waits 30 s, 1 min, 2 min, then 5 min. The id of the series, `digits`, `timeMode`, the type, the revision count and the surprise are kept in `raw`. Holidays (importance `none`) are not stored. A list in which no row can be read counts as a failed reading (the format changed), not as "no events". A released value is never taken back by a later reading, and `actual_first_seen_at` is set once.
- **Available or not.** The time of the last good reading is the heartbeat `calendar` (`worker_heartbeats`). The calendar is available while that is at most 15 minutes old. Otherwise the news state is `UNKNOWN`, never `CLEAR`, and `/status` says `Next HIGH-impact event: unknown (the calendar feed is unavailable)` instead of "none known".
- **NEWS_UPCOMING** is queued when an event with an exact time is 30 minutes or less ahead, and is valid until the event (a late alert is worthless). It goes out for the currencies of the news window of the strategies (USD) and at least `settings.newsAlerts.minImpact` (default HIGH). An event with a tentative time or only a date is stored and shown but never counted down to, because its time may move. The window line is there only when the event opens a news window (the impact and the currency of `gates.newsWindow`).
- **NEWS_RELEASED** is queued when the released value was first seen, at the earliest 20 s after the scheduled time so that the second at which gold is measured is stored, and is valid for 30 minutes. It is not sent for a value first seen more than 30 minutes after its time (a backfill, or a worker that was down: that is old news). `Gold 15 s after` is the move of the mid price from the last tick at the time to the last tick 15 s later (each at most 10 s old) and the spread of the later one; the line is left out when no tick is near. The surprise is told in sigma only when at least 6 past releases of the indicator have both an actual and a forecast: the history of the provider (about 90 days) joined with what the worker archived itself, each release counted once. It is also kept in `raw.surprise`. The `goldMoveAfter` of the API (5 minutes, from 1-minute candles) belongs to B30.
- **Keys and channels.** `news:<macro_events.id>:upcoming` and `news:<macro_events.id>:released`, so a restart or a second pass never tells an event twice (an event whose time moves after the alert is not told again). The channels follow the system rule (Telegram when on and the kind is switched on, Web Push when on). The Web Push text is English, with the page `/news`.

### Headline alerts, sudden moves and the headline feeds (as built in B25b)

- **Who sends what.** `NewsPoller` reads the feeds into `news_items`, `NewsAlerts` queues `NEWS_HEADLINE`, `MarketMoveDetector` queues `MARKET_MOVE`, `NewsFeedWatcher` queues the notice that the headline feeds are down or back, and `ImpactMeasurer` keeps the measured moves and rebuilds `news_topic_stats`. All run inside the worker (the rules and numbers are in `02` section 16, "As built (B25b)"). They need the database only: without a Telegram token the rows wait or expire like every other row.
- **NEWS_HEADLINE** is valid for 30 minutes and is queued once for each story: `news:<cluster id>:headline`, so a restart or a second pass never tells a story twice. It is queued when the impact is at least `settings.newsAlerts.minImpact` (default HIGH), at least one topic of the story is `on` in `settings.newsAlerts.topics`, and the story is at most 30 minutes old. The text says where gold stands since publication (the last tick at or before the published time against the latest tick, each at most 30 s old, with the ATR(5m) and the spread; "no tick could measure it" otherwise) and the history of the topic from `news_topic_stats` when it has 30 or more measured stories ("not enough data yet" otherwise). The Web Push text is English and opens `/news?tab=headlines`.
- **MARKET_MOVE** is valid for 30 minutes under `move:<market_events.id>:spike`, and only when `settings.newsAlerts.marketMoves` is `on`; the move itself is stored in `market_events` either way. It lists up to 5 classified stories (HIGH first, the newest first) and up to 3 unclassified headlines of the previous 30 minutes as possible causes, and the open signals with their result in R if they were closed now (the bid for a BUY, the ask for a SELL, from a tick at most 2 minutes old; no result without one). Without a matching headline it says "No matching headline found in the free feeds. ..."; while the headline feeds are all disabled or down it says that they are unavailable. The page is `/news?tab=moves`.
- **Headline feeds down or back.** `SYSTEM_DEGRADED` with the title `HEADLINE FEEDS DOWN` when every enabled feed has been silent for more than 10 minutes, `SYSTEM_RECOVERED` with `HEADLINE FEEDS BACK` when one is read again. The keys are `health:HEADLINES@<start of the outage in epoch ms>:degraded` and `:recovered`. These notices expire after 1 hour like the other system messages.
- **Preview.** `pnpm cli telegram:preview` sends these five messages as well (18 samples in all).

### 4.1 Message catalogue

#### The look (Telegram HTML)

Telegram has no colours, so colour comes from pictures, and the layout from a few tags. The rules, which hold for every message and both languages:

- **Colour.** BUY is 🟢 and SELL 🔴; a group of the quality score is 🟢 strong or OK, 🟡 weak, 🔴 failed, ⚪ no data; results are ✅ win, 🟡 partial win, ❌ loss, ⏱ time exit, 🚫 cancelled, ⚪ data invalid; the feed is 🟢 live, 🟡 stale, 🔴 disconnected, ⚪ closed; system messages are 🔴 feed down, 🟢 feed back, ⏸ paused, ▶️ resumed, 🧪 test. All pictures are in one table (`messages/style.ts`).
- **Bold** for the label (the first line, always), the title of a message and the result of a trade (`WIN #S-0042  +1.47R net`), the label of every level and every section title. **Italic** for the strategy line and the statement that a rate is not a guarantee.
- **Tap to copy.** Every price of the entry card (entry, stop, TP1, TP2) is a `code` span, outside bold, so that one tap copies the number into the trading platform.
- **Quotes.** The long "why" of an entry alert is one folding quote (`blockquote expandable`) at the end of the message: it shows its first lines and opens on a tap. What decides the trade (levels, validity, quality, warnings, macro, open risk, evidence) is outside it and always visible. The reasons of a review are a plain quote, so that the heuristic warning is never hidden.
- **Safety.** The pictures and tags come from the formatters only. Text from outside is escaped and has the markup markers removed. A message that Telegram would not parse is sent as plain text, and the test server of the worker refuses invalid HTML with a 400 as the real service does.

```text
FORWARD-TEST (paper) | Manual execution only.         (bold label)
🟢 BUY XAUUSD  #S-0042                                (bold)
Trend Pullback v0.1.0                                 (italic)
📊 Setup quality 95/100 (Very strong)                 (bold)

📍 Entry  4017.370  (do not chase above 4018.015)     (label bold, price copyable)
🛑 Stop  4010.900  (-6.470)
🎯 TP1  4023.840  (1.00R)  close 50%, move stop to entry
🏁 TP2  4030.310  (2.00R)  runner
⏱ Valid for 3 min (until 11:38 IST). Time stop 2 h (13:35 IST).

⚠️ Warnings: ...   🗓 Macro: ...   📰 News ...   📂 Open signals now: ...

📈 EVIDENCE (same setup type)
Win rate 58%  (n=64, 95% CI 46-69%)  Expectancy +0.31R  PF 1.50
...
This is a historical frequency, not a guarantee. 1R = 6.470 USD per oz.   (italic)

▼ WHY THIS SIGNAL   (folds: one line per group with its colour, weak, research only)
```

The examples below show the words and numbers of each message in plain text (the pictures and tags are left out for readability); the exact layout is fixed by the golden tests.

Examples show the `en` locale. Times are in the display time zone. The messages about a signal (`SIGNAL_NEW`, `SIGNAL_TP1`, `SIGNAL_CLOSED`, `SIGNAL_CANCELLED`, `SIGNAL_REVIEW_FINAL`) are written by `packages/core/src/messages`; their exact layout, the levels of detail used to stay under the length limit, and the lifetimes are in `02_Signal_Engine.md` section 14.1.

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
Forecast 0.3%  Previous 0.4%.
Signals are still sent, but from 17:15 IST until volatility normalises after 18:20 IST they carry a NEWS WINDOW warning.
```

**NEWS_RELEASED**
```text
CPI m/m released 18:00 IST
Actual 0.5%, forecast 0.3%, previous 0.4% (surprise +2.1 sigma).
Gold 15 s after: -3.100 USD, spread 0.900.
Signals in this window carry a NEWS WINDOW warning until spread and ATR normalise.
```
Figures are shown in the unit of the event (`%`, `K`, `B`) with its own number of decimals; a missing figure is `-`; a revised previous value is added as `(revised 0.5%)`. The surprise, the gold line and the window line are left out when they cannot be measured.

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
```text
HEADLINE FEEDS DOWN since 14:02 IST (no feed answered for 11 min)
Headline alerts and the news line of new signals are unavailable. The price feed, the calendar and open signals are not affected.
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
health:<kind>@<startMs>:degraded   health:<kind>@<startMs>:recovered      (kind: STALE, DISCONNECT or HEADLINES; the start of the incident in epoch ms)
engine:<pauseId>:paused   storage:<yyyymmdd>:warning                      (pauseId: the epoch ms at which the pause began)
report:daily:<yyyymmdd>   report:monthly:<yyyymm>
test:<uuid>
```

Kinds stored in `notification_outbox.kind`: `SIGNAL_NEW`, `SIGNAL_TP1`, `SIGNAL_CLOSED`, `SIGNAL_CANCELLED`, `SIGNAL_REVIEW_FINAL`, `NEWS_UPCOMING`, `NEWS_RELEASED`, `NEWS_HEADLINE`, `MARKET_MOVE`, `SYSTEM_DEGRADED`, `SYSTEM_RECOVERED`, `ENGINE_PAUSED`, `STORAGE_WARNING`, `DAILY_DIGEST`, `MONTHLY_REPORT`, `TEST`.

## 7. Tests for this document

- Contract tests: every endpoint response parses with its Zod schema; unknown fields fail the test.
- Security tests: no registration route, `401` without a cookie on every private route, cookie flags, `no-store`, `Origin` and CSRF header enforcement, login throttling, session revocation.
- SSE tests: heartbeat, ordering, replay with `Last-Event-ID`, `resync` after restart.
- Telegram tests: outbox idempotency, expiry, retry and `retry_after`, chunking and trimming order, HTML escaping, both locales contain every required field, non-owner chat is ignored. They run against a fake Telegram server (`apps/worker/src/testing/fakeTelegram.ts`, a real local HTTP server) and, for the database parts, against PostgreSQL.
- Formatter golden tests: fixed signals produce byte-identical messages.
- News tests: classification golden tests per topic, clustering of duplicate stories, impact thresholds, market-move detection, the "no matching headline" wording, feed outage handling, and that no message ever states a causal claim without the words "possible cause".
