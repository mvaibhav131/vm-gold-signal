# UI Specification (Mantine 9, desktop and mobile)

The UI is a private single-user dashboard. Priorities: (1) is the data fresh, (2) is there a signal and why, (3) how did past signals do and why did they fail.

## 1. Principles

- Dark theme by default, gold accent for brand only. Green and red only for direction and result, amber for warnings, grey for market closed.
- Mobile first for the signal view. The same signal card, reasons and evidence appear on mobile and desktop.
- Every number comes from the API. Nothing is hard-coded. Placeholder data is never shown as live: replay data shows a permanent `SIMULATED` badge.
- Honest wording: "Historical setup win rate", "Sample", "95% CI", "Paper test". Never "guaranteed", "sure", "AI probability".
- Times are shown in the display time zone (default IST) with UTC in a tooltip.
- Prices and spreads are shown with 3 decimals, as they are stored (owner decision, 2026-10-23); R values with 2. The wireframes below use shorter numbers for readability.
- Accessibility: semantic landmarks, labelled controls, keyboard navigation, no information by colour alone (every status has text), contrast checked by automated axe tests.
- Stack: React 19, Vite, Mantine 9 (`core`, `hooks`, `form`, `notifications`, `dates`, `charts`), `mantine-datatable`, TanStack Query, `react-router`, `lightweight-charts`, `vite-plugin-pwa`. No Tailwind.
- Performance: the initial route (Dashboard) stays under 400 KB gzip (JS plus CSS). A full eager build of the planned libraries measured 458 KB JS plus 44 KB CSS, so Analytics, the data table and the charts are lazy-loaded. A CI script fails the build if the budget is exceeded.
- Chart library licence: `lightweight-charts` is Apache-2.0 and requires the TradingView attribution it shows by default. The attribution stays visible and its NOTICE file is kept in the repository.

## 2. Routes and navigation

| Route | Screen | Notes |
|---|---|---|
| `/login` | Login | Username, password, optional TOTP step. No sign-up or forgot-password link. Generic error text. |
| `/` | Dashboard | Default after login |
| `/signals` | Signal history | Filters and table |
| `/signals/:id` | Signal detail | Why, timeline, result, review |
| `/analytics` | Analytics | Monthly, breakdowns, failures, calibration |
| `/news` | News and macro | Calendar and news-risk state |
| `/system` | System and settings | Health, storage, strategies, alerts, security |

Desktop: left navigation rail, global status bar on top. Mobile: bottom tab bar (Dashboard, Signals, Analytics, News, System) and a compact status strip.

## 3. Global status bar

Always visible on every screen.

| Item | Source | Values |
|---|---|---|
| Price | `quote` event | bid, ask, mid |
| Spread | `quote` | USD |
| Freshness | `quote.ageMs`, `feedState` | `FRESH 0.4 s` (green), `STALE` (red), `DISCONNECTED` (red), `MARKET CLOSED` (grey), `WARMING UP n%` (amber) |
| Session | snapshot | ASIA, LONDON, NEW YORK, OVERLAP, ROLLOVER |
| Regime | snapshot | TREND UP, TREND DOWN, RANGE, SQUEEZE, BREAKOUT, HIGH VOL, NEWS SHOCK, UNCERTAIN |
| Engine | snapshot | RUNNING, PAUSED (until time), WARMING UP |
| Mode | snapshot | `LIVE` or `SIMULATED` (permanent badge) |
| Strategy status | `/strategies` | `FORWARD-TEST` badge while no strategy is `VALIDATED` |

## 4. Dashboard

Desktop (1440 px):

```text
+--------------------------------------------------------------------------------------------------+
| XAUUSD 4017.28 | bid 4017.20 ask 4017.37 | spread 0.17 | FRESH 0.4s | LONDON | TREND UP | RUNNING | FORWARD-TEST |
+------------------------------------------------------+-------------------------------------------+
| [1m] [5m] [15m] [1h] [4h]   overlays: EMA VWAP LEVELS | OPEN SIGNALS (2): #S-0042  #S-0043       |
|                                                      | BUY  #S-0042   Strong 78   Trend Pullback |
|   candlestick chart                                  | Entry 4017.37  (max 4017.55)              |
|   - EMA 20/50/200, levels, trendlines, zones         | Stop 4010.90   TP1 4023.84   TP2 4030.31  |
|   - signal markers: entry, stop, TP1, TP2            | Live +0.6R   MFE +0.9R   MAE -0.2R        |
|   - round-number levels                              | Status: ACTIVE   time stop in 1h 42m      |
|                                                      | WHY THIS SIGNAL  (accordion per group)    |
|                                                      |  Trend [STRONG] Structure [STRONG] ...    |
|                                                      | EVIDENCE  58%  n=64  CI 46-69%  PF 1.5    |
+------------------------------------------------------+-------------------------------------------+
| TODAY  generated 2 | open 1 | wins 1 | losses 0 | net +1.5R      MONTH  generated 14 | valid 12 | ... |
+------------------------------+-------------------------------+-----------------------------------+
| Recent signals (last 5)      | Events + top headlines        | Why no signal now (WAIT reasons)  |
+------------------------------+-------------------------------+-----------------------------------+
```

Mobile (390 px), single column in this order: status strip, open-signal cards or wait card (levels and live R, newest first), why-this-signal (collapsed by group), evidence, mini chart (collapsed by default), today and month counters, next event.

States of the signal card:

| State | Presentation |
|---|---|
| `WARMING_UP` | Progress bar with which timeframes are missing. No signals are possible. |
| `WAIT` | "No signal" with reason chips in plain language from `engine.waitReasons` (for example "Spread too high: 0.9 USD", "News window: CPI in 22 min", "Regime: range, no strategy accepts it"). |
| `ACTIVE` / `TP1_HIT` | Levels, live R, stop (shows break-even after TP1), countdown to time stop, why and evidence. |
| `DATA_STALE` / `DISCONNECTED` | Red banner across the page. Signal card shows that an open trade cannot be tracked. |
| `MARKET_CLOSED` | Grey state, last price with its timestamp. |
| `PAUSED` | Amber, paused by the owner, with a Resume button. The system never pauses itself. |

Several signals can be open at once. The right column then shows one card per open signal (newest first) and, above the cards, the number of open signals and the total open risk in R. A signal that opposes an open one carries the chip `OPPOSES #S-0042`; other advisory warnings (news window, rollover, off hours, near level) appear as chips on the card.

"Why this signal" renders `explanation.groups`: one row per evidence group (Trend, Structure, Trigger and momentum, Volatility, Execution, Session and macro, Reward feasibility) with a state chip (`STRONG`, `OK`, `WEAK`, `FAIL`, `NA`) and the actual indicator values behind it. A separate "Weak" list and a "Research only (not used)" list follow.

## 5. Signal detail (`/signals/:id`)

Sections, top to bottom:

1. Header: id, side, strategy and version, status badge of the strategy, mode, generated time.
2. Levels: entry, max valid entry, stop, TP1, TP2, risk in USD, exit profile, expiry and time stop.
3. Result block (after close): result badge, net R, exit price and reason, duration, MFE and MAE, TP1 and TP2 reached, `ambiguous` flag if set, cost in R.
4. Timeline: `signal_events` in order (created, alert queued, TP1, stop moved, exit, review preliminary, review final).
5. Chart around the trade: 5m candles from 60 candles before to 60 after, with entry, stop, targets and exit markers.
6. Why this signal: the stored explanation, exactly as sent to Telegram.
7. Evidence at creation: win rate, n, interval, expectancy, PF, scope (forward or backtest), match level and the bucket used.
8. Review (failure attribution): status chip (`PRELIMINARY` or `FINAL`), primary cause with a category chip (Setup failure, Market event, Execution, Data), supporting causes with their numbers, weak groups at entry, counterfactual (did price later reach TP1 or TP2 and after how many candles). A fixed note: "Heuristic attribution; judge strategy by the statistics in Analytics."
9. Raw feature snapshot (collapsed JSON). If it was pruned, show "Snapshot removed by retention; summary above is kept."

## 6. Signal history (`/signals`) and Analytics (`/analytics`)

### 6.1 History

Filters: date range, result, strategy, side, session, regime, failure cause, grade. Table (`mantine-datatable`, cursor pagination, sortable columns):

| Column | Content |
|---|---|
| Time | generated time (display zone) |
| # | `S-0042`, link to detail |
| Strategy | key and version |
| Side | BUY / SELL badge |
| Grade | score and grade |
| Entry / Stop / TP1 / TP2 | levels |
| Result | badge: Win, Partial win, Loss, Time exit, Cancelled, Data invalid, Open |
| Net R | signed |
| Duration | |
| Cause | primary failure cause with category (blank for clean wins) |
| Evidence | win rate and n shown at creation |

Summary strip above the table for the current filter: signals, valid results, win rate with interval, net R, profit factor.

### 6.2 Analytics

A scope switch (Forward paper, Backtest out-of-sample) applies to every block of the page except the drift panel (always forward results) and the news impact (measured on headlines).

1. KPI cards: generated, properly tracked (valid results), win rate with 95% interval and sample size, net R, expectancy, profit factor, max drawdown, TP1 and TP2 hit rates.
2. **Monthly table** (last 12 months): generated, properly tracked, wins, partial wins, losses, time exits, cancelled, data invalid, win rate, net R, profit factor. This answers "how many signals came each month and how many were proper".
3. Equity curve in R (cumulative net R) with drawdown shading.
4. Breakdown tabs: strategy, side, session, regime, volatility bucket, news condition, grade. Each row shows n, win rate, interval, expectancy and a low-sample marker.
5. Failure analysis: causes ranked by count and R lost, coloured by category, plus "weak groups at entry" ranking.
6. Evidence-group effectiveness: for each group, win rate when it was STRONG or OK compared with WEAK or FAIL. This is the indicator-level view.
7. Score calibration: quality-score bands against realised win rate.
8. Drift panel: rolling 50-trade win rate against the strategy's evidence interval, strategy status and any pause.
9. News impact: per topic, how often headlines were followed by a gold move of 1 ATR or more within 10 minutes, compared with ordinary windows, with sample sizes.

Rules: a percentage is shown only when n >= 30; below that the raw counts and "Insufficient evidence" are shown. n between 30 and 99 carries a "Low sample" label.

## 7. News and macro (`/news`)

Tabs: Calendar, Headlines, Market moves.

- News-risk state: `CLEAR`, `IN_WINDOW` (with the window) or `UNKNOWN` (feed unavailable). "No relevant event" and "calendar feed unavailable" look different. The state only warns; it never blocks a signal unless the owner switched that flag to block.
- Calendar: upcoming events with countdown, importance, forecast and previous; past events with actual, forecast, previous, revised previous and the surprise, plus gold's measured move after the release (from recorded candles); age of the last successful calendar fetch.
- Headlines: clustered stories, newest first. Each row shows an impact chip, topic chips, the headline, all outlets that ran it, the published time, the detection delay (for example "seen 2 min after publishing"), gold's move since publication, and a link out. Filters: minimum impact and topic. A banner appears when a feed is down, so "no headlines" is never confused with "feed unavailable".
- Market moves: detected spikes (time, size in USD and ATR, spread) with the "possible causes" headlines frozen at detection time, or "No matching headline found in the free feeds".
- Wording always says "possible cause". The UI never states that a headline caused a move.

## 8. System and settings (`/system`)

Tabs:

| Tab | Content |
|---|---|
| Health | Feed state and age, ticks per second, worker heartbeat, event-loop lag, DB, Telegram last send and last error, clock skew, feed incidents (last 30), latency p50 and p95 |
| Storage | DB size and per-table sizes, budget gauge, retention rules (read-only), last maintenance run, last backup |
| Strategies | Per strategy: version, status badge, enable switch, read-only config view, last signal, evidence |
| Alerts | Telegram on or off, minimum grade, event kinds, "Send test message", Web Push subscribe and test, message language (English or Hinglish), advisory flags (warn or block), per-strategy alert switch, headline alert level, topic switches, market-move alerts |
| Display | Time zone, number format |
| Security | Change password, TOTP setup, active sessions with revoke |

Risky actions (pause engine, disable a strategy, revoke sessions) use a confirmation dialog.

## 9. E2E and UI testing (no screenshots)

### 9.1 Principles

- Playwright with Chromium. Configuration forces `screenshot: 'off'`, `video: 'off'`, `trace: 'off'`. Tests never compare images and never take screenshots.
- Assertions use the DOM and accessibility tree only: roles, labels, text, attributes, counts, URLs and network responses. Locators prefer `getByRole` and `getByLabel`; `data-testid` is used where no accessible name exists.
- Automated accessibility checks with `@axe-core/playwright` (computed from the DOM, no image capture).
- The owner does the visual review. Tests give the owner a reliable, working UI to look at; they do not judge looks.

### 9.2 Test environment

- A deterministic stack started by one command (`pnpm e2e:serve`): Postgres (Testcontainers or `docker-compose.e2e.yml`), `api`, `worker` with `FEED=replay` and a virtual clock, web build served statically.
- The database is seeded with fixed data over three months: wins, partial wins, losses with every failure cause, time exits, a cancelled signal, a data-invalid signal, one pruned snapshot, and a live replay that produces one new signal on schedule.
- Replay mode shows the `SIMULATED` badge; a test asserts it is present, and that `LIVE` mode never shows it.
- `pnpm e2e:serve` also lets the owner open the same simulated stack in a browser and inspect it by eye.

### 9.3 `data-testid` contract (stable names)

| Area | Test ids |
|---|---|
| Status bar | `status-price`, `status-spread`, `status-freshness`, `status-session`, `status-regime`, `status-engine`, `status-mode`, `status-strategy` |
| Signal cards (one per open signal) | `open-signals`, `open-risk`, `signal-card-<seq>`, `signal-warning-<code>`, `signal-side`, `signal-id`, `signal-grade`, `signal-entry`, `signal-stop`, `signal-tp1`, `signal-tp2`, `signal-live-r`, `signal-state`, `signal-why-group-<key>`, `signal-evidence`, `wait-reasons` |
| History | `history-table`, `history-row-<seq>`, `history-filter-<name>`, `history-summary` |
| Detail | `detail-result`, `detail-timeline`, `detail-autopsy`, `detail-autopsy-cause`, `detail-autopsy-category`, `detail-evidence`, `detail-snapshot` |
| Analytics | `kpi-<name>`, `monthly-table`, `monthly-row-<yyyy-mm>`, `breakdown-<by>`, `failure-causes`, `group-effectiveness`, `calibration`, `equity-curve`, `drift-panel`, `news-impact`, `scope-switch` |
| News | `news-state`, `news-upcoming`, `news-past`, `news-headlines`, `headline-<id>`, `headline-feed-banner`, `news-moves`, `move-<id>` |
| System | `health-feed`, `health-telegram`, `storage-db-size`, `storage-retention`, `strategy-row-<key>`, `alerts-telegram-switch`, `alerts-test-button` |

### 9.4 Scenarios

| # | Scenario | Checks |
|---|---|---|
| E1 | Login | Wrong password shows the generic error. Correct login lands on the Dashboard. Logout returns to `/login`. Direct visit to a private route redirects to `/login`. No sign-up link exists. |
| E2 | Status bar | Price, spread, freshness, session, regime, engine, mode badges present with text. `SIMULATED` visible in replay. |
| E3 | Stale feed | Replay a gap: red banner, `DATA_STALE` in the signal card, engine shows blocked; recovery clears it. |
| E4 | WAIT reasons | A known fixture shows the exact reason chips from the API. |
| E5 | Open signals | Replay creates a signal and then an overlapping opposing one: two cards, the opposing card shows the OPPOSES chip, open risk is the sum; each card's fields equal the API values, every evidence group row is present with state chip and values, evidence block shows n and interval, SSE update changes live R without reload. |
| E6 | Insufficient evidence | A signal with n < 30 shows raw counts and "Insufficient evidence", never a percentage. |
| E7 | History | Filters by result, strategy, cause and date narrow rows; sorting works; cursor pagination loads the next page; row opens detail. |
| E8 | Detail of a loss | Timeline order, result block values, autopsy primary cause and category, weak groups, counterfactual, preliminary then final status after the replay clock advances. |
| E9 | Pruned snapshot | Detail shows the retention message and the summary stays visible. |
| E10 | Analytics | Monthly table rows and KPI numbers equal the values returned by `/analytics/*`; scope switch changes every block that follows it (not the drift panel and the news impact); low-sample labels appear below n = 100; no percentage below n = 30. |
| E11 | News | `CLEAR`, `IN_WINDOW` and `UNKNOWN` render different states. Upcoming and past events match the API. Headlines list matches the API (impact, topics, outlets, delay), filters work, a downed feed shows the banner instead of an empty list, market moves show frozen headlines or the "No matching headline" text, and no text claims a headline caused a move. |
| E12 | Settings | Strategy enable switch, alert switches and language persist after reload; test message button queues a test outbox row; pause and resume update the engine state. |
| E13 | Storage | Retention rules and sizes render; budget gauge reflects the API. |
| E14 | Security | Session cookie flags, `no-store` header, private API returns `401` after logout, no registration route. |
| E15 | Responsive | At 390 x 844: bottom tab bar visible, order of sections as specified, no horizontal overflow (`scrollWidth <= clientWidth`). At 1440 x 900: navigation rail and two-column dashboard. |
| E16 | Accessibility | Zero serious or critical axe violations on every route. |
| E17 | PWA | Manifest present and valid, service worker registers, API responses are not cached. |

### 9.5 Other UI checks (no browser images)

- Contract tests: UI uses the shared Zod schemas, so an API change that breaks the UI fails type-checking.
- Bundle budget script (initial route under 400 KB gzip, JS plus CSS).
- ESLint rules for React hooks and no raw `dangerouslySetInnerHTML`. Accessibility is checked by the axe tests (the `jsx-a11y` plugin does not support ESLint 10).
- Component tests (Vitest and Testing Library) for formatters: R values, prices, time zones, sample-size labels.

### 9.6 Owner review loop

After each screen is finished I report that all tests are green and give the command to run the simulated stack. The owner checks look and feel, lists changes, and I apply them. Every requested change gets a test where it makes sense, so a fix cannot silently regress.

## 10. Visual tokens

```text
Background       #0B0F14     Surface 1  #121821     Surface 2  #18212C     Border  #263241
Text primary     #F5F7FA     Text muted #9EACBA
Gold accent      #D9A441     Positive   #25B678     Negative   #E45D5D     Warning #E0A33A    Info #5AA9E6
Font             Inter or system sans; tabular numerals for all prices and R values
```

Mantine theme: `primaryColor` gold (custom palette), dark colour scheme forced, default radius `md`, compact spacing on tables.

## 11. Early preview of the real UI

The wireframes above are only text. To let the owner see and judge the actual interface early, every screen is first built with the real Mantine components against typed mock data (U0 to U4 in `06_Phases_and_Setup.md`). Mock data lives only under `apps/web/src/mocks`, is excluded from the production bundle, and always shows the `SIMULATED` badge. The data layer is then switched to the live API and SSE one screen at a time (U5) with the same e2e scenarios. The owner runs the preview with one command and reports changes; layout and wording are adjusted before any backend wiring.

The simulated market has states the owner can switch to on the Dashboard with the "Preview state" picker (the e2e tests choose one with `?scenario=<id>` in the address): `two-open`, `open-buy`, `tp1-hit`, `wait`, `warming-up`, `stale`, `disconnected`, `market-closed`, `review-pending` and `paused`. Switching sends the same `resync` event the real stream sends. The picker, the scenarios and the simulated price (a pure function of time, so the chart, the quote and the signal levels always agree) exist only in the mock. The mock calls the real session, trading-day and candle functions of `packages/core` (B3), so those are exercised by the preview too.

Dashboard details decided while building U1: the chart is mid price on closed candles with the live price as a line from the quote stream; overlays and objects are toggled with chips; the same overlay values and levels are also written as text under the chart; on a phone the chart starts collapsed. The engine chip reads `BLOCKED: NO DATA` while the feed is stale or down. The evidence line names the bucket the numbers come from (strategy, side, session, regime and volatility, dropping one key per level, see 02_Signal_Engine section 13). The Pause button asks for confirmation and a duration; Resume is one click.

History and detail details decided while building U2:

- **The simulated history** (`apps/web/src/mocks/trades.ts`) has 43 signals: the 41 finished ones of the monthly report example in 04 section 4.2 (14 wins, 6 partial wins, 15 losses, 4 time exits, 1 cancelled, 1 data invalid; 39 valid results, 21 of them above zero) over about three months of weekdays, plus the two open ones of the default preview state. Every cause code occurs, one result is `ambiguous`, one has an insufficient sample (under 30) and the oldest has had its feature snapshot removed by retention (scenario E9). A preview state, `review-pending`, adds a loss that closed 35 minutes ago, so its review is still `PRELIMINARY` and turns `FINAL` 60 minutes after the close (scenario E8). The chart candles of every trade are generated so that they tell the same story as its result: no candle reaches TP1 before the TP1 event, TP2 before the exit of a win, or the stop before the exit of a loss.
- **History** (`/signals`): the filters, the sort and the page are in the address bar (`/signals?result=LOSS&sort=realizedRNet&order=asc`), so a filtered list can be reloaded, shared and left with the back button; a value that is not valid is ignored. Dates are calendar days of the display time zone (the end day is included); an end before the start is reported and neither is applied. The summary strip above the table describes the WHOLE filtered list, not the rows that are loaded (the API sends it with every page, 04 section 2), and follows the filters. A win rate with its interval shows from 30 valid results, with a "Low sample" label under 100 (rule C6). Signals load 20 at a time with a "Load more" button (cursor pagination). A column is sorted by the API, so it works across pages: the first click on a column sorts from the highest value, the next click reverses it. Rows without a value for the column (open and cancelled signals) come last in both directions, and equal values are ordered by signal number, newest first, so pages never repeat or skip a row. Clicking a row, or its number, opens the detail. On a phone the filters are folded into a panel and the table scrolls inside its own box.
- **Detail** (`/signals/:id`): the sections of section 5 in this order: header, levels and result next to the timeline, the chart around the trade, why this signal next to the evidence and the review, and the raw snapshot. The chart shows 5-minute candles from 60 before the signal to 60 after its exit, with the entry, stop and targets as lines, an arrow at the entry and a circle at the exit; like the dashboard chart it also has the same facts as text, and on a phone it starts collapsed. A cancelled or data-invalid signal says that it is not counted in the statistics and has no result in R. A win has no review ("A full win is not reviewed"). A review that is `PRELIMINARY` says that the final one follows 60 minutes after the close and that what price did next is not known yet; the page reloads it every 30 seconds, so the final review (with the counterfactual) appears by itself. The category of the primary cause comes from `CAUSE_CATEGORY_OF` in `packages/core` (02 section 12). The raw snapshot is only fetched when it is opened; after the retention window the page says "Snapshot removed by retention; summary above is kept." and everything else stays. An id that does not exist shows "Signal not found" with a link back to the list.
- **Contract additions** (04 section 2): `GET /signals` takes `sort` and `order` and answers with `summary` next to `items` and `nextCursor`; a cursor is valid only for the sort it was made for. The web code has `getSignalDetail` and `getSignalSnapshot` next to `getSignals`.

Analytics details decided while building U3:

- **The simulated results** (`apps/web/src/mocks/analytics.ts` and `backtest.ts`): the forward scope is the same 41 finished signals plus the open ones as the history, so the overview of the forward scope equals the summary of `/signals`. The backtest out-of-sample scope has 318 generated signals over the 12 whole calendar months of the display time zone before the month of the first forward signal: 302 valid results (trend pullback 214, sweep reversal 24, squeeze retest 64), a win rate of 54.3%, net R +34.90, a maximum drawdown of 12.52R, 11 cancelled and 5 data-invalid signals. The trend pullback and the squeeze retest results are exactly the numbers on the evidence line of their signals (n, wins, win rate, interval, expectancy, profit factor, TP rates); the sweep reversal has 24 backtest results, so no percentage. The trends in the data (a higher score wins more often, a STRONG group wins more often than a WEAK one) are built into the generator to give the screen something to show; they prove nothing about the real strategies. Intervals are Wilson intervals computed from n and wins.
- **The scope** is in the address (`/analytics?scope=BACKTEST_OOS`), so a link opens the same view; forward needs no parameter and an unknown value means forward. It applies to the key numbers, the monthly table, the equity curve, the breakdown, the failure analysis, the group view and the calibration. **Two blocks do not follow it, and the page says so:** drift is about forward results by definition (it compares them with the backtest) and news impact is measured on headlines, not on signals. This replaces the earlier wording "the scope switch changes all sections".
- **Rule C6 everywhere:** a percentage, an interval or a lift is shown only when the API sent it (30 valid results or more; for shares of the reviewed results, 30 reviewed results or more); below that the counts and the words "Insufficient evidence" are shown, and in table cells a dash with the words for screen readers. From 30 to 99 results the label "Low sample" is added. The monthly table is mostly a dash, because a month rarely has 30 valid results, and the page says that this is on purpose.
- **Key numbers:** nine cards, each exactly the number of the API. A win means net R above zero after costs (so a time exit with a profit is a win).
- **Equity curve:** a plain SVG (no chart library, to keep the page light). The x axis is the order in which the results closed, the y axis is R; the shaded area is the fall from the highest point so far. The words under the chart (now, highest, lowest, first and last result) say the same. The maximum drawdown is only in the key numbers: computing it again from the rounded points of the curve would give a number that can differ by 0.01R.
- **Breakdown:** one tab for each dimension; only the open tab is loaded. Rows are sorted by sample size, the largest first, as the API sends them. A strategy or a grade with no valid result has no row.
- **Failure analysis:** causes ranked by count, then by R lost, with the category chip; the weak-groups ranking counts a result once for every group that was WEAK or FAIL at entry. Shares need 30 reviewed results. The rule behind each cause is listed under "How each cause is decided". The block says that the attribution is a heuristic.
- **Evidence-group effectiveness:** for the chosen strategy, a matrix with every group and the four states STRONG, OK, WEAK and FAIL side by side (a column "Not applicable" only when a result had one). The states are not merged into "STRONG or OK against WEAK or FAIL": a merged win rate would need an interval that the API does not send.
- **Calibration:** six fixed bands of the quality score (65-69, 70-74, 75-79, 80-84, 85-89, 90-100). A band without a result is still listed, so the scale never changes. The block says that the score is not a probability.
- **Drift:** per strategy, the win rate of the last 50 forward results against the interval of the backtest of the same strategy, with the strategy status next to it. Below 30 results the status is "Insufficient data". A strategy with 30 results but no backtest interval is left out, because drift cannot be judged. In the preview every strategy has fewer than 30 forward results, so only that status shows; the other three (within, below and above the range) are tested on the table component.
- **News impact:** a table of topic and impact level with the headlines counted, the share followed by a move of 1 ATR or more within 10 minutes, the same share in ordinary windows and the ratio. The numbers of the preview are a fixed table, not computed from the simulated headlines. The wording says "association, not a cause"; the ordinary-window share is only shown on a row that shows its own share.
- **Contract additions** (04 section 2): every analytics endpoint except drift and news impact takes `scope` (default `FORWARD`; `LIVE` is not a statistics scope); there is a `calibration` query; `GET /analytics/overview` without `from` and `to` covers the whole scope. The web code has one `ApiClient` method for each endpoint and one query for each block, keyed by scope; the stream bridge reloads them when a signal is created or closed.
