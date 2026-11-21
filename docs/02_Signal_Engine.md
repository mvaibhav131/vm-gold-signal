# Signal Engine Specification

All parameters below are the initial hypotheses of `strategy-config v0.1.0`. They may be tuned only on the training and validation splits (section 15). Every change creates a new immutable strategy version.

## 1. What the engine does

On each closed 5-minute candle it decides one of: `SIGNAL(BUY|SELL)` or `NO_SIGNAL(reason codes)`. It uses only data available at that moment (no look-ahead). It is pure code (`packages/core`), so the live worker, the backtester and the tests run the same logic.

## 2. Data, timeframes, sessions

- Price used for indicators: mid = (bid + ask) / 2. Spread is tracked separately. Fills use bid/ask (section 9).
- Timeframes: 1m (built from ticks), 5m (entry), 15m (context), 1h (bias), 4h (macro, research), 1d. Higher timeframes are derived from closed 1m candles. Boundaries are UTC based, except the trading day.
- Trading day boundary: 17:00 `America/New_York` (DST aware). Previous-day high/low (PDH/PDL) use this boundary.
- Sessions (all computed with IANA time zones, no fixed offsets except Asia which has no DST):
  - ASIA 00:00-08:00 UTC
  - LONDON 08:00-16:30 `Europe/London`
  - NEW_YORK 08:00-17:00 `America/New_York`
  - OVERLAP is the intersection of LONDON and NEW_YORK
  - ROLLOVER 21:45-23:15 UTC (thin liquidity: an advisory warning, signals are not blocked)
- Candle build rules: source timestamp is the clock. A tick older than the open candle by more than 2 s is dropped and counted. A candle is `complete` only after its close tick arrives or the next candle opens. Gaps are never filled with fake candles.
- Warm-up: a timeframe is usable when it has at least `max(period)*3` candles (1h EMA200 needs 600 hourly candles). On a fresh install, history is bootstrapped (HistData M1 converted to mid, then Biquote OHLC for the recent gap) and marked in `candles.source`. Live signals are blocked until warm-up completes. The HistData step is built (section 2.1); the Biquote OHLC step is not.
- Volume: the feed has no real volume (always 0). Only tick count per candle exists. Volume-based indicators are therefore research-only and flagged as tick-volume approximations.

### 2.1 History bootstrap and the spread model, as built (B27)

Code: `tools/research` (`@vmgs/research`): `histdata/` (`parseBarLine`, `parseTickLine`, `histSourceOf`, `importHistData`, `gapReport`), `spread/model.ts` (`SpreadModel`), `bootstrap/` (`planBootstrap`, `PostgresBootstrapStore`), `commands.ts` and `cli.ts`. It runs as `pnpm research <command>` with `DATABASE_URL_WORKER` from `.env` (`researchEnvSchema` in `packages/config`: only that one variable, as the role `vmgs_worker`). New dependency: `fflate` 0.8.3 (reads the zips). The steps for the owner are in `06`, section "HistData download and import".

- `histdata:check <files or folders>`: reads the files and prints what is in them, with no database.
- `histdata:import [--dry-run] <files or folders>`: the same, then writes the history into `candles`; `--dry-run` writes nothing.
- `spread:model`: prints the spread model as the database gives it.

**The files.** HistData has XAUUSD as M1 bars (`DateTime;Open;High;Low;Close;Volume`, one zip per past year and one per month of the current year) and as ticks (`DateTime,Bid,Ask,Volume`, with milliseconds). The format is told by the name of the `.csv` (`_M1_` or `_T_`); one import takes one format. The time of both is fixed UTC-5 all year, so it is converted by adding 5 hours (a summer date is checked in the tests). The files are given in any order and are sorted by the name of their `.csv`; **all the months of one import should be given in one command**, because a 4h or 1d candle that spans a month boundary would be written as two partial candles by two runs (5m, 15m and 1h are aligned to the hour and are not affected).

**Checks (decisions of B27).** A line is refused, counted by reason and never repaired: `MALFORMED` (wrong number of fields), `BAD_TIME` (not a real date; a bar with seconds), `BAD_PRICE` (not a number, or outside 50 to 50,000, which catches a zero or a missing decimal point), `BAD_OHLC` (high below low, open or close outside them), `ASK_BELOW_BID`, `DUPLICATE` (see below) and, for ticks only, `OUT_OF_ORDER` (a tick for a minute that is already sealed). Prices are rounded to the 3 decimals of the tables. The report shows the rows read and taken, the count by reason, the first ten refused lines with their file and line number, the first and last minute, and how many candles of each timeframe it makes.

**What the real files showed (the files of 2022 to 2025 and of September 2026, first run of 2026-10-25).** A bar file can hold **several rows for one minute**: (a) the row of a minute that was still forming (often flat, all four prices equal) written before the finished one, together with a stale restatement of the minute before it (the September 2026 file has 374 such rows); (b) a whole hour written twice, identical, where the clocks of the source change (the last Sunday of October: 60 rows a year, in all four yearly files). The first version kept the first row of a minute and so kept the forming one. **The row with the widest range (high minus low) is kept** (a forming minute always lies inside the finished one); on a tie the first stays; the others are counted as `DUPLICATE`, and the examples show them in UTC with their file and line. Minutes are sorted after reading, so a row that comes behind a later minute is put in its place and counted as `reordered`. A test holds the pattern of the real file, and after the fix no flat minute was left in the September file.

**Mid prices.** Tick files carry the bid and the ask: the mid and the spread are the real ones, and the candles come from the same `CandleBuilder` as the live worker's (a test holds them equal). M1 files are **bid only**: the spread model is added to every bid price (half of it up, in thousandths) to get the mid, and these candles carry no spread (`spread_avg` and `spread_max` are null, `tick_count` is 0). The spread percentile and the 24h spread baseline therefore become known only after 30 live candles; the history does not feed them.

**The spread model.** The median and the 90th percentile of the spread by UTC hour of the day, from the `spread_avg` of the live 5m candles of the last 90 days (ticks are kept for 14 days at most; the candles built from them stay). An hour needs 30 candles of its own; otherwise it takes the median of the hours that have any; with nothing recorded the default of 0.20 USD holds (twice that for the wide value). It turns the bid into a mid now, and B28 will take the spread of its quotes from it.

**What is written.** The 5m, 15m, 1h, 4h and 1d candles, `complete = true`, `source = histdata_bootstrap`; no 1m candles. Only candles that are over before the first live 1m candle are written (the live recorder owns every minute it recorded), and the insert is `ON CONFLICT DO NOTHING`: an import can be repeated and never touches an existing candle, live or earlier history. The higher timeframes are built from the minutes that exist, as the live builder does; a missing minute is never filled.

**Gap report.** A hole in the minutes is a `WEEKEND` (Friday 17:00 to Sunday 17:00 New York, and at most 84 hours: `makeGap` of the candle builder calls any hole that contains a weekend a weekend, which hid a missing eight months in the first run), a `DAILY_BREAK` (at most 90 minutes inside 21:00 to 23:30 UTC, the break around 17:00 New York) or `FEED` (anything else). The report counts them, lists the ten longest `FEED` holes, and gives the coverage (minutes present over present plus missing `FEED` minutes; the missing minutes are those of an open market, a weekend inside a long hole is not counted). A hole of more than five days of open market is printed as a `WARNING` with its dates: it is a missing month, and the indicators would see it as one jump. A holiday (Christmas, New Year) is shorter than that and is listed without a warning. The import also prints whether the history has what the warm-up needs (900 candles of 5m, 1440 of 15m, 600 of 1h) and a warning when more than 24 hours of open market lie between the end of the history and the first live candle: the indicators would see that hole as one jump. HistData publishes a month after it ends, so the newest days come from the live recorder; the longer the live recorder has run, the smaller the hole.

**Not built.** The Biquote OHLC bootstrap for the recent gap (the vendor publishes no description of such an endpoint) and the import of an MT5 export. B28 reads the HistData files through `importHistData` without the database.

**To review in the research phases.** The default spread of 0.20 USD against the real spreads of the first weeks; the 90 days and the 30 candles; the window of the daily break; the 24 hour limit of the warning and the five days of the hole warning; whether a holiday should have its own class; whether the M1 history without spreads should be replaced by tick files.

## 3. Feature library

Every feature is computed incrementally and stored in each signal's `feature_snapshot`. Status meaning:

- LIVE: used in decisions or in the quality score.
- RESEARCH: computed and logged for every signal, not used in decisions yet.

A feature is promoted from RESEARCH to LIVE only if the ablation test (section 15) shows a stable out-of-sample improvement in expectancy after costs. This is how a large indicator set is used responsibly: logging is cheap, but a decision rule must prove itself.

| Family | Features | Status |
|---|---|---|
| Trend | EMA 9/20/50/200 (order, slope, separation in ATR), Supertrend(10,3), ADX(14) with +DI/-DI, linear-regression slope and R2 (trend quality), Kaufman efficiency ratio | EMA, ADX, Supertrend LIVE. Others RESEARCH |
| Location | Session anchored mean price (tick-volume weighted, approximate VWAP), distance to EMA20/50 in ATR, distance to PDH/PDL and session highs/lows in ATR, round-number levels ($10, $50, $100) | LIVE (levels), anchored mean RESEARCH |
| Momentum | RSI(14) with slope and divergence flag, Stochastic RSI, MACD(12,26,9) histogram and its change, ROC(10) | RSI, MACD LIVE. Others RESEARCH |
| Volatility | ATR(14) and percentile rank, Bollinger(20,2) bandwidth and percentile, Keltner(20,1.5xATR), squeeze on/off and duration, realised volatility, Garman-Klass volatility | ATR, squeeze LIVE. Others RESEARCH |
| Structure | Confirmed swing pivots, HH/HL/LH/LL state, BOS, CHoCH, equal highs/lows, displacement, fair value gap (FVG), order block (last opposite candle before displacement), sweep and reclaim | Pivots, BOS, CHoCH, sweep, displacement LIVE. FVG, order block, equal levels RESEARCH |
| Ichimoku | Tenkan, Kijun, cloud position and thickness on 1h | RESEARCH |
| Execution | Spread (absolute, percentile vs last 24h), tick rate, quote age | LIVE |
| Session | Session, minutes since session open, minutes to session close, Asia/London range | LIVE |
| Macro | Minutes to next high-impact USD event, minutes since last one, post-event volatility ratio, surprise (actual vs forecast) | proximity LIVE (gate). Surprise RESEARCH |
| Cross-asset | DXY, silver (XAGUSD), S&P 500 proxy (US500) momentum and rolling correlation with gold, from the same feed | RESEARCH |
| Trend (extended) | Parabolic SAR, Aroon(25), Donchian(20) and (55) breakout state, Heikin-Ashi streak, Hull moving average slope | RESEARCH |
| Momentum (extended) | CCI(20), Williams %R(14), Awesome Oscillator, regular and hidden divergence of RSI and of the MACD histogram against confirmed pivots | RSI divergence LIVE as a quality bonus. Others RESEARCH |
| Volatility (extended) | Choppiness Index(14), fast/slow ATR ratio, Chandelier exit distance | Choppiness LIVE (regime). Others RESEARCH |
| Trendlines and channels | Automatic support and resistance trendlines and parallel channels built from confirmed pivots (touch count, slope, age), trendline break and retest | LIVE (strategy D and structure evidence) |
| Support and resistance zones | Zones from clustered swing points (touch count, recency, timeframe weight), zone flip after a break, distance in ATR | LIVE |
| Chart patterns | Double top and bottom, head and shoulders (and inverse), ascending, descending and symmetrical triangles, flag and pennant, rising and falling wedge, rectangle | LIVE for strategy E. Wedge RESEARCH |
| Candlestick patterns | Pin bar, engulfing, inside bar and NR7, morning and evening star | Trigger quality only. Standalone use RESEARCH |
| Fibonacci and pivot points | Retracement 38.2, 50, 61.8, 78.6 and the 61.8-78.6 entry zone of the last impulse, extensions 127.2 and 161.8, daily and weekly classic and Camarilla pivots | Retracement LIVE (location). Rest RESEARCH |
| Anchored mean price | Tick-volume weighted price anchored at the session open, the last swing high or low and the previous-day close, with 1 and 2 standard-deviation bands | RESEARCH |

Cross-asset symbols are subscribed on the same stream and stored as candles only (no ticks).

Deliberately not included: volume profile, order flow, depth of market and footprint charts (the feed has no real volume or order book), Elliott waves and Gann tools (not objectively definable), harmonic patterns (backlog item, very high curve-fitting risk), social or sentiment data (no free reliable source).

Evidence note. Academic work (Lo, Mamaysky and Wang, Journal of Finance 2000) found that several chart patterns, detected with a systematic algorithm, carried incremental information in US stocks from 1962 to 1996. That is a different market, horizon and period from intraday gold, and it says nothing about trading costs. Its methodological lesson is what this design follows: patterns and trendlines are detected by fixed, testable rules (section 4), never by eye. Every indicator, trendline and pattern must prove itself on out-of-sample gold data after costs before it is trusted.

## 4. Primitives (formal definitions)

All use closed candles. `ATR` is ATR(14) of the same timeframe unless stated.

- **Swing pivot (fractal), parameter k**: candle i is a swing high if `high[i] > max(high[i-k..i-1])` and `high[i] > max(high[i+1..i+k])`. It is confirmed at the close of candle i+k, never earlier. Swing low is symmetric. k = 2 on 5m, 15m, 1h.
- **Structure state**: using the last two confirmed swing highs and last two confirmed swing lows. `UP` if highs and lows both rise, `DOWN` if both fall, otherwise `RANGE`.
- **BOS (break of structure)**: in state UP, a candle closes above the last confirmed swing high (body close, wicks do not count). Mirror for DOWN. In RANGE a close beyond the range boundary counts as BOS in that direction.
- **CHoCH (change of character)**: in state UP, a candle closes below the last confirmed swing low. Mirror for DOWN. This marks the first break against the prevailing structure.
- **Displacement candle**: range >= 1.2 x ATR, body/range >= 0.6, and close within the top 25% (bullish) or bottom 25% (bearish) of the range.
- **Liquidity levels**: PDH, PDL, ASIA high/low, LONDON high/low (completed session), equal highs/lows (two or more swing highs/lows within 0.15 x ATR of each other).
- **Sweep and reclaim (bullish, at a liquidity low L)**: a candle trades below L by at least 0.10 x ATR, and within 3 candles a candle closes back above L. The sweep candle's lower wick is at least 50% of its range. Bearish is symmetric at a liquidity high.
- **Fair value gap**: bullish if `low[i] > high[i-2]` with gap size >= 0.3 x ATR. Bearish symmetric.
- **Squeeze**: Bollinger(20,2) bands inside Keltner(20,1.5xATR). Squeeze release when the bands move outside.
- **Value zone (for pullbacks)**: the band between EMA20 and EMA50 on 5m, or the 38.2%-61.8% retracement of the last confirmed 15m impulse leg (swing low to swing high).

### 4.1 Trendlines, zones, patterns, divergence, candlesticks

All tolerances are `v0.1.0` hypotheses. Every detected object is stored with its coordinates (time, price) so the UI can draw it and the review can explain it. Prices are linear (no log scale at this horizon).

- **Support trendline (bullish)**: take the confirmed swing lows of the timeframe (15m for context, 5m for timing) in the last 80 candles. A candidate line passes through two swing lows A (earlier) and B (later) that are at least 6 candles apart, with B above A and slope at most 0.15 x ATR per candle. The line is valid if no candle since A closed below it by more than 0.10 x ATR and no swing low between A and B lies below it by more than 0.15 x ATR. Touches are the swing lows within 0.15 x ATR of the line; at least 2 are required and 3 or more make it confirmed. The engine keeps the best support line and the best resistance line (mirrored, falling highs) per timeframe by score = 2 x touches + min(length/10, 3) + recency.
- **Channel**: a line parallel to a valid trendline through the extreme opposite swing between A and B, valid with at least 2 touches.
- **Trendline break and retest**: a break is a close beyond the line by at least 0.10 x ATR with body/range >= 0.5. A retest is a return to within 0.30 x ATR of the line from the new side within 8 candles, followed by a close away from it.
- **Support/resistance zone**: cluster the swing highs and lows of the last 300 5m, 200 15m and 150 1h candles. Points within 0.25 x ATR(15m) of each other form a cluster of at least 2 points; the zone is the min to max of the cluster padded by 0.05 x ATR. Strength = sum of timeframe weights (1h 3, 15m 2, 5m 1) x recency weight (halves every 100 candles of that timeframe). A close beyond a zone by at least 0.2 x ATR flips its role.
- **Fibonacci**: the impulse leg is the last confirmed 15m swing low to swing high (or the reverse) of at least 2.5 x ATR(15m). Retracement levels 38.2, 50, 61.8, 78.6; entry zone 61.8-78.6; extensions 127.2 and 161.8.
- **Double top**: two swing highs within 0.25 x ATR, 8 to 60 candles apart, with the lowest low between them at least 1.0 x ATR below. Neckline = that low. Trigger = close below the neckline by 0.10 x ATR with displacement. Measured target = neckline minus the pattern height. Double bottom is the mirror.
- **Head and shoulders**: three swing highs L, H, R where H is at least 0.5 x ATR above both, L and R are within 0.5 x ATR of each other, and the neckline through the two intervening swing lows has slope at most 0.1 x ATR per candle. Trigger and target as for the double top (head height projected from the neckline). Inverse is the mirror.
- **Triangle**: ascending = horizontal resistance (2 or more touches within 0.2 x ATR) plus a valid rising support line; descending is the mirror; symmetrical = falling resistance and rising support that converge. Compression: width of the last third of the pattern <= 0.6 x the width of the first third. Breakout = close beyond a boundary by 0.10 x ATR with displacement before the apex.
- **Flag and pennant**: pole = displacement leg of at least 3 x ATR within 8 candles; consolidation of 5 to 20 candles that retraces at most 50% of the pole inside a parallel channel (flag) or converging lines (pennant); breakout in the pole direction; measured target = pole height.
- **Wedge**: both boundaries slope the same way and converge; breakout against the slope. Research only.
- **Rectangle**: at least 2 touches each on horizontal support and resistance within 0.2 x ATR, height between 1.5 and 4 x ATR, at least 12 candles.
- **Divergence (bullish regular)**: two consecutive confirmed price swing lows 5 to 40 candles apart where price makes a lower low and RSI(14) at the same pivots makes a higher low, the first RSI pivot at or below 40. Hidden bullish: price higher low, RSI lower low. Bearish is the mirror. MACD histogram divergence is research only.
- **Candlesticks**: bullish pin bar = lower wick >= 2 x body and >= 60% of range, close in the top 35%. Engulfing = body covers the previous body and range >= 1.0 x ATR. Inside bar = high and low inside the previous candle. NR7 = narrowest range of the last 7. Morning star = large bearish candle, small-bodied candle below it, large bullish candle closing above the first one's midpoint. Evening star is the mirror.

## 5. Regime classifier

Deterministic, evaluated on 15m and 1h data:

| Regime | Rule (v0.1.0) |
|---|---|
| TREND_UP / TREND_DOWN | 1h EMA20/50/200 ordered, ADX(1h) >= 20, efficiency ratio(1h, 20) >= 0.30 |
| RANGE | ADX(1h) < 18 and 15m range width <= 3 x ATR(15m) over the last 24 candles |
| SQUEEZE | 15m squeeze on for at least 8 candles |
| BREAKOUT | squeeze released within the last 6 candles of 15m with displacement |
| HIGH_VOL | ATR(15m) percentile >= 90 |
| NEWS_SHOCK (flag, not a regime) | within event window and (ATR(5m) >= 2.5 x its 24h median or spread >= 3 x median); reported next to the regime, adds a warning, never blocks by itself |
| UNCERTAIN | anything else |

Strategies declare the regimes they accept.

### 5.1 Regime and context details (B13)

Code: `packages/core/src/regime` (`classifyRegime`, `RegimeTracker`, `volBucketOf`), `packages/core/src/context` (`MedianBaseline`, `newsShockOf`, `macroProximity`, `newsStateOf`) and `sessionClockAt` in `time/sessions.ts`. It is pure and streaming, so the worker, the backtester and the tests run the same code and nothing looks ahead. The numbers are the `v0.1.0` hypotheses in `REGIME_DEFAULTS` and the other `*_DEFAULTS` constants, kept in `core` like those of the other primitives.

**Which rule wins.** The table above does not say what happens when several rules are met. The first one in this order wins: BREAKOUT, SQUEEZE, HIGH_VOL, TREND_UP or TREND_DOWN, RANGE, then UNCERTAIN. Reasons: BREAKOUT and SQUEEZE describe what the 15m market is doing now, and strategy C needs them even when the 1h trends. HIGH_VOL is above trend and range because strategies A to D do not accept it and E excludes it: extreme volatility is a "stand aside" state, and it would be pointless if a trend label could hide it. HIGH_VOL is below BREAKOUT because a breakout candle raises ATR by itself and would hide the breakout exactly when C and D look for it. TREND and RANGE can never both be met (ADX 20 or more against below 18). The result also lists every rule that is met (`matched`), so the dashboard can say "BREAKOUT, also trend up".

**Definitions.** Limits are inclusive as written (ADX 20, efficiency 0.30, width 3 ATR, squeeze 8 candles, percentile 90) except "below 18". EMA 20, 50 and 200 must be strictly in order. "Released within the last 6 candles" means the release candle is one of the newest 6 15m candles (0 to 5 candles ago), and a displacement candle (section 4, with the ATR of that 15m candle) must be the release candle or come after it; the direction of the newest displacement is the breakout direction. The 15m range width is the highest high minus the lowest low of the newest 24 15m candles, the current one included, against the ATR(14) of the newest candle. The squeeze is the Bollinger(20,2) and Keltner(20,1.5xATR(14)) squeeze of section 4.

**ATR percentile and volatility bucket (decisions, not in the docs before).** The percentile is the rank of ATR(14) of the 15m candle among the previous 480 ATR values (five trading days), as the share that is less than or equal to it. The volatility bucket of the statistics key (section 13) comes from the same percentile: LOW below 33, HIGH from 67, NORMAL between (thirds, so that the buckets fill evenly). HIGH_VOL (90 or more) is always inside HIGH.

**Warm-up.** `RegimeTracker.state` is null until 1h has 200 candles (EMA 200) and 15m has 494 (14 for the first ATR and 480 for the percentile window). The "three times the period" rule of section 2 (600 hourly candles before EMA 200 is trusted) is applied by the `WARMUP_OK` gate, not here. Push every 15m and 1h candle that closed at the same moment before reading `state`; then the answer does not depend on the order.

**News shock and news window.** `MedianBaseline` is the 24h median: the median of the previous 288 closed 5m candles (a weekend has no candles, so it does not stretch the window), for ATR(5m) and for the average spread of the candles. `NEWS_SHOCK` is the news window being active and (ATR(5m) at least 2.5 times its median or the spread at least 3 times); a ratio that cannot be computed counts as not exceeded. `macroProximity` takes the calendar events that match the impact and currency of `gates.newsWindow` and gives the next event (after now) and the last one (at or before now) with the minutes to and since them, and whether now is inside [-before, +after] of an event (both ends included). The `NEWS_WINDOW` flag also stays on after the scheduled window while ATR(5m) or the spread is still at least 1.5 times its median; the docs gave no end for that, so it closes at the latest 120 minutes after the event. The news state is `UNKNOWN` when the calendar is not available and never `CLEAR` by guess. The worker reads the calendar (B25a, `04` section 4, "Calendar alerts and the calendar feed"); it is available while its last good reading is at most 15 minutes old (`calendarAvailable`), and the stored events feed `macroProximity` (the decision loop reads them, section 10.1).

**Session clock.** `sessionClockAt` gives the label (section 2), the stretch of time that carries it with the minutes since it began and until it ends, and the opening hours of London (08:00-16:30 London time) and New York (08:00-17:00 New York time) while they are open. A label's end is not a market close: LONDON ends when New York opens and OVERLAP when London closes. A rule about "the last 30 minutes of a session" (`OFF_HOURS`) must therefore read the venue clocks.

## 6. Gates and advisory flags

Only two things can stop a signal: missing or unreliable data, and a trade whose maths does not work. Nothing is stopped because of the time of day, how many signals already came, or how earlier signals ended. Every other risk condition is shown as a warning on the signal and tracked in the statistics, so the evidence decides later whether a condition deserves a block.

### Blocking gates (data quality and trade viability; failing codes are recorded)

| Gate | Default |
|---|---|
| `DATA_FRESH` | Last tick received within 10 s, provider `stale` false, market open |
| `WARMUP_OK` | All required timeframes warmed up |
| `CLOCK_OK` | Receive-vs-source skew under 5 s |
| `SPREAD_OK` | spread <= 0.60 USD and spread <= 12% of stop distance |
| `GAP_RECOVERY_OK` | No feed gap or weekend gap inside the last 12 five-minute candles (indicators need clean history) |
| `REGIME_OK` | Strategy applicability: the regime is one the strategy was designed for (a trend pullback is not evaluated in a range). This is part of the strategy definition, not a throttle |
| `STOP_OK` | Stop distance between 0.8 x ATR(5m) and 2.0 x ATR(5m) |
| `TARGET_OK` | TP1 distance <= 2.5 x ATR(5m) |
| `QUALITY_OK` | Quality score >= 65 (section 8) |

### Advisory flags (never block a signal)

| Flag | Condition | Effect |
|---|---|---|
| `NEWS_WINDOW` | HIGH-importance USD event within [-45 min, +20 min], or spread and ATR not yet back under 1.5 x median after a release | Warning line, lowers the Session and macro group, statistics bucket `news = IN_WINDOW` |
| `NEWS_SHOCK` | See the regime table | Warning line |
| `HEADLINE_RECENT` | A HIGH-impact headline cluster in the last 30 minutes (section 16) | Warning line and a news line with up to 3 headlines |
| `ROLLOVER` | Session ROLLOVER: 21:45-23:15 UTC and the quiet hours up to midnight (section 2, 6.1) | Warning line |
| `OFF_HOURS` | ASIA session or the last 30 minutes of a session (6.1: while every open market is about to close) | Warning line (thin liquidity) |
| `NEAR_LEVEL` | Entry within 0.3 x ATR(5m) of a major opposing level, unless the setup is a sweep of that level | Warning line, lowers Reward feasibility |
| `OPPOSES_OPEN` | Direction is opposite to an open signal | Warning naming that signal |
| `UNVALIDATED_STRATEGY` | Strategy status below VALIDATED | `FORWARD-TEST` label |
| `NEWS_UNKNOWN` | Calendar feed unavailable | Warning line, news state UNKNOWN |

By default every flag only warns. The owner can switch a flag to `block` in Settings (`advisoryGates`). That is a personal preference stored in `app_settings`, not in the strategy config, and the flags present at signal time are stored on each signal, so statistics always show how signals with and without a flag performed.

### 6.1 Gates and flags, details (B14)

Code: `packages/core/src/gates` (`evaluateGates`, `evaluateFlags`, `decide`, `nearOpposingLevel`, `gateLabel`) and `gateParamsOf` in `packages/config`. Pure code: the worker and the backtester run the same functions, and the live values (feed health, clock skew, spread, candle counts, the regime, the news window) are handed in.

**Blocking gates.** Each gate returns `{code, passed, value?, limit?}`, the form stored in `signals.hard_gates`. A failed gate may add a `reason` (for example `STALE` or `DISCONNECTED`) and WARMUP_OK the missing timeframes; these are for the dashboard and are not stored. **A gate whose input is unknown fails**: no clock skew yet, no spread, no ATR, no quality score. Missing data blocks. Without a setup only the five market gates run (DATA_FRESH, WARMUP_OK, CLOCK_OK, SPREAD_OK, GAP_RECOVERY_OK, `complete` is false); a signal needs all nine, and a decision on fewer is refused.

- `DATA_FRESH`: the feed is connected, its newest tick is at most 10 s old by its source time, the provider does not call the quote stale and the market state is `OPEN`. The value is the age in seconds. The reason is the first that applies: market closed, disconnected, no tick yet, tick too old, provider stale, market state unknown.
- `WARMUP_OK`: every timeframe of the strategy (entry, context and bias) has its warm-up candles: **three times the longest window the engine uses on that timeframe**, as section 2 says for EMA 200. That is 900 for 5m (the zones look at 300 candles), 1440 for 15m (the ATR percentile of the regime looks at 480) and 600 for 1h (EMA 200). A test fails when a window grows without these numbers, and they are never below what the regime needs. The value is the progress in whole percent (the mean share of the required timeframes, rounded down, so 100 means ready).
- `CLOCK_OK`: the median receive-minus-source time is under 5 s in either direction; exactly 5 s fails.
- `SPREAD_OK`: the spread is at most 0.60 USD and at most 12% of the stop distance. That is one limit, the smaller of the two, and the result gives the spread and that limit. Without a stop distance only 0.60 applies.
- `GAP_RECOVERY_OK`: the newest 12 5m candles have no hole between them, neither a feed gap nor a weekend. The value is how many candles in a row, counted back from the newest (at most 12). A hole just before those 12 candles does not count. If the candle that has just closed is missing from the end of the series, it fails.
- `REGIME_OK`: the regime is one of the accepted regimes of the strategy. `STOP_OK` and `TARGET_OK`: the distance in ATR(5m); a failure gives the bound that was broken, a pass the bound it is nearest to. `QUALITY_OK`: the score is at least 65 and rests on at least 70% of the weight (the coverage is checked first, section 8).
- A rejection (`rejections.failed_gates`) lists the failed gates and then the flags that the owner switched to block.

**Advisory flags.** Where the table leaves room, these are the definitions:

- `NEWS_WINDOW` is the news window of section 5.1 (including the time while spread and ATR settle). `NEWS_UNKNOWN` is present when the calendar is unavailable, and then `NEWS_WINDOW` cannot be.
- `HEADLINE_RECENT`: the newest HIGH headline cluster was published at most 30 minutes ago; one stamped ahead of our clock counts as just now.
- `ROLLOVER` is the session label ROLLOVER of section 2, so the flag and the statistics bucket always agree.
- `OFF_HOURS`: the ASIA label, or every open market (London, New York) closes within 30 minutes. The last half hour of London inside the overlap is not off-hours, because New York is still open.
- `NEAR_LEVEL`: the nearest major level ahead of the entry (above it for a BUY, below it for a SELL) within 0.3 x ATR(5m). A level behind the entry is support, not an obstacle. Major levels are the liquidity levels (previous day, Asia and London highs and lows, equal highs and lows), zones with at least 3 swing points (measured to the near edge, 0 when the entry is inside) and round numbers of $50 and $100. The level that the setup itself sweeps is left out.
- `OPPOSES_OPEN` names every open signal of the other side. `UNVALIDATED_STRATEGY` is present for every status but `VALIDATED` (so also DRIFTED and PAUSED).

**Owner switches.** Only four flags have one, the keys of `advisoryGates`: `newsWindow`, `rollover`, `offHours`, `nearLevel` (warn or block, all warn by default, the owner's settings over the strategy config). `NEWS_SHOCK`, `HEADLINE_RECENT`, `OPPOSES_OPEN`, `UNVALIDATED_STRATEGY` and `NEWS_UNKNOWN` have no switch and always warn. `decide` allows a signal when all nine gates passed and no present flag is switched to block; every other present flag is a warning stored on the signal.

**Wait reasons.** `gateLabel` gives a failed gate in plain words ("Spread too high: 0.90 USD", "No tick for 18 s: new signals are blocked"). The labels of the flags need names (the event, the headline) and are made with the explanation.

## 7. Strategies

Each strategy is defined for BUY; SELL is the exact mirror.

### A. Trend Pullback Continuation (`trend_pullback`)
Accepted regimes: TREND_UP / TREND_DOWN.

- Context: 1h EMA20 > EMA50 > EMA200 and EMA50 slope positive over 6 hours. 15m structure state UP and the last confirmed 15m swing low intact.
- Setup: price pulled back into the value zone. RSI(14, 5m) was at or below 45 within the last 12 candles and is now above its value 3 candles ago.
- Trigger (on 5m close): close above EMA20(5m) and above the previous candle's high, and either a 5m BOS above the last swing high formed since the pullback began, or a displacement candle. MACD histogram rising for 2 candles.
- Stop: lowest low since the pullback began minus 0.25 x ATR(5m).

### B. Liquidity Sweep Reversal (`sweep_reversal`)
Accepted regimes: RANGE, TREND (only with 15m CHoCH in the reversal direction), BREAKOUT failure.

- Context: bullish sweep and reclaim at a liquidity low (PDL, ASIA low, LONDON low, equal lows).
- Trigger: within 6 candles after the reclaim, a 5m CHoCH upward with a displacement candle. RSI bullish divergence at the sweep is a quality bonus, not a requirement.
- Stop: sweep low minus 0.20 x ATR(5m).

### C. Squeeze Breakout and Retest (`squeeze_retest`)
Accepted regimes: SQUEEZE, BREAKOUT.

- Context: 15m squeeze on for at least 8 candles, then release.
- Breakout: a 5m close above the Donchian(20) high by at least 0.10 x ATR with a displacement candle and rising ADX. The breakout candle itself is never the entry.
- Retest trigger: within 8 candles price returns to within 0.25 x ATR of the broken level, then a 5m candle closes back above it with a rejection wick.
- Stop: retest low minus 0.20 x ATR(5m).

### D. Trendline Break and Retest (`trendline_retest`)
Accepted regimes: TREND_UP, TREND_DOWN, RANGE (channel boundaries), BREAKOUT.

- Context: a valid 15m trendline with at least 3 touches (falling resistance line for a bullish break). The 1h trend is not strongly against the break (ADX(1h) < 30 or aligned).
- Break: a 5m close beyond the line by at least 0.10 x ATR with body/range >= 0.5. The break candle itself is never the entry.
- Retest trigger: within 8 candles price returns to within 0.30 x ATR of the line and a 5m candle closes back away from it with a rejection wick of at least 30% of its range, with RSI(14, 5m) above 45.
- Stop: retest low minus 0.25 x ATR(5m), or beyond the line if that is closer.
- Setup key: trendline id plus break candle time.

### E. Chart Pattern Breakout (`pattern_breakout`)
Accepted regimes: any except HIGH_VOL.

- Patterns: double top and bottom, head and shoulders (and inverse), ascending, descending and symmetrical triangles, flags and pennants, rectangles (definitions in 4.1).
- Break: the pattern's breakout rule on a 5m close.
- Entry: only on a retest that holds within 8 candles of the break (same rule as strategy C). No retest means no signal.
- Stop: beyond the last swing of the retest by 0.25 x ATR(5m), bounded by `STOP_OK`. Exit profile `EP3_STRUCTURE` with the measured-move target; if the measured move is below 1.5R the setup produces no signal.
- Setup key: pattern id.

### F. Hourly Trend (`hourly_trend`)
Accepted regimes: all (the strategy reads the 1h chart, not the 5m regime). A **paper** strategy: it exists to give a steady stream of signals to follow on a demo account, not because an edge was found (see 7.6).

- Context: the 1h trend of the newest closed 1h candle. UP when EMA(20) > EMA(50) and the close is above EMA(200); DOWN is the exact mirror; otherwise there is no setup.
- Decision: every 30 minutes (at :00 and :30, the 5m candle that closes the slot). No pullback and no trigger candle.
- Stop: 2.5 x ATR(1h) from the price, bounded by `STOP_OK` (in ATR(5m): 3 to 16 for this strategy).
- Exit profile `EP1_PARTIAL`, entry valid 300 s, time stop 240 minutes.
- Setup key: the 5m candle that closes the slot (`hourly_trend:5m:<UTC time>`).

### G. Confluence (`confluence`)
Accepted regimes: all (the nine votes include the trend and the ADX, so the regime is not a second filter). A **paper** strategy that gives a steady stream of signals of a size the owner asked for (a first target of about 10 to 16 USD, a stop beyond the structure and as far as the first target) and counts many readings instead of trusting one; it was written because the owner wanted several signals a day, not because an edge was found (see 7.7).

- Context: on the close of every 5m candle, nine questions are asked for each side: the 1h trend (EMA 20 over EMA 50 and the close over EMA 200), the 15m trend (EMA 20 over EMA 50), the 5m averages (EMA 20 over EMA 50), RSI(14) on the side of 50 but not past 75 (25 for a SELL), MACD histogram on the side and moving that way, ADX(14) at 20 or more with the right directional line on top, the close on the side of the mean price of the UTC day, the close beyond the high (low) of the last six candles, and the close not further than 1.5 ATR from the 5m EMA 20.
- Setup: at least 7 of the 9 agree for one side (and that side has more votes than the other), the candle that closes has a body of at least 0.4 ATR(5m) that way, ATR(5m) is at least 0.8 of its average of the last day, and the candle closes inside the session (07:00 to 20:30 UTC).
- Stop: beyond the lowest low (highest high) of the last 10 candles plus 0.5 ATR(5m), and at least 3 ATR from the price. When the structure is further than 4.2 ATR, or the stop would be wider than 16 USD, there is no setup: the stop is never pulled in to where the structure says it would be taken out.
- Exit profile `EP1_PARTIAL`: the first target is as far as the stop (1R), the runner 2R; entry valid 180 s, time stop 120 minutes (an INTRADAY trade, 9.2). In ATR(5m) the gates are 2.5 to 5 for the stop and 5 for the first target.
- Setup key: one for each side in each 30-minute slot (`confluence:<side>:<UTC time of the slot>`), so a trend that keeps voting makes one setup for each side in a slot, and a restart cannot make a second one.
- Quality weights (the bands of the execution and reward groups are made for stops of 0.8 to 2 ATR): trend 0.30, trigger 0.20, session and macro 0.21, volatility 0.15, structure 0.10, execution and reward 0.02 each.

### Alert policy by strategy status
Every signal is always recorded and tracked. Whether it is also sent to Telegram is a per-strategy alert switch (Settings, `strategyAlerts`). Defaults: ON for A, B, C and G (the messages carry the `FORWARD-TEST` label until a strategy is `VALIDATED`), OFF for D and E until their first backtest report (B28) is reviewed. The owner can switch any strategy on or off at any time. A strategy whose alerts are off still runs in shadow mode, so its evidence builds up without notifications. A strategy that is added after the settings were stored takes its default switch (`settingsWithDefaults` of `packages/config`).

### 7.1 Strategy A, details (B15)

Code: `packages/core/src/strategies` (`StrategySetup`, `keyTime`) and `packages/core/src/strategies/trendPullback` (`judgePullback`, `TrendPullbackStrategy`, `TREND_PULLBACK_DEFAULTS`), and `trendPullbackParamsOf` in `packages/config`. The six `trend_pullback` params of the strategy config are used as they are; the rest are decisions made here and stay in `core` (a change to them is a new strategy version, like any other).

**Interface (also for B16 to B19).** `update(tf, candle)` takes every closed 5m, 15m and 1h candle, each timeframe in time order; `evaluate()` answers for the newest 5m candle: for each side the 11 rules (`PULLBACK_CHECKS`, each a plain true or false, so "why no signal" can be shown) and, when all hold, a `StrategySetup`: side, `setupKey`, the 5m candle that completed it, its close (a reference, the entry comes with the tick, section 9), the stop and the numbers behind it. Entry, take profits, risk and the score are section 8 and 9; the gates are assembled by the engine from the section 6 functions. Push every candle that closed at the same moment before calling `evaluate()`; the answer then does not depend on the push order. A value that does not exist yet (warm-up) fails its rule; nothing is guessed.

**SELL is the exact mirror.** The strategy is written once, for a BUY. The SELL side runs the same code on mirrored candles (every price negated, high and low swapped), and the numbers of its setup are turned back into real prices. So the mirror is true by construction, and a test checks it candle by candle. The rules read for SELL: EMA20 < EMA50 < EMA200 with a falling EMA50, 15m state DOWN and the last confirmed swing high intact, RSI at or above 55 (100 minus 45) within the last 12 candles and now below its value 3 candles ago, close below EMA20 and below the previous low, a break below the last swing low or a bearish displacement, MACD histogram falling for 2 candles, stop above the highest high of the pullback. Both sides cannot be set at once: the 1h trend is up or down.

**The pullback leg ("since the pullback began").** The leg begins at the highest high of the 36 5m candles before the trigger candle (the latest one if several are equal); the trigger candle is not part of that search, so a trigger candle that makes a new high is a breakout of the same leg. A candle before the trigger candle that makes a new high ends the leg and a new one begins there. A pullback older than 36 candles (3 hours) forgets its start; this window is a hypothesis (`legLookbackCandles`, not in the config yet). The pullback extreme is the lowest low from the start of the leg to the trigger candle (the trigger candle included). The setup key is `trend_pullback:5m:leg-<UTC time of the leg's first candle>` (for example `trend_pullback:5m:leg-2026-10-23T05:30:00Z`): all candles of one leg give the same key, so the unique index of section 10 lets the first one through.

**Value zone.** Either the 5m EMA band or the Fibonacci zone is enough. The EMA band is met when some candle of the leg had its low at or below the upper edge of the band between EMA20 and EMA50 (5m) as the averages stood when that candle closed; today's averages cannot be used because they are averages of the leg itself and would always be reached. The Fibonacci zone is the 38.2 to 61.8 percent retracement of the last 15m up leg of at least 2.5 ATR (section 4.1), as of now; it is met when the pullback extreme is at or below its upper edge. The setup says which one it was (`EMA`, `FIB`, `EMA+FIB`).

**15m context.** The state is UP (two higher swing highs and two higher swing lows). "The last confirmed swing low is intact" means no 15m candle has closed below it since it was confirmed; a wick below does not break it. A new swing low replaces it, so a collapse that has itself become the newest swing low is intact, and the state UP is what then fails.

**RSI and MACD.** RSI(14, 5m) at or below 45 counts the newest 12 RSI values, the newest included, and "now above 3 candles ago" is strict. The MACD(12,26,9) histogram must rise strictly on each of the last 2 candles (3 values).

**Trigger.** Close above EMA20(5m) and above the high of the candle before (both strict), and either the close is above the last 5m swing high that formed after the leg began (a swing high with 2 candles on each side, known 2 candles later), or the trigger candle itself is a bullish displacement candle (section 4). The break does not have to happen on this candle: while the leg lasts, every candle that meets all rules gives the same setup key, and only the first becomes a signal.

**Stop.** Pullback extreme minus 0.25 x ATR(5m) (the ATR includes the trigger candle). Whether that distance is allowed is `STOP_OK` (section 6), not the strategy's business.

### 7.2 Strategy B, details (B16)

Code: `packages/core/src/strategies/sweepReversal` (`judgeSweep`, `chooseSweep`, `SweepReversalStrategy`, `SWEEP_REVERSAL_DEFAULTS`), the shared `mirrorCandle` and `mirrorLevel` in `strategies/mirror.ts`, and `sweepReversalParamsOf` in `packages/config`. The three `sweep_reversal` params of the strategy config are used as they are (the 6-candle trigger window, the 15m CHoCH in a trend, the 0.20 stop buffer); the ATR period (14) is the only other number, and what a sweep, a CHoCH and a displacement candle are is section 4 with its defaults.

**Interface.** Same idea as 7.1, with two timeframes and two inputs more. `updateFive(candle, levels)` takes every closed 5m candle with the liquidity levels that apply to it (`LiquidityBook.levels` as they stood before the book is updated with that candle, section 4 and `levels/liquidity.ts`), `updateQuarter(candle)` takes every closed 15m candle, and `evaluate(regime)` answers for the newest 5m candle: for each side the 4 rules (`SWEEP_CHECKS`: a reclaimed sweep, a 5m CHoCH, a displacement candle, the trend rule) and, when all hold, a `StrategySetup` with the key, the stop and the facts. The regime comes from the regime classifier (section 5) and is read at each call. As in 7.1, push every candle that closed at the same moment before calling `evaluate()`. The strategy does not look at `acceptedRegimes`: that is the `REGIME_OK` gate. The engine owns the `LiquidityBook` (the gates need the same levels for `NEAR_LEVEL`).

**SELL is the exact mirror**, by the same construction as in 7.1: the code is written for a BUY and SELL runs it on negated candles. The liquidity highs of the real market are the liquidity lows of the mirrored one (`mirrorLevel`). A BUY sweeps liquidity lows only and a SELL liquidity highs only; the other side's levels are ignored.

**The trigger is one candle.** On the close of one 5m candle: it closed above the last confirmed 5m swing high as a CHoCH (section 4: the structure state before it was DOWN, and that swing high had not been closed above before), and it is itself a bullish displacement candle. The reclaim candle may itself be that candle (a sweep candle that closes below the level and the next candle that reclaims it with a displacement is the strongest case), so the window is the reclaim candle through the sixth candle after it, counted from the reclaim, not from the sweep. The reclaim itself comes from the sweep tracker of section 4 (a sweep is reclaimed on its own candle or within 3 candles after it). The CHoCH is strict, as written: a break of a swing high when the state was RANGE or UP is a BOS and does not count. That is the first thing to look at when the strategy is researched (B27 onward); it is not loosened here. A candle that breaks the swing high first is the only trigger: later candles above it have no CHoCH of their own, so a setup is not repeated while the move goes on, and the key of section 10 would stop a repeat anyway.

**Which sweep.** Several sweeps can be alive (two levels swept by one candle, or two sweeps a few candles apart). The setup is about the one reclaimed most recently; among equals the one that went deepest, then the smaller level id, so that the choice does not depend on the order of the list. The setup key is `sweep_reversal:5m:<level id>@<UTC time of the sweep candle>`, for example `sweep_reversal:5m:PDL:2026-10-22@2026-10-23T07:40:00Z`. A level can be swept once while it is supplied, so the key is stable.

**Stop.** The sweep low, which is the lowest low from the start of the sweep candle to the trigger candle (the same as the sweep low of section 4 unless a candle after the reclaim traded lower; the stop must not sit inside a probe), minus 0.20 x ATR(5m). For a SELL the highest high plus 0.20 x ATR(5m). `STOP_OK` decides whether that distance is allowed.

**The trend rule.** In TREND_UP and TREND_DOWN the reversal also needs a 15m CHoCH in its direction (upward for a BUY) that closed after the sweep candle opened: it is part of this reversal, and one that closed before belongs to an earlier move. The CHoCH of an earlier move does not count, and neither does one in the other direction (the newest 15m CHoCH is the one that counts). In every other regime the rule is not asked for; BREAKOUT is the "breakout failure" of section 7.B, which a sweep and reclaim is by itself. With `requireChochInTrend` off the rule always holds. An unknown regime cannot be judged, so with the rule on it fails. Whether the 15m CHoCH was there is a fact of the setup in every regime (`choch15m`).

**Divergence.** `rsiDivergence` is true when a regular bullish RSI divergence (section 4.1, 5m) has its second low on a candle from the sweep candle to the reclaim candle. It is known only when that low is confirmed as a swing low, two candles later, so a setup made earlier says false. It is a quality bonus for section 8 and never a rule.

### 7.3 Strategy C, details (B17)

Code: `packages/core/src/strategies/squeezeRetest` (`judgeSqueeze`, `breakoutOf`, `retestOf`, `chooseBreakout`, `SqueezeRetestStrategy`, `SQUEEZE_RETEST_DEFAULTS`) and `squeezeRetestParamsOf` in `packages/config`. The six `squeeze_retest` params of the strategy config are used as they are (8 squeezed 15m candles, Donchian 20, 0.10 ATR beyond it, 8 candles for the retest, 0.25 ATR to the level, 0.20 stop buffer). The rest are decisions made here and stay in `core`: the ATR and ADX periods (14), the release window (6 15m candles) and the share of the retest candle's range that the rejection wick must be (30 percent).

**Interface.** As in 7.2 but with nothing else to hand in: `updateFive(candle)`, `updateQuarter(candle)` and `evaluate()`, which answers for the newest 5m candle with the 5 rules of each side (`SQUEEZE_CHECKS`: the 15m squeeze was released, a breakout is waiting, the retest candle touched the level, closed above it, and has the rejection wick) and, when all hold, a `StrategySetup`. Push every candle that closed at the same moment before calling `evaluate()`. The regime (SQUEEZE or BREAKOUT) is the `REGIME_OK` gate, not the strategy's. SELL is the exact mirror by the same construction as in 7.1 and 7.2: a breakout below the lowest low, a retest from below with an upper wick, the stop above the retest high. The squeeze and the ADX do not care about direction.

**The 15m context.** The newest release of a 15m squeeze (section 4: Bollinger inside Keltner) counts when the squeeze had been on for at least 8 candles before it, the release is among the newest 6 15m candles (the release candle is the first of them) and the bands are outside the channel now. These are the numbers of the regime classifier (section 5.1: a squeeze of 8 candles, a release within 6), and a test ties them. It is judged at the retest candle, not at the breakout: the 15m candle that releases the squeeze closes after the 5m breakout that it belongs to, so the release is usually known only a few candles after the breakout. A shorter squeeze that was released later is the newest release and fails the rule.

**The breakout.** A 5m candle that closes above the highest high of the 20 candles before it (the candle itself never counts) by at least 0.10 x ATR(5m) (the ATR includes the candle, and the comparison ignores the last bit of a float), that is a bullish displacement candle (section 4), and with ADX(14, 5m) strictly higher than on the candle before it. The highest high is the broken level. The breakout candle is never the entry: it is first judged as a retest candle on the next candle.

**Waiting for the retest.** A breakout waits for 8 candles after its own. It ends at once if a candle closes below the level (a close exactly on it does not end it: the level held). A candle that closes beyond the level again higher up is a breakout of its own, with its own level, and several can wait at once.

**The retest candle.** One candle that has all three: its low is at or below level + 0.25 x ATR(5m) (so it may go through the level), it closes above the level (strictly), and its lower wick is at least 30 percent of its range. The touch, the close and the wick are on the same candle: price that is still far above the level is not a retest, and an earlier touch followed by a candle that has no business near the level is not either. The 30 percent is the number of strategy D (section 7.D); the spec of C only says "rejection wick". When the candle completes the retest of several waiting breakouts, the setup is about the newest of them (whose level is the highest); when it completes none, the rules are shown against the newest breakout.

**Stop.** The retest low, which is the lowest low from the candle after the breakout through the retest candle (the breakout candle's own low is not part of it), minus 0.20 x ATR(5m). For a SELL the highest high plus 0.20 x ATR(5m). `STOP_OK` decides whether that distance is allowed. The setup key is `squeeze_retest:5m:brk-<UTC time of the breakout candle>`, one signal per breakout and side (section 10).

**To review in the research phases (B27 onward).** Not loosened here: that the touch, the close and the wick are on one candle, the 30 percent wick and that a close below the level ends the breakout.

### 7.4 Strategy D, details (B18)

Code: `packages/core/src/strategies/trendlineRetest` (`judgeTrendline`, `chooseBreak`, `lineRetestOf`, `hourTrendOk`, `TrendlineRetestStrategy`, `TRENDLINE_RETEST_DEFAULTS`) and `trendlineRetestParamsOf` in `packages/config`. The nine `trendline_retest` params of the strategy config are used as they are (3 touches, ADX(1h) 30, 0.10 ATR and a half body for the break, 8 candles, 0.30 ATR, a 30 percent wick, RSI 45, 0.25 stop buffer). The rest are decisions made here and stay in `core`: the ATR, RSI and ADX periods (14) and everything about the line finder, which is section 4.1 with its defaults (80 candles, 6 apart, slope at most 0.15 ATR, touch 0.15 ATR); the strategy only hands it `minTouches`.

**Interface.** As in 7.1, with three timeframes: `updateFive`, `updateQuarter`, `updateHour` and `evaluate()`, which answers for the newest 5m candle with the 6 rules of each side (`TRENDLINE_CHECKS`: the 1h trend is not strongly against, a line was broken, price came back to it, the retest candle closed away from it, has the rejection wick, and RSI is above 45) and, when all hold, a `StrategySetup`. Push every candle that closed at the same moment before calling `evaluate()`; the answer then does not depend on the push order. The regime (TREND_UP, TREND_DOWN, RANGE or BREAKOUT) is the `REGIME_OK` gate, not the strategy's. SELL is the exact mirror by the same construction as in 7.1 to 7.3: a rising support line (the falling resistance line of the mirrored chart) broken downward, a retest from below with an upper wick, RSI below 55 (100 minus 45), the stop above the retest high. The 1h indicators are mirrored too: "points the way of the break" is +DI at or above -DI for a BUY and -DI at or above +DI for a SELL.

**The line.** Each side keeps its own 15m market structure and trendline tracker, and only the best line of the kind it can break: the falling resistance line with at least `minTouches` touches (the finder is told `minTouches`, so a line with fewer touches is not a candidate, and a better-scored line with fewer is not preferred over it). A 5m candle uses the 15m line as it stood when the candle opened: the newest 15m candle that had closed by then. A 15m candle that closes at the same moment as a 5m candle is therefore not used by that 5m candle, whichever was pushed first. The line is a straight line in time, so it is read at the open time of the 5m candle. The line geometry is the 15m one, but its distances are in ATR(5m), the ATR of the candle's own timeframe (as `breakOf` takes it).

**The break.** `breakOf` of the trendline module (section 4.1): a close beyond the line by at least 0.10 x ATR(5m) with a body of at least half the range (the direction of the body does not matter: the close is what must be beyond the line). The break candle is never the entry; it is first judged as a retest candle on the next candle. A line is broken **once**: the lines that were broken (the last 16) are remembered, and a candle is not a new break of a line that is within 0.15 x ATR(5m) of a remembered one at that candle (the touch distance of section 4.1). That covers the same line on the next candle (the candles above it are not new breaks) and its twins (collinear swing points give several lines of one geometry, and which of them is the best can change from one 15m candle to the next). A line whose break failed is not broken again.

**The line ids are not stable.** Their numbers are positions in the series, which change when a process restarts. So the setup key names the line by its two swing points: `trendline_retest:5m:15mR:<UTC time of the first point>:<UTC time of the second>@<UTC time of the break candle>` (`15mS` for a SELL), for example `trendline_retest:5m:15mR:2026-10-23T03:15:00Z:2026-10-23T05:00:00Z@2026-10-23T09:35:00Z`. This is "trendline id plus break candle time" of section 7.D.

**Waiting for the retest.** A break waits for 8 candles after its own. It ends at once if a candle closes below the line (a close exactly on it does not end it); the line it is judged against is the one that was broken, even when the 15m chart has since dropped or replaced it. Several breaks (of different lines) can wait at once.

**The retest candle.** "Price returned" and "closed away" follow `BreakRetestTracker` of the trendline module: some candle from the one after the break up to this one, this one included, had its low at or below line + 0.30 x ATR(5m) (so it may go through the line), and the retest candle closes at least 0.30 x ATR(5m) above the line. The return may be on an earlier candle than the retest candle, as there; the retest candle must itself have the lower wick of at least 30 percent of its range (under the body, whichever way the candle goes) and RSI(14, 5m) strictly above 45. When a candle completes the retest of several waiting breaks, the setup is about the newest of them; when it completes none, the rules are shown against the newest break.

**The 1h trend.** Not strongly against: ADX(14, 1h) strictly below 30, or the 1h directional indicator points the way of the break (+DI at or above -DI for a BUY). So a strong trend against the break (ADX at least 30 and -DI above +DI) stops it. ADX needs 28 1h candles; before that the rule fails, like every value that does not exist yet. The setup says the ADX(1h) and whether the trend was aligned.

**Stop.** 0.25 x ATR(5m) beyond the retest low, or beyond the line if that is closer: the higher of the retest low (the lowest low from the candle after the break through the retest candle; the break candle's own low is not part of it) and the line at the retest candle, minus 0.25 x ATR(5m). For a SELL the mirror. The setup says whether the stop came from the line (`stopFromLine`). `STOP_OK` decides whether that distance is allowed.

**Alerts.** D is off for Telegram by default until its first B28 report (section 7, alert policy). It runs in shadow mode and its signals are recorded and tracked like the others.

**To review in the research phases (B27 onward).** Not loosened here: that a line is broken once (a second try after a failed break is lost), that only the best line is watched, the 15m line known at the open of the 5m candle, and the DI reading of "aligned".

### 7.5 Strategy E, details (B19)

Code: `packages/core/src/strategies/patternBreakout` (`judgePattern`, `assessRetest`, `choosePatternBreak`, `patternKey`, `PatternBreakoutStrategy`, `PATTERN_BREAKOUT_DEFAULTS`) and `patternBreakoutParamsOf` in `packages/config`. The three `pattern_breakout` params of the strategy config are used as they are (8 candles for the retest, 0.25 stop buffer, 1.5 R measured move). The rest are decisions made here and stay in `core`: the ATR period (14) and the two numbers of the retest, which are those of strategy C ("same rule as strategy C"): 0.25 x ATR(5m) to the boundary and a lower wick of at least 30 percent of the range. What a pattern is and what breaks it is section 4.1 with `PATTERN_DEFAULTS` (B9).

**Interface.** As in 7.3: `updateFive(candle)`, `updateQuarter(candle)` and `evaluate()`, which answers for the newest 5m candle with the 5 rules of each side (`PATTERN_CHECKS`: a pattern was broken, the retest candle touched the boundary, closed above it, has the rejection wick, and the measured move is enough) and, when all hold, a `StrategySetup`. The regime (any but HIGH_VOL) is the `REGIME_OK` gate, not the strategy's. SELL is the exact mirror by the same construction as in 7.1 to 7.4: a break below the lower boundary and a retest from below with an upper wick; the setup says the pattern as the real chart shows it (`DOUBLE_TOP` after a SELL that the mirrored chart saw as a double bottom).

**The patterns are on the 15m chart, the break and the retest are on 5m** (the same split as the trendlines of 7.D: 15m for context, 5m for timing; the spec of E only says "the pattern's breakout rule on a 5m close"). Each side keeps its own 15m market structure, trendline tracker and `PatternTracker`, and a 5m candle uses the patterns of the newest 15m candle that had closed when it opened: a 15m candle that closes together with a 5m candle is not used by it, so the push order does not matter. Wedges are research only and are left out; every other pattern counts, in either direction its break rule allows (a descending triangle broken upward is a BUY).

**The break.** `patternBreakout` of the pattern module (section 4.1): a 5m close beyond the upper boundary by at least 0.10 x ATR(5m), by a displacement candle (range at least 1.2 x ATR(5m), body at least 60 percent, close in the top quarter), before the apex of a converging pattern. The ATR is the 5m one, not the one of the 15m chart the pattern was found on. The break candle is never the entry. A pattern is broken **once, in either direction**, for as long as it stays on the 15m chart (the same rule as in B9): a pattern that a bearish displacement broke downward is gone for the BUY side, and a second displacement above the boundary later is not a new break. A pattern that leaves the 15m chart and comes back is a new one. A pattern that the 15m chart itself breaks (a 15m candle that closes beyond it) leaves the chart, so a break that only the 15m candle shows, and no 5m candle, is lost (to review).

**One idea, one break.** The same swing points often form several patterns (B9: a rectangle and a double bottom share a boundary). When several patterns break upward on one 5m candle it is one idea: the one with the largest measured move is kept and the others are used up (they cannot break again); the setup says how many others there were (`alsoBroke`). On a tie of the measured move the one that the pattern module lists first (its reversal patterns come before its line-based ones; a rectangle and a double bottom with the same boundary and height give the double bottom). The listing order is the same for a chart and its mirror image, so the mirror is exact. Patterns that break on different candles are different breaks, as with strategy C.

**Waiting for the retest and the retest candle.** As in 7.3, with the boundary at the time of the candle (a boundary can be sloped: a flag): a break waits for 8 candles after its own, ends at once when a candle closes below the boundary (a close exactly on it does not), and several can wait. The retest is **one candle** with all three: its low is at or below the boundary + 0.25 x ATR(5m) (it may go through it), it closes above the boundary (strictly), and its lower wick is at least 30 percent of its range. When a candle completes the retest of several waiting breaks (every rule, the measured move included), the setup is about the newest of them; when it completes none, the rules are shown against the newest break.

**Stop and measured move.** The stop is 0.25 x ATR(5m) beyond the retest low, the lowest low from the candle after the break through the retest candle (the break candle's own low is not part of it; "the last swing of the retest" is that low, because a swing needs two candles after it and the retest candle has none). The target is the broken boundary at the break candle plus the height of the pattern (the measured move of section 4.1, which for triangles is the width at the start and for flags the pole). The rule `measuredMove`: the distance from the close of the retest candle to the target is at least `minMeasuredMoveR` (1.5) times the distance from the close to the stop; otherwise no signal. The close is the reference of the strategy, not the entry price: **B20 checks the 1.5 R again with the real fill** (and applies the 1.0 R to 3.0 R bounds of `EP3_STRUCTURE`; the strategy only passes the target on, as `facts.target`). `STOP_OK` decides whether the distance to the stop is allowed.

**Setup key.** `pattern_breakout:5m:15m:<pattern as the real chart shows it>:<UTC time of its first point>:<UTC time of its last point>@<UTC time of the break candle>`, for example `pattern_breakout:5m:15m:DOUBLE_BOTTOM:2026-10-23T04:00:00Z:2026-10-23T07:00:00Z@2026-10-23T09:35:00Z`. The ids of the pattern module are positions in the series and change when a process restarts, so the pattern is named by its points ("pattern id" of section 7.E).

**Alerts.** E is off for Telegram by default until its first B28 report (section 7, alert policy); it runs in shadow mode.

**To review in the research phases (B27 onward).** Not loosened here: that the patterns are on the 15m chart (5m is the alternative), that a pattern is broken once in either direction, one idea per candle (largest measured move), that a break seen only by a 15m candle is lost, the target measured from the close and not from the fill, and that triangles and rectangles break in both directions.

### 7.6 Strategy F, details (the hourly paper strategy)

Code: `packages/core/src/strategies/hourlyTrend` (`judgeTrend`, `trendStop`, `HourlyTrendStrategy`, `HOURLY_TREND_DEFAULTS`) and `hourlyTrendParamsOf` in `packages/config`. Its six params (the three averages, the ATR period, `stopAtr1h` 2.5 and `everyMin` 30) are all in the strategy config.

**Why it exists, and what it is not.** The owner wants a signal about every hour. The 5m strategies A to E wait for a pullback, a sweep or a retest and speak a few times a month. A study on the training years (2022 to 2024, hourly decisions, 27 rule families, 3 stops, 2 windows, 4 exits, costs of 0.20 spread and 0.05 slippage) found no rule with a stable edge at the hourly scale: always-on trend and momentum rules are about zero R, and the one positive setting (a 10-hour Donchian break) is +0.008 R. F is therefore a **paper** strategy: a plain trend filter that makes signals to follow on a demo account. It is not an edge. The messages say `FORWARD-TEST` as for the others, and its evidence builds up like theirs.

**Interface.** `update(tf, candle)` for the 1h candles (the averages and the ATR) and the 5m candles (the slot clock and the price); the 15m candles are not used. `evaluate()` answers for the newest 5m candle: a setup when its close is a slot (a multiple of `everyMin` minutes), the newest closed 1h candle is less than an hour old (a weekend gap leaves none) and the trend is clear. The engine feeds the 1h candle that closes together with a 5m candle first, so at :00 the new hour is already in. SELL is the exact mirror of BUY.

**The quality score of F.** The groups of section 8 were made for the 5m strategies: the stop and the target are scored in ATR(5m) bands that a stop in ATR(1h) never meets (execution and reward are 0 for every F setup), and there is no pullback or trigger candle. With the default weights 1.5 percent of the setups reached 65 (the TRAIN replay found 193 signals in 3 years). F therefore weighs the groups it can speak about: trend 0.50, session and macro 0.29, volatility 0.12, structure 0.05, trigger 0.02, execution and reward 0.01 each. The score does not predict the result of F (the correlation of every group with R is below 0.1 in absolute value); it only decides how many setups become signals. With these weights about 55 percent do.

**What the replay says** (`reports/backtest-20261117-101020.md`, TRAIN, and `reports/backtest-20261117-101249.md`, VALIDATION; the first look at 2025, the test year 2026 not read): TRAIN 14,064 signals in 3 years (about 18 a day, 0.75 an hour in the 23 hours of trading), expectancy -0.001 R in scenario A (-0.027 R in B, -0.016 R in C), profit factor 1.00. VALIDATION (2025) 5,513 signals, +0.023 R in A, +0.012 R in B, +0.007 R in C, profit factor 1.11, the gate says PASS. This is **not** proof of an edge: the signals are 30 minutes apart and mostly in the same direction (so they are not independent, and the longest drawdown is 97 to 145 R), 2025 was a strong trend year for gold, over all four years scenario A is +0.006 R and B and C are negative, and several configurations of F (the exit profile, the time stop, the quality weights, the cadence) were looked at on the training years before this one was fixed (the registry holds three runs: two on TRAIN and the one VALIDATION look). The forward test decides.

**To review in the research phases.** The weights (a choice made to let signals through, not a finding), the half-hour cadence, the 2.5 x ATR(1h) stop, the 4-hour time stop (a 12-hour one left about a third of the trades out of the statistics: they met a weekend gap), and the many signals open at once in the same direction (the system has no throttles by design).

**Retired (21 November 2026).** F was run live from 17 to 21 November to test the whole chain, and is no longer run (`RETIRED_STRATEGY_KEYS` in `packages/core/src/domain.ts`: the worker does not register it, the lists of strategies and the alert switches leave it out). Its key stays in `STRATEGY_KEYS` because its 154 signals are in the database for ever and must still read. What the live days showed: 154 signals, all SELL, 113 counted, 78.8 percent winners, +0.309 R on average, in a market that fell from 3853 to 3523 (about 9 percent) with nothing to lose in it: not an edge, as the replay had said. It also showed what was wrong around it, and these were fixed for every strategy: the stop of 2.5 x ATR(1h) was about 48 USD (the replay had assumed about 18), 39 signals ran into the daily break or the weekend (the time stop is now cut at the market close, section 9.1), a notice of the feed was sent at once whenever a signal was open, which with a strategy that always has signals open meant 97 notices of a stalled feed in 3 days (now 1 minute, `announceAfterOpenMs`), and about 70 messages a day were too many.

### 7.7 Strategy G, details (the confluence, and the study behind it)

Code: `packages/core/src/strategies/confluence` (`votesFor`, `stopPlan`, `ConfluenceStrategy`, `CONFLUENCE_DEFAULTS`) and `confluenceParamsOf` in `packages/config`. Its params (the periods, the number of votes, the body, the ATR floor, the swing, the stop band and the dollar limit, the slot and the session) are all in the strategy config. SELL is the exact mirror of BUY: every vote is a comparison in the direction of the trade, and the tests run the mirrored market.

**Why it exists, and what it is not.** After F was retired the owner asked for 6 to 8 signals a day, a first target of 11 to 15 points, a stop that is not too close (the stops that everybody sees are the ones that get taken), a reward at least as big as the risk, and every indicator used. Before it was built, a study on the training years (2022 to 2024; no bar of 2025 or 2026 was read) tried the rule families that this asks for, entering at the next minute after the close of each 5m candle, with stops and targets in ATR(5m) so that the three years (ATR 0.6 to 2 USD) and today (3 to 5 USD) can be compared: a pullback in the direction of the 1h and 15m trend, a breakout of the last 12 candles with ADX, a reversion from RSI and Bollinger extremes, the breakout of the first half hour of the London and New York sessions, and the vote of nine readings in two thresholds. Each was run with two costs: 0.25 USD a trade (spread and slippage of the old years, 15 percent of an R) and 6 percent of ATR(5m) (the spread today, about 5 percent). Mean R per trade, 2022 to 2024:

| Rule | Signals a day | Mean R, 0.25 USD | Mean R, 6% of ATR |
|---|---|---|---|
| Random entry, stop 3 ATR, target 3 ATR | 10.5 | -0.051 | -0.014 |
| Pullback with the trend, target 2.5 / 3.5 ATR | 4.9 | -0.057 / -0.060 | -0.010 / -0.014 |
| Breakout with ADX, target 2.5 / 3.5 ATR | 1.8 | -0.045 / -0.044 | -0.001 / -0.000 |
| Reversion from RSI and Bollinger extremes | 0.2 | -0.101 / -0.083 | -0.069 / -0.048 |
| Session-open breakout, target 2.5 / 3.5 ATR | 1.2 | -0.025 / -0.037 | +0.008 / -0.005 |
| Vote of 9, 6 or more / 7 or more, target 3 ATR | 11.6 / 6.9 | -0.057 / -0.057 | -0.020 / -0.021 |
| Vote of 7, stop 3 to 4.2 ATR beyond the swing, target 1R / 2R | 5.5 | -0.047 / -0.053 | -0.015 / -0.022 |

Nothing beats a random entry: a vote of nine indicators gives -0.02 R, as the random entry does. Slicing each rule by the ADX of the hour, the session and the volatility (77 slices) found a few that were positive in all three years; about nine of 77 are, by chance, so none was used. This agrees with the yield study of 25 October (`reports/yield-study-20261025.md`): at the 5m scale the price data holds no edge that survives the cost. G is therefore a **paper** strategy, built to the shape the owner asked for; the study itself is in the history of this section, the scratch program was not kept.

**What the replay of the engine says** (`reports/backtest-20261121-074657.md`, TRAIN only, 1 trial in the registry for G): 3,433 signals in 3 years (3.7 a day), win rate 46.9 percent (45 to 49), expectancy -0.038 R in scenario A, -0.034 R in B, -0.080 R in C, profit factor 0.90; no half year above +0.03 R. The gate says FAIL. The spread of the replay is 0.20 USD, 18 percent of ATR(5m) of those years, and today it is about 5 percent, so the costs of the replay are about 0.03 R a trade too large for today: the expectation is about zero, before luck. VALIDATION (2025) was not looked at: there is no result on TRAIN worth confirming, and the one look is kept. The forward test decides: the evidence line of the messages fills in as signals close, and the status stays `RESEARCH` until a gate is passed.

**What the owner asked for, and what G gives.** 6 to 8 a day: about 3 to 4 (7 of 9 votes, and the quality score keeps about half of the setups); more votes would add signals and cost, not edge. A first target of 11 to 15 points: 1R, which is the stop, 3 to 4.2 ATR(5m): 10 to 16 USD at an ATR of 3 to 4; a stop wider than 16 USD is not taken. "No loss": not possible; a win rate of about 47 percent at 1:1 means that more than half of the trades lose. The messages say `FORWARD-TEST (paper)` and the style (INTRADAY, up to 2 hours).

**To review in the research phases.** The number of votes and the 30-minute slot (a choice made for the number of signals, not a finding), the session, the 16 USD limit (a choice, not a finding), the MACD vote (which is about zero for a market that only trends), and the time stop of 2 hours (43 percent of the trades in the study ended by it).

## 8. Quality score

Grouped, not a count of indicators. Each group returns a state and a strength in [0,1]; the weighted sum is scaled to 0-100.

| Group | Weight | Inputs |
|---|---|---|
| Trend | 0.22 | 1h EMA order and slope, ADX, Supertrend agreement |
| Structure | 0.22 | 15m/5m structure alignment, BOS/CHoCH, sweep quality, trendline and zone confluence, pattern quality |
| Trigger and momentum | 0.14 | trigger candle quality, RSI reset, MACD histogram |
| Volatility | 0.10 | ATR percentile in the preferred band, squeeze state |
| Execution | 0.12 | spread percentile, stop size vs ATR |
| Session and macro | 0.12 | session suitability, time to next high-impact event |
| Reward feasibility | 0.08 | TP distance vs ATR, room to opposing levels |

Group states: `STRONG` (>= 0.75), `OK` (0.5-0.75), `WEAK` (0.25-0.5), `FAIL` (< 0.25), `NA` (data unavailable). If a group is `NA`, its weight is redistributed over the others, and at least 70% of total weight must be available or the signal is blocked.

Grades: 65-74 Moderate, 75-89 Strong, 90+ Very strong. The score is a setup-quality measure, not a probability.

### 8.1 Quality score, details (B20)

Code: `packages/core/src/scoring` (`ramp`, `band`, `meanOf`, the seven group functions, `qualityStrengths`, `scoreQuality`) and `qualityWeightsOf` in `packages/config`. The weights and the group states above are fixed. **The formulas that turn the facts of a setup into a strength are hypotheses of this phase**, like the thresholds of the strategies: they are not tuned by feeling but on training data in B27/B28, and a change is a new strategy version.

**Shape.** A component is a `ramp(value, zero, full)` (0 at `zero`, 1 at `full`, a straight line between, nothing beyond; lower is better when `full` is below `zero`) or a `band` (0 at the first number, 1 from the second to the third, 0 again at the fourth). The strength of a group is the mean of its components that have data; a group with no component with data is `NA`.

| Group | Components (each 0 to 1) |
|---|---|
| Trend | EMA order: each of the pairs 20/50 and 50/200 in the order of the trade gives 0.5. Slope of the 1h EMA 50 over 3 hours in ATR(1h), signed to the trade: ramp 0 to 0.5. ADX(1h): ramp 15 to 35, and 0 when the DI points the other way. Supertrend: 1 with the trade, 0 against |
| Structure | 15m and 5m state (1 with the trade, 0.5 range, 0 against; the mean of the two). Newest BOS/CHoCH: with 1, none 0.5, against 0. Sweep (strategy B only): the mean of the depth, ramp 0.1 to 0.6 ATR, and the wick, ramp 50 to 80 percent. Confluence of trendlines and zones: ramp 0 to 2. Pattern (strategy E only): measured move in R, ramp 1.5 to 3 |
| Trigger and momentum | Range of the trigger candle in ATR(5m): ramp 0.6 to 1.6. Close location towards the trade: ramp 0.5 to 0.9 (a SELL uses 1 minus the location). RSI reset away from the pullback extreme: ramp 5 to 20 points. MACD histogram candles in a row in the direction of the trade: ramp 0 to 3 |
| Volatility | ATR percentile: band 10, 30, 70, 90. Squeeze: just released 1, none 0.7, still on 0.3 |
| Execution | Spread percentile: ramp 95 to 40 (1 up to the 40th, 0 from the 95th). Stop distance in ATR: band 0.8, 1.1, 1.7, 2.0 (the outer numbers are the limits of `STOP_OK`) |
| Session and macro | Session: London 1, overlap 1, New York 0.9, Asia 0.5, rollover 0.2. News: inside a window 0, unknown left out, clear with no event known 1, else ramp 45 to 240 minutes to the next event |
| Reward feasibility | Distance to TP1 in ATR(5m): ramp 2.5 to 1.5 (2.5 is the limit of `TARGET_OK`). Room to the nearest opposing level as a multiple of the distance to TP1: ramp 0.5 to 1.2, and 1 when no level is ahead |

**Score.** `scoreQuality` rounds each strength to 4 decimals first (so the stored state always agrees with the stored strength), then score = 100 x the sum of weight x strength over the groups with data, divided by the weight of those groups, rounded to 2 decimals. `coverage` is the weight with data over the total weight; the gate `QUALITY_OK` (section 6) takes both. The grade is by the bands above, and none below 65. It refuses (throws on) a strength outside 0 to 1 or a weight that is negative or not finite.

**Sides.** A SELL is the BUY seen upside down: what the chart shows as it is (the EMAs, the slope, the DI, where the candle closed, the RSI, the MACD run, the 15m and 5m state) is mirrored by the side, and what is relative to the trade (the break event, the spread, the ATR) is not. A test feeds mirrored facts and expects equal strengths.

**To review in the research phases (B27 onward).** Every number above; whether the components of a group should have equal weight; ADX counting 0 (not negative) when the DI is against; the session map; the news ramp.

## 9. Risk, exit profiles, entry and fill model

V1 uses market entries only, confirmed at the 5m candle close.

- `entry`: ask for BUY, bid for SELL at the confirming tick.
- Simulated fill = `entry` plus `simSlippage` adverse (default 0.05 USD). All outcome math uses the fill.
- `maxValidEntry`: entry plus min(0.15 x ATR(5m), 0.25 x risk distance) for BUY (minus for SELL). Beyond this the owner should skip the trade.
- `entryValidUntil`: 3 minutes after the signal.
- Risk distance R = |fill - stop|. With a delayed fill the unit stays the risk distance of the signal (section 9.1).

**Owner execution cost (decision of 2026-10-24, built in B20, used in B28).** The owner places the order by hand: later than the confirming tick and at a worse price than a fill at that tick. The paper statistics must not hide that. The fill model therefore has two inputs, both configurable per strategy version: `simSlippageUsd` (default 0.05, as above) and `execDelaySec` (default 0; B20 added it to `risk` of the strategy config). With a delay the simulated fill is the first tick at or after the signal time plus the delay (ask for a BUY, bid for a SELL) plus the slippage. If the price at that moment is already beyond `maxValidEntry`, or the entry validity has run out, the owner would have skipped the trade, so it is counted as skipped and not as a trade. Live signals keep the defaults (the confirming tick); the delay matters for the cost scenarios of section 15.

Exit profiles are a finite, predefined list, chosen by the strategy configuration. The live engine never searches for TP/SL combinations.

| Profile | Rule |
|---|---|
| `EP1_PARTIAL` (default) | Close 50% at TP1 = 1.0R, move stop to entry, runner to TP2 = 2.0R, time stop 120 min |
| `EP2_SINGLE` | Single target at 1.5R, time stop 120 min |
| `EP3_STRUCTURE` | Target at the nearest opposing liquidity or structure level, bounded to 1.0R-3.0R |

Targets are evaluated on the closing side: a BUY stops out when bid <= stop and takes profit when bid >= target; a SELL stops out when ask >= stop and takes profit when ask <= target. If stop and target are both crossed in the same tick, the stop wins (conservative). A gap through the stop fills at the actual tick price (slippage is recorded).

R accounting for `EP1_PARTIAL`:
- Loss before TP1: -1R (actual fill based).
- TP1 then stop at entry: +0.5R (`PARTIAL_WIN`).
- TP1 then TP2: +1.5R (`WIN`).
- Time stop: close at the current price; R is whatever it is (`TIME_EXIT`).
- Costs: spread is inside bid/ask fills. An optional `commissionUsdPerOz` (default 0) is subtracted as R. `realized_r_net` is what statistics use.
- A trade is a win in statistics when `realized_r_net > 0`.

### 9.1 Trade model, details (B20)

Code: `packages/core/src/trade` (`planTrade`, `findFill`, `tradeSpecOf`, `TradeTracker`, `cancelledOutcome`, `RISK_DEFAULTS`, `COST_SCENARIOS`) and `riskParamsOf` in `packages/config`. It is pure (no I/O): B23 feeds it the ticks from Postgres, B28 the ticks or the bars of history.

**The plan** (`planTrade`), made at the decision:
- `entry` (the fill of a live signal) = ask for a BUY, bid for a SELL of the confirming tick, plus the slippage against the trade, at 3 decimals. R = |entry - stop|. A stop that is not beyond the entry gives no plan (`STOP_NOT_BEYOND_ENTRY`).
- `maxValidEntry` = entry plus (minus for a SELL) min(`maxChaseAtr` x ATR(5m), `maxChaseRiskFraction` x R).
- Levels: `EP1_PARTIAL` TP1 at 1R and TP2 at 2R; `EP2_SINGLE` TP1 at 1.5R; `EP3_STRUCTURE` TP1 at the structure target in R, bounded to 1.0R-3.0R, and 3.0R when no level is known.
- Strategy E's 1.5R rule is checked again with the real entry (`minMeasuredMoveR`; `MEASURED_MOVE_TOO_SMALL` when not enough), as 7.5 says.
- `entryValidUntil` = decision + `entryValidSec`; `timeStopAt` = decision + `timeStopMin` (from the decision, not from the fill), **but never later than 5 minutes before the next close of the market** (17:00 New York time: the daily break, or the weekend from Friday). `costR` = `commissionUsdPerOz` / R, once per trade, even with a partial.
- The market close (`nextMarketClose`, `packages/core/src/time/marketHours.ts`): a trade that is open through a close cannot be followed (the feed has no price, and a gap of more than 60 s ends the tracking as `DATA_INVALID`). The live check of 17 to 21 November 2026 found 39 of 154 signals invalid for this reason, and the owner had been alerted to every one. So the time stop is cut at the close, and when that leaves the trade less than 20 minutes to run (`MIN_HOLD_MIN`) there is no signal: the plan is refused with `MARKET_CLOSING`, which the engine records as a `TARGET_OK` failure (there is not the time to reach a target).

**The fill** (`findFill`). The order is placed at decision + `execDelaySec`, and the fill is the first tick at or after that moment, at the ask (BUY) or bid (SELL) plus the slippage. The owner would skip the trade, and it is a skip (counted as a skipped trade, never as an outcome, so the statistics can say how many were missed), when: the order time or the first tick after it is later than `entryValidUntil` (a tick exactly at it is in time; `ENTRY_EXPIRED`), the fill is strictly beyond `maxValidEntry` (equal is fine; `BEYOND_MAX_VALID_ENTRY`), the fill is at or through the stop (`BEYOND_STOP`), or there is no tick (`NO_TICK`). With a delay of 0 the fill is the confirming tick and equals the `entry` of the signal.

**The unit R stays the one of the signal.** With a late fill the stop and the targets stay where the signal put them, and the unit of every result is still the risk distance of the signal. The price of being late shows as a bigger loss (more than 1R) and smaller wins, not as a changed unit (decision of B20; with a delay of 0 it is the same as R = |fill - stop|). The cost scenarios of section 15 are `COST_SCENARIOS`: A 0.05 USD and 0 s, B 0.30 USD and 0 s, C 0.05 USD and 20 s; B28 shows all three.

**The tracker** (`TradeTracker`). It is fed, in time order from the fill on, with ticks (`observeTick`: the bid for a BUY, the ask for a SELL) or with stretches of closing-side prices (`observe`: open, high and low of a bar), and returns the events of the signal log (`TP1_HIT`, `STOP_MOVED_TO_ENTRY`, `TP2_HIT`, `SL_HIT`, `TIME_EXIT`, `DATA_INVALID`) and, at the end, the outcome with the fields of `signal_outcomes`. The rules:
1. In a stretch the order is: feed gap, time stop, stop, TP1, TP2 (after the stop moved).
2. The stop is hit when the low reaches it. It fills at the open of the stretch when that is already through it (a gap, or the price of a tick), else at the stop. A target is hit when the high reaches it and fills at the target, never better: a tick that jumps past TP2 still pays TP2 (conservative).
3. A stop and a target crossed in the same stretch: the stop wins and `ambiguous` is set. A tick is one price, so this only happens with bars (B28).
4. `EP1_PARTIAL`: at TP1 half is closed and the stop moves to the actual fill. Then TP2 gives `WIN` (1.5R) and the stop at the entry gives `PARTIAL_WIN` (+0.5R, less when gapped through). `EP2_SINGLE` and `EP3_STRUCTURE`: reaching the target is a `WIN` (reason `TARGET`).
5. The first stretch at or after `timeStopAt` closes the trade at its open, before anything else; only that open counts for the excursions. The result is `TIME_EXIT`, with the R it has.
6. A gap of more than 60 s between stretches (or from the fill to the first one) closes the trade as `DATA_INVALID`: not counted, R and costs empty, and the tick after the gap is not used.
7. net = gross - `costR`; `isWin` is net > 0 after rounding (a net that rounds to 0.000 is not a win). `WIN`, `PARTIAL_WIN`, `LOSS` and `TIME_EXIT` count in the statistics.
8. MFE is 0 or more and MAE 0 or less, in R, from the fill to the close, at the real extreme (also beyond the stop inside a bar). Prices and R have 3 decimals and are never -0.
9. A SELL is the exact mirror of a BUY.

The tests: each rule for both sides, a from-scratch first-passage reference over 4000 random tick paths (all result classes, both sides, every profile), and the contract tests that parse the output with the schemas of the API.

**To review in the research phases (B27 onward).** Not loosened here: targets filled at the target price and not at the next tick, gaps filled at the price seen, the time stop counted from the decision, 3.0R when `EP3_STRUCTURE` has no level, the commission once per trade, a skip when the fill is only a little beyond `maxValidEntry`, and the 60 s limit for a feed gap.

### 9.2 Trade style and how long to stay

Code: `packages/core/src/trade/style.ts` (`tradeStyleOf`, `tradeStyleOfTimes`). Every signal carries a name that tells the owner how long the trade is meant to last, so that he knows how long he has to watch it and when to stop waiting: **SCALP** when the time stop is at most 45 minutes after the signal, **INTRADAY** up to 6 hours, **SWING** beyond that. The number that counts is the time stop: a trade that has not worked by then is closed (rule 5 above), so the owner never has to stay longer than it says. The style is not stored: it is read from `generatedAt` and `timeStopAt`, so it is the same in Telegram, the dashboard and a replay. The entry alert shows it with the time (`INTRADAY: a trade of a few hours. Plan to stay up to 2 h (until 13:35 IST) ...`). A SWING needs a tracker that can follow a trade across the daily break and the weekend; until the tracker can do that (the 60 s gap rule above), a time stop is cut at the market close (9.1), so in practice no signal is a SWING yet.

## 10. Signal policy

There are no throttles. Signals are produced at any hour and in any number, regardless of how earlier signals ended.

- No daily cap, no cooldown timer, no loss-streak pause, no limit on open signals, no session or time-of-day block.
- Duplicate suppression only: a setup instance (the same pullback leg, sweep, trendline break or pattern, identified by `setup_key`) produces at most one signal per strategy and side. This stops the same idea from firing on consecutive candles. It is not a time-based throttle.
- Signals may overlap. Each open signal is tracked independently with its own R. A signal that opposes an open one is still sent, with the warning `OPPOSES_OPEN`. Every alert shows the open-signal count and the total open risk in R, so the owner can decide which to take.
- Each signal stores `open_signals_at_entry`, because simultaneous trades are correlated and Analytics can report them separately.
- The system pauses only when the owner presses Pause (dashboard or `/pause`). A paused system still records data and tracks open signals.
- A setup that satisfies the strategy rules but fails a blocking gate is written to `rejections` (30-day retention). The dashboard uses it to show "WAIT: spread too high" with the reason codes.

### 10.1 Decision engine, as built (B26b)

Code: `packages/core/src/engine` (pure: `DecisionEngine`, `MarketTracker`, `mergeByClose`, `runnerOf`, `qualityInputsOf`, `confluenceOf`, `levelRoomOf`, `chartObjectsOf`, `engineStateOf`), `packages/config/src/engineSpec.ts` (`strategySpecOf`: the strategy config and its status become a `StrategySpec`), `apps/worker/src/engine` (`DecisionLoop`, the ports `CandleSource`, `QuoteSource` and `EngineStore`, `PostgresEngineStore`, `calendarContextOf`). `main.ts` builds the loop after the recorder, the lifecycle, the calendar and the news readers, and the recorder wakes it (`onPersistedCandles`).

**One engine, three callers.** `decide` already names the flag function of section 6, so the class is `DecisionEngine` and its result `EngineDecision`. The engine is incremental: closed candles of 5m, 15m and 1h are fed in the order of their close time (on a tie 1h, then 15m, then 5m), and the regime tracker, the structure trackers, the liquidity book, the trendline tracker, the indicators and the five strategies keep their own state. A pure replay is the same feed, so the warm-up, the live loop and the backtester (B28) share one code path. Nothing reads a candle that has not closed, so there is no look-ahead.

**What one decision does.** For the newest 5m candle (and the confirming quote): the five strategies list their candidates; for each one the plan (section 9), the gates and flags (section 6), the quality inputs and the score (section 8), the evidence (section 13) and the explanation (section 14) are made, and the result is a signal draft or a rejection. A candidate whose plan fails is a rejection with the gate it maps to (`STOP_NOT_BEYOND_ENTRY` is `STOP_OK`, `MEASURED_MOVE_TOO_SMALL` is `TARGET_OK`; `detail.reason` keeps the original). An unknown regime counts as `UNCERTAIN` and an unknown volatility bucket as `NORMAL`. A signal created earlier in the same pass counts as open for the next candidate (`riskR` 1), so `OPPOSES_OPEN` and the open-signal line are right when two strategies fire together. Evidence is given by the caller: `candidates()` lists the groups, the worker prefetches them with `store.evidence` and `decide` takes a synchronous lookup, which keeps the engine pure.

**Quality inputs (decisions of B26b).**
- `atrPercentile` and the squeeze state come from the regime snapshot: `ON` while `squeezeDuration` is above 0, `RELEASED` if released fewer than 6 bars ago, else `NONE`.
- The break event is the newest BOS or CHoCH of the 5m structure within 24 candles.
- Confluence counts the 15m support (BUY) or resistance (SELL) trendline within 0.5 x ATR(15m) of the entry, plus the zones of the matching role around the entry.
- Level room is the distance to the nearest level ahead (liquidity levels, zones with 3 touches or more, round numbers of 50 and 100) over the TP1 distance.
- The RSI extreme is the lowest (BUY) or highest (SELL) of the last 12 values; the MACD run is the signed count of consecutive histogram changes.
- The spread percentile is the share of the last 288 spreads of 5m candles at or below the spread of the quote (it needs 30 or more candles, otherwise it is unknown).
- Prices in the draft and in the chart objects are rounded to 3 decimals (`roundPrice`), as `signalDraftSchema` demands.

**The worker loop.**
- *Warm-up.* `warmUp()` replays the stored history (5m 1500, 15m 2000, 1h 900 candles by default) without deciding. A history at start is never decided. Until the engine has 900 candles of 5m, 1440 of 15m and 600 of 1h the `WARMUP` gate blocks signals and the wait reason says how far it is. The bootstrap of that history is built (B27, section 2.1).
- *Following the table.* `runOnce()` reads the candles after a cursor of all three timeframes in one SQL statement, so the 15m or 1h candle that closes with a 5m candle is never missing in the pass that holds that 5m candle, and feeds them in close order. The recorder wakes the loop after it stores candles.
- *Deciding.* Only the newest 5m candle is decided, and only while it closed at most 5 minutes ago. The decision uses the first quote at or after the close (`ts >= closeTime`) from `ticks`: the recorder writes a candle and its closing tick in one batch. That quote must come within the entry validity. A candle whose reads of the context (controls, calendar, news, open signals, evidence) failed stays pending and is tried again. If the owner has paused, the loop stores the engine state and creates nothing.
- *Signals and rejections.* A signal goes through `SignalCreator.create` (which parses the draft with `signalDraftSchema`; the strategies are registered at start). A rejection goes to `rejections` (`failed_gates`, `detail` with the `setupKey`). A failure to save the engine state is logged and never blocks a signal.
- *Context.* The calendar is read from `macro_events` (`between(now - 3 h, now + 8 h)`, with the time of the last good reading and `calendarAvailable`), the headlines from `NewsContextReader`, the owner's advisory switches from `app_settings.advisoryGates` (a bad value stops the loop with an error rather than being guessed) and the pause from `app_settings.engine`.
- *`ContextSource` of the reviews.* `DecisionLoop.contextOf(trade, closedAt)` gives the regime at the close and the 15m and 1h changes of character from the logs of the market tracker (1000 closes of regime, 200 changes of character), so `REGIME_SHIFT` and `HTF_STRUCTURE_BREAK` of section 12 work. For a trade older than the logs it is silent, as before.

**Engine state for the owner.** After every pass the loop stores `app_settings.engineState` (`evaluatedAt`, `regime`, `volBucket`, `session`, `newsState`, `atr5`, `warmup` with `ready`, `progressPct` and `missingTimeframes`, and `waitReasons` with a code and a label each). `/status` shows the regime and `/open` the wait reasons from it while it is at most 12 hours old (otherwise "not known yet"); the API (B30) serves the same document to the dashboard.

**Known gaps.** `researchOnly` facts (DXY, silver) are empty until a source exists. Strategy status comes from the stored strategy version. **To review in the research phases.** The 5 minute decision window and the first-quote rule; the thresholds of confluence, level room and the squeeze state above; whether the engine should skip a candle instead of deciding when the 15m or 1h candle of the same close is late.

## 11. Outcome tracking

The outcome tracker consumes every tick for open signals.

States: `ACTIVE` -> `TP1_HIT` -> `CLOSED`, or `ACTIVE` -> `CLOSED`. Several signals can be open at the same time; the tracker evaluates each one independently on every tick.

Final results:

| Result | Meaning | Counts in win rate |
|---|---|---|
| `WIN` | TP2 reached (EP1) or single target reached | yes (win) |
| `PARTIAL_WIN` | TP1 reached then stopped at entry | yes (win if net R > 0) |
| `LOSS` | Stop hit before TP1 | yes (loss) |
| `TIME_EXIT` | Time stop reached | yes, by sign of net R |
| `CANCELLED` | Market data went stale during the entry-validity window, so the signal could not be tracked from the start | no, reported separately |
| `DATA_INVALID` | Feed gap longer than 60 s during the trade | no, reported separately |

Each close records exit price, exit reason, gross and net R, duration, MFE and MAE in R, whether TP1 and TP2 were hit, and an `ambiguous` flag if the stop and target were crossed in the same tick.

### 11.1 Lifecycle, details (B23)

Code: `packages/core/src/lifecycle` (pure: `OpenTrade`, `replayTrade`, `atrRatioMaxOf`, `newSignalChannels`, `followUpChannels`, `signalOutboxRows`) and `apps/worker/src/lifecycle` (the database side: `SignalCreator`, `OutcomeTracker`, `PostgresLifecycleStore`, `DatabaseCourseSource`). `MemoryLifecycleStore` is the same store in memory for unit tests; one contract test file runs against both, so the unit tests rely on what the database really does.

**The signal transaction** (`SignalCreator.create`, HLD section 5 step 4). The draft is checked against `signalDraftSchema`, the strategy version must be registered (`registerStrategies` stores the version row; a changed config under an existing version is refused, because a version is immutable), and the owner's settings decide who is told. One transaction then writes the `signals` row, its `signal_state` (ACTIVE), the `CREATED` event, the entry alerts of `notification_outbox` (written once the database has given the signal its number, because the text says `S-0042`), and an `ALERT_QUEUED` event when there are alerts, and sends `NOTIFY vmgs_signals` with `{id, change: "created"}`. A setup that already has a signal for the strategy version and side (`signals_setup_once_idx`) writes nothing and answers `DUPLICATE`; a failure of any part writes nothing at all. The tracker is told after the commit (`onCreated`), and catches the signal up with the ticks stored since its fill.

**Who is told** (`newSignalChannels`, `followUpChannels`). The entry alert goes to a channel that is enabled, whose minimum grade the signal reaches, and (Telegram) whose kinds include `SIGNAL_NEW`; a strategy whose alert switch is off runs in shadow mode: its signals are stored and followed and nobody is told. Every later message (TP1, result, cancellation, final review) goes only to the channels that were told about the entry (read from the `signal:<id>:confirmed` rows), and only while the settings of that moment still allow the channel and, for Telegram, the kind: whoever never saw the signal does not get its result. The text is written into the row at that moment, in the language and zone of the settings then, so the sender only delivers it; the row's `expires_at` is the end of the entry validity for the entry alert and 6 hours later for the others.

**Following the signal** (`OutcomeTracker`). It follows every open signal (one that has a `signal_state` row) on the ticks that are **already stored**: the recorder hands a batch of ticks over after it was written (`onPersistedTicks`), so the state of a signal is always a function of the tick table and about one second behind the feed (the flush interval of the recorder). Ticks, new signals, the clock and the reviews run one after the other in one lane. For each signal `OpenTrade` wraps the `TradeTracker` of section 9.1: it leaves out ticks at or before the fill (the second of the fill itself, a blind second after it, because source times have a resolution of one second and the confirming tick cannot be told from a later tick of that second) and ticks older than the newest one used. What a batch did is one transaction: the new events (an event type is written once for a signal), the working state or the closing, and the messages (`UNIQUE(event_key, channel)` makes a repeat harmless). Changes of the excursions alone are written at most every 5 seconds; events at once. Closing writes the outcome (immutable) and deletes the working state in the same transaction, and a signal that is already closed is never written again.

**Cancelled.** The signal could not be followed from the start: the feed was silent for longer than `gates.maxTickAgeSec` (10 s, from the strategy version) and the silence became stale before `entryValidUntil`, while the trade had not reached TP1. The outcome is `CANCELLED` (not counted, no review), closed at the instant the silence became stale (the last tick plus the limit), so the same ticks always give the same record; the message says how long the silence was (`staleSeconds`). Once TP1 was hit the trade is real, and only the gap rule applies.

**Data invalid, without a tick.** A silence longer than 60 s closes the trade as `DATA_INVALID` (section 11), also when no tick comes to show it: the tracker looks at the clock every second (`observeClock`), using the source time the feed would show now (its newest tick plus the time since that tick came; before any tick, the confirming tick plus the time since the signal was written), and closes the trade at the instant the limit was passed (the last tick plus 60 s). A trade must not stay open over a weekend or while the worker was down. The same silence is a cancel inside the entry window and a gap after it.

**Restart recovery** (`OutcomeTracker.start`, before the recorder starts). It loads every open signal and runs the stored ticks through each from its fill, in the order they were received (`rx_at`, then source time), then writes what is new (events already in the log are skipped, messages already queued are skipped by their key) and goes on. Because the tracker only follows stored ticks, this reproduces exactly what the dead process had written, plus what it had stored and not yet followed (a trade that the stored ticks already closed is closed with the time of those ticks). A restart that takes more than the limits is a silence like any other: a signal in its entry window is cancelled, a long gap makes the trade `DATA_INVALID`. A write that fails stops the tracker (the process exits and recovers on restart); it never goes on with a state that the database does not have. The tests restart the worker at every point of random feeds, with and without ticks stored but not followed, and require the same events, outcomes, messages and reviews as a worker that never stopped.

**Reviews** (section 12.1). A trade that is reviewed gets its preliminary review inside the closing transaction (`signal_autopsies`, `AUTOPSY_PRELIMINARY`) and the closing message names its cause. The final review is made when the 12 candles of 5m after the close are complete: the first 5m boundary at or after the close plus 60 minutes, plus 10 seconds for the last ticks to be stored; it replaces the preliminary one (`AUTOPSY_FINAL`, `finalized_at`; `computed_at` keeps the time of the first) and queues `SIGNAL_REVIEW_FINAL`. A review that cannot be made does not keep the outcome from being written: the outcome's `meta` says `reviewError` and there is no autopsy. The candles of the counterfactual are made from the stored ticks in the prices of the closing side. The course of the trade (`DatabaseCourseSource`) takes the HIGH-impact events from `macro_events` and the clustered HIGH headlines from `news_items` inside the trade, and the highest ATR(5m) over its median from the stored 5m candles that ended before the exit (so the preliminary and the final review see the same market). **The regime at the close and the 15m and 1h changes of character are not stored anywhere:** they come from a `ContextSource` that the decision loop provides since B26b (it owns the candles and features of the engine, section 10.1); `NO_CONTEXT` (silent `REGIME_SHIFT` and `HTF_STRUCTURE_BREAK`) remains for a trade older than its logs and for tests. The spread of the confirming quote is read from the feature snapshot key `spread` (USD, a number); without it the review counts the spread as 0.

**To review in the research phases (B27 onward).** The one second of delay of following stored ticks; the blind second after the fill; cancelling only before TP1 and at the first stale silence of 10 s; closing a cancelled or gap trade at the instant the limit was passed and not when the next tick came; the 10 second margin of the final review; sending the final review message for every reviewed trade. **Open items:** the decision loop that turns candles into signals (and supplies the context above) is not part of B23: it was built in B26b (section 10.1); the statistics rollups joined the closing transaction in B26 (section 13.2), and `trackedThisMonth` of the final review is now filled from `failure_cause_stats`.

## 12. Post-trade review (failure attribution)

Runs automatically for every non-`WIN` close and for every `PARTIAL_WIN`. It is deterministic, uses stored ticks and candles, and produces a primary cause plus supporting causes with the numbers behind them. It runs twice: `PRELIMINARY` at close and `FINAL` 60 minutes later (so a counterfactual can be observed).

| Cause code | Rule |
|---|---|
| `NO_FOLLOW_THROUGH` | Maximum favourable excursion before close < 0.3R |
| `STOP_HUNT_REVERSAL` | After a stop-out, price reaches the TP1 level within 12 candles of 5m |
| `NEWS_SHOCK` | A HIGH calendar event or a HIGH-impact headline appeared during the trade, or ATR(5m) >= 2.5x median, with an adverse move of at least 1.5 x ATR |
| `HTF_STRUCTURE_BREAK` | 15m or 1h CHoCH against the position before the stop |
| `REGIME_SHIFT` | Regime at close differs from entry (for example trend to range) |
| `LIQUIDITY_DROP` | Loss during the last 30 minutes of a session or in rollover |
| `SPREAD_COST` | Spread/slippage cost >= 25% of risk distance |
| `TIME_DECAY` | Time exit with net R <= 0 |
| `NORMAL_LOSS` | None of the above applies. The loss is within the strategy's expected loss frequency |

Also stored: `weak_groups_at_entry` (quality groups that were `WEAK` or `FAIL`) and the counterfactual (did price later reach TP1 or TP2, how many candles later).

Important: attribution is explanatory and heuristic. It is not proof of cause. The rigorous view is statistical: Analytics aggregates outcomes by evidence group state and by cause with sample size and confidence intervals. Individual stories are not used to tune the strategy.

### 12.1 Post-trade review, details (B22)

Code: `packages/core/src/autopsy` (`reviewTrade`, `needsReview`, `counterfactualOf`, `CAUSE_PRIORITY`, `AUTOPSY_DEFAULTS`). It is pure: the worker (B23) collects what happened and passes it in; the review stores no time (the worker sets `computed_at` and `finalized_at`). Its output is the stored `signal_autopsies` row and has the shape of `autopsySchema`; a contract test parses it and renders it with the B21 messages.

**Which trades are reviewed.** Every `LOSS`, every `PARTIAL_WIN`, and a `TIME_EXIT` that did not make money (net R at or below zero). A `WIN`, a time exit above zero (a win in the statistics), a `CANCELLED` and a `DATA_INVALID` signal have nothing to explain; asking for their review is an error.

**What the review is given.** The trade (side, fill, R, targets, ATR(5m) at the decision, the spread of the confirming quote, the slippage, the regime and the state of every quality group at entry), the outcome of the tracker, and what the market did from the fill to the close: the regime at the close, every 15m and 1h change of character seen, the HIGH-impact events and headlines, and the highest ATR(5m) over its 24h median. Prices are real prices, never mirrored. The 5m candles after the close are given only to the final review, in the prices of the closing side (bid for a BUY, ask for a SELL), like the tracker.

**The rules**, with the numbers of `AUTOPSY_DEFAULTS` (hypotheses of v0.1.0, fixed in code like the other rule constants):
- `NO_FOLLOW_THROUGH`: the best move in favour (`mfeR`) was below 0.3 R. At exactly 0.3 R it does not apply. A partial win can never have it (TP1 was reached).
- `STOP_HUNT_REVERSAL`: a `LOSS` after which price reached the TP1 level within 12 5m candles. Only a stop-out counts (not a time exit, and not the stop at the entry after TP1, where TP1 is already behind). It needs the counterfactual, so it exists only in the final review.
- `NEWS_SHOCK`: a HIGH event or headline inside the trade (from the fill to the close, both included) or ATR(5m) at 2.5 x its median or more, **and** a move against the position of at least 1.5 ATR(5m) (the ATR of the decision). The move against the position is the worse of the lowest point (`maeR`) and the give-back from the best point to the exit (`mfeR` less the result of the exit alone), in R, times the risk distance over the ATR. The give-back makes it possible for a partial win to have a shock. The evidence names the earliest event or headline (cut at 80 characters), or `VOLATILITY`.
- `HTF_STRUCTURE_BREAK`: a 15m or 1h change of character against the position (a bearish one against a BUY) after the fill and up to the exit (the exit included). The evidence has the earliest one: timeframe, level, minutes into the trade, and how many there were.
- `REGIME_SHIFT`: the regime at the close is not the regime at entry (any other regime, the opposite trend and `UNCERTAIN` included). A close with no known regime does not count.
- `LIQUIDITY_DROP`: the exit was in `ROLLOVER` (the quiet hours between the close of New York and 21:45 UTC are labelled rollover too), or **every open market** was within 30 minutes of its close. The venue clocks are read, as the `OFF_HOURS` flag does, because a session label does not end with a market: the close of London while New York is open is no drop. The Asia session is not "the end of a session".
- `SPREAD_COST`: the spread of the confirming quote plus the slippage plus the commission (`costR` of the outcome times the risk distance) were at least 25 percent of the risk distance. An unknown spread counts as 0, so missing data cannot raise the cause.
- `TIME_DECAY`: a time exit with net R at or below zero.
- `NORMAL_LOSS`: none of the above applies (its evidence is the best and the worst move in R). It also covers a partial win with no other cause.
Comparisons that are derived thresholds (ATR multiples, shares) ignore the last bit of a float; limits are inclusive as written.

**Which cause is primary (decision of B22; the docs gave no order).** The causes that apply are listed in this order and the first is primary: `STOP_HUNT_REVERSAL`, `NEWS_SHOCK`, `NO_FOLLOW_THROUGH`, `HTF_STRUCTURE_BREAK`, `REGIME_SHIFT`, `LIQUIDITY_DROP`, `SPREAD_COST`, `TIME_DECAY`, `NORMAL_LOSS`. Reasons: a stop that price then ran away from says the idea was right and the stop was not, which is the most useful finding (and is why the final review can replace the preliminary primary cause, as in the example of the notifications document); a shock from outside the setup explains more than the setup's own weakness; `NO_FOLLOW_THROUGH` stays ahead of the structure break, as in the example of section 14; the rest go from the most to the least specific. `NORMAL_LOSS` is never listed with another cause.

**Preliminary and final.** Without candles after the close the review is `PRELIMINARY` and has no counterfactual. With them (an hour later) it is `FINAL`. The counterfactual is whether price reached TP1 (and TP2, when the trade has one) in the 12 candles of 5m that open at or after the close, counted from 1. The candle that holds the close is left out (what it did before the exit belongs to the trade; a reversal inside that candle is therefore not seen, to review). The candles must follow each other without a hole: a target that was not reached in a window that is not fully seen is **unknown**, and then there is no counterfactual (null), not "not reached". A target that was reached is known even if the window is not complete.

**Weak groups at entry** are the groups whose state was `WEAK` or `FAIL`, in the order of the score; `NA` is not weak.

**Mirror.** A SELL is the exact mirror of a BUY: a test runs 3000 random trades and markets (every result kind, holes in the candles, events inside and outside the trade, sessions all day) and checks that the mirrored trade has the same causes, evidence and counterfactual (the level of a break is the mirrored price), that every cause is reached as the primary one, and the invariants (a cause once, in the order of the priority, `NORMAL_LOSS` alone, only JSON values).

**To review in the research phases (B27 onward).** The order of the causes, every number above, `REGIME_SHIFT` counting a change in the trade's favour, the candle that holds the close being left out of the counterfactual, the give-back in the move against the position, the 60 minute wait of the final review, a partial win with no cause being called `NORMAL_LOSS`, and the 12 candle window being the same for `STOP_HUNT_REVERSAL` and the counterfactual.

## 13. Evidence shown with every signal

Historical evidence comes only from recorded outcomes in `stats_bucket`:

- Bucket key: `strategy_key + version | side | session | regime | volatility_bucket`.
- If the exact bucket has fewer than 30 resolved trades, fall back in order: drop volatility bucket, drop regime, drop session, strategy and side only. The UI and Telegram message state which level was used.
- Two scopes are kept separately: `FORWARD` (live paper trades) and `BACKTEST_OOS` (out-of-sample backtest). Forward evidence is preferred when it has at least 30 trades.
- Displayed: win rate, n, Wilson 95% confidence interval, expectancy in R, profit factor, TP1-hit rate, TP2-hit rate.
- n < 30: "Insufficient evidence" with the raw counts. 30 <= n < 100: shown with a "low sample" label. n >= 100: normal.
- A calibrated probability model may be added after at least several hundred forward trades. Until then no probability is invented.

### 13.1 Statistics and evidence, details (B22)

Code: `packages/core/src/stats` (`wilson`, `wilsonInterval`, `BucketCounts`, `addResult`, `mergeCounts`, `countResults`, `rateStats`, `maxDrawdown`, `equityCurve`, `currentStreak`, `summarizeResults`, `bucketKey`, `bucketKeys`, `pickEvidence`). Pure functions: the rollups (B26) and the API (B30) call them, so that the dashboard, the messages and the backtester count the same way. The dashboard's preview statistics are kept equal to them by a test over the simulated history.

**Definitions.** A trade counts in the statistics when its result is `WIN`, `PARTIAL_WIN`, `LOSS` or `TIME_EXIT`; `CANCELLED` and `DATA_INVALID` are counted apart and are in no rate. A *winner* is a counted trade with net R above zero, whatever its result: a partial win whose costs bring it to zero is not a winner and a time exit above zero is. The win rate is winners over counted trades, to 3 decimals. Expectancy is the mean net R (2 decimals). Profit factor is the sum of the gains over the sum of the losses in net R (2 decimals) and is empty while there is no loss. The maximum drawdown is the deepest fall of the running total of net R from its highest point (the total starts at 0, so a first loss is already a fall), in the order the trades closed. The current streak is the run of winners or of non-winners that ends the newest trade. The equity curve has one point for each counted trade.

**Rule C6 in code.** `rateStats` shows the win rate, its interval, the TP1 rate and the TP2 rate only from 30 counted trades. The expectancy and the profit factor are not percentages and are shown at any size in the overview; the evidence shown with a signal hides them too below 30 (section 13: "insufficient evidence" with the raw counts).

**The interval** is the Wilson score interval at 95 percent (z = 1.96), 3 decimals, never outside 0 to 1; at no win the lower end is exactly 0 and at all wins the upper end is exactly 1. It is tested against the published values of Newcombe (1998), against its defining equation, by symmetry and monotonicity.

**Bucket keys.** Five levels, each dropping a key of the one before: 0 `strategy@version|side|session|regime|volatility`, 1 without the volatility, 2 without the regime, 3 `strategy@version|side` (without the session), 4 `strategy|side` (without the version, so a new strategy version starts with the evidence of the old ones until it has 30 trades of its own). `stats_bucket.level` is this number.

**Which bucket is shown (`pickEvidence`; decisions of B22).** The forward buckets are tried from level 0 to 4 and the first with 30 resolved trades is used; only when no forward level has 30 are the backtest buckets tried in the same way. So a coarse forward bucket with 30 trades is preferred to an exact backtest bucket with 300: the section says forward evidence is preferred when it has 30 trades, and the two scopes are never mixed. When no bucket of either scope has 30 trades the evidence is insufficient: scope `FORWARD`, level 4, the counts of that bucket (0 when it has none), and no percentage, interval or other figure. The sample label follows the count (30 to 99 low sample, 100 normal).

**For the rollups of B26.** The counts of a bucket are `BucketCounts` (`n`, `wins` = results `WIN`, `winners`, `partials`, `losses`, `timeExits`, `tp1Hits`, `tp2Hits`, `sumR`, `sumWinR` never negative, `sumLossR` never positive, so that `sumR = sumWinR + sumLossR`). `addResult` adds one closed trade and `mergeCounts` joins two buckets; adding trades one at a time and merging halves give the same counts, which is what "rollups equal a full recomputation" needs. **A gap in the tables of B2, closed in B26:** `stats_bucket` and `stats_monthly` had `wins` (the `WIN` results, as the contract's `resolvedValid = wins + partials + losses + timeExits` needs) but no count of winners, and the win rate cannot be rebuilt from the other columns (a time exit is a winner by the sign of its net R; a partial win may not be). Migration `0003_rollups.sql` added a `winners` column to both tables; `evidence_group_stats.wins` already meant winners.

**To review in the research phases (B27 onward).** Forward evidence at a coarse level being preferred to an exact backtest bucket, the widest forward bucket as the face of "insufficient", the version being dropped only at level 4, and the volatility buckets being thirds (section 5.1).

### 13.2 Rollups, maintenance and reports, as built (B26)

Code: `packages/core/src/rollup` (pure: `closedDelta`, `createdDelta`, `causeChangeDelta`, `RollupTables`, `rollupsOfTrades`, `diffRollups`, `repairRollups`), `packages/core/src/maintenance` (`RETENTION_DAYS`, `readStorage`, `nextTickRetention`, `feedUptime`), `apps/worker/src/rollups` (the SQL and the reconciliation), `apps/worker/src/maintenance` (the jobs, the runner, the PostgreSQL store) and `apps/worker/src/reports` (the scheduler of the digest and the report). Migrations `0003_rollups.sql` and `0004_rollup_roles.sql` (and `03_Data_Model.sql`, which equals `0001` plus `0003`).

**What the rollups count (decisions of B26).**
- Only `mode = 'LIVE'` signals: the forward test. `SIMULATED` (replay) and `BACKTEST` signals are never counted (the backtest has its own scope, `BACKTEST_OOS`, written by B28). The bot's `/today` and `/month` still list every signal that is not a backtest.
- A signal belongs to the **month of its decision time** (`generatedAt`, the first day of that month in UTC for `stats_monthly` and `failure_cause_stats`): a trade that closes after midnight of the next month stays in its generation month, so a month's numbers do not move when an old trade closes. The API (B30) and the reports cut months in the display zone from the signal rows; the rollups are the fast path for the all-time buckets and the analytics page.
- `generated` is added in the transaction that creates the signal; everything else (the 5 bucket levels, the evidence by group state, the monthly rows for `*` and for the strategy, the failure cause) in the transaction that closes it. `CANCELLED` and `DATA_INVALID` add to the monthly `cancelled` and `dataInvalid` only. The final review moves a result from the preliminary cause to the final one under a row lock on the autopsy, so two writers cannot move it twice.
- A winner is a counted trade with net R above zero, whatever its result (section 13.1).
- The tables have sign checks only (`sum_win_r >= 0`, `sum_loss_r <= 0`), no check across columns, so a bug in the rollups cannot block a close; if the rollup write fails, the whole close rolls back (accepted: an uncounted close is worse than a retried one).

**Reconciliation.** Every night the worker takes `SHARE ROW EXCLUSIVE` on the four stats tables (the writers wait a moment), recomputes them in JS from the LIVE signals with their outcomes and autopsies, and repairs every row that differs by more than 0.0005 (it also removes rows that should not exist). The rows of the `BACKTEST_OOS` scope are never touched. The report of a run (signals read, differences, repaired, the first ten differing rows) goes to `maintenance_runs`. Tests hold the tables to a full recomputation after 160 random signals, with final reviews that move causes, 24 concurrent closings and a damaged table.

**Snapshot trimming and the immutability of signals.** A signal is immutable (rule C5), and retention (section 7 of the HLD) trims the feature snapshot after 365 days. The two are reconciled by a narrow exception in the trigger of `signals` (`signals_allow_snapshot_pruning()`): an UPDATE is allowed only when it changes `feature_snapshot` and nothing else, only into a marker with `pruned = true`, and only once. DELETE and TRUNCATE stay forbidden. The worker role has `UPDATE (feature_snapshot) ON signals`, a column privilege and nothing wider. The trimmed marker is `{pruned, prunedAt, spread}`.

**Retention (nightly 03:30 UTC, restart safe).** The reconciliation runs first, then retention, whose steps run in this order, each on its own: ticks (drop the daily partitions older than the tick retention), 1m candles (180 days, batches of 10,000), feature snapshots (365), outbox (sent 30, failed 90), rejections (30), feed incidents (90, open ones kept), headlines (30), market events (365), maintenance runs (90). A step that fails does not stop the others; the run is then recorded as failed (no finish time) and tried again after 30 minutes. Dropping partitions and trimming snapshots are not counted as rows deleted. The expired sessions, login attempts (30 days) and security audit (365 days) are purged by the API process (B29/B30): the worker has no rights on the `auth_*` tables.

**Size guard (hourly).** The share used is the larger of the database size over its soft limit (10 GB, or `DB_SOFT_LIMIT_GB` for a host with a smaller database, such as the 1 GB free Aiven plan: 0.8) and the disk use over its 70% soft limit (`statfs` of the disk the worker runs on). At 80% the tick retention goes one step down the ladder 14, 7, 3, 1 days (stored in `app_settings.tickRetentionDays`; partitions beyond it are dropped, the share is measured again, and it continues while still at or above 80%), a `maintenance_runs` row is written and one `STORAGE_WARNING` a day is queued (`storage:<yyyymmdd>:warning`). It restores one step when the share is under 60%, never in the run that shortened. The warning is queued by the worker, in B26 (the B24 text said B31).

**The reports.** `DAILY_DIGEST` and `MONTHLY_REPORT` are made by `ReportScheduler`, which looks at the clock every minute. The digest is for the trading day (17:00 to 17:00 New York) and is made 10 minutes after it ends; the report is for the month of the display zone that has just ended and is sent from 09:00 of that zone on the 1st, or at the first look after it. A period without a LIVE signal gets nothing. Both are queued under a key named by the period (`report:daily:20261023`, `report:monthly:202610`), so a restart or a second look never sends one twice, and a worker that was away for days sends only the latest period. They expire after 12 hours and 3 days. They are made of the raw signal rows (the same lines as `/today` and `/month`), not of the rollup tables. The data line of the report has the feed uptime (the share of the market's open time without a `DISCONNECT` or `STALE` incident; the weekly closure, Friday 17:00 to Sunday 17:00 New York, is not counted), the size of the database and, once B31 writes the heartbeat `backup`, the age of the last backup ("OK" up to 36 hours).

**To review in the research phases.** The month cut of the rollups (UTC, by decision time); whether the digest should wait for the open signals instead of reporting them as open; the 36 hour backup limit; the 10 GB database budget against the real size after the first forward months.

## 14. Explanation and message formats

The explanation is generated by a pure function from the signal data (no LLM). It produces a structured object stored in `signals.explanation`, rendered as Telegram text and as UI cards.

Structure:

```json
{
  "headline": "BUY XAUUSD - Trend Pullback v0.1.0",
  "quality": {"score": 78, "grade": "Strong"},
  "levels": {"entry": 4017.37, "maxValidEntry": 4017.55, "stop": 4010.90, "tp1": 4023.84, "tp2": 4030.31, "riskUsd": 6.47},
  "groups": [{"key": "trend", "state": "STRONG", "facts": [{"label": "1h EMA", "value": "20>50>200"}, {"label": "ADX(1h)", "value": 31}]}],
  "weak": ["1h momentum flat"],
  "researchOnly": [{"label": "DXY 15m", "value": "-0.2%"}],
  "macro": {"state": "CLEAR", "next": {"name": "CPI", "at": "2026-10-23T12:30:00Z"}},
  "warnings": [],
  "open": {"count": 0, "riskR": 0},
  "evidence": {"scope": "FORWARD", "level": 2, "n": 64, "winRate": 0.58, "ci": [0.46, 0.69], "expectancyR": 0.31, "profitFactor": 1.5}
}
```

Telegram entry alert (plain text, times shown in IST, stored in UTC):

```text
BUY XAUUSD | Trend Pullback v0.1.0 | #S-0042
FORWARD-TEST signal (paper). Manual execution only.

Entry  4017.37   (do not chase above 4017.55)
Stop   4010.90   (-6.47)
TP1    4023.84   (1.0R)  close 50%, move stop to entry
TP2    4030.31   (2.0R)
Valid for 3 min (until 11:43 IST). Time stop 2 h.

Setup quality 78/100 (Strong)
WHY THIS SIGNAL
[+] Trend 1h: EMA20>50>200, ADX 31 rising
[+] Structure 15m: bullish BOS at 4014.2, pullback held 52% of the leg
[+] Trendline 15m: ascending support line, 3 touches, held at 4015.6
[+] Trigger 5m: closed above EMA20 after RSI reset 38 -> 54, displacement 1.4 x ATR
[+] Momentum: MACD histogram rising 3 candles
[+] Volatility: ATR 4.3 (62nd percentile), no squeeze
[+] Execution: spread 0.17 (35th percentile)
[+] Macro: no high-impact USD event for 4 h (next: CPI 18:00 IST)
[~] Weak: 1h momentum flat, London close in 40 min
[?] Research only (not used): DXY -0.2% (15m), silver +0.3%
[!] Warnings: none
News (last 60 min): no high-impact headline
Open signals now: none (open risk 0R)

EVIDENCE (same setup type)
Win rate 58%  (n=64, 95% CI 46-69%)  Expectancy +0.31R  PF 1.5
Source: forward paper trades. Match: strategy + side + session. Low sample.
This is a historical frequency, not a guarantee. 1R = 6.47 USD per oz.
```

Result alert after a loss:

```text
LOSS #S-0042  -1.04R  (stop 4010.90 hit 11:58 IST, 15 min after entry)
WHY IT FAILED (automatic review, preliminary)
Primary: NO_FOLLOW_THROUGH - best move in favour was +0.2R
Also: 15m CHoCH at 4012.10 (11:51 IST)
Weak at entry: 1h momentum
Final review in 60 min (checks whether price reached TP1 later).
Attribution is heuristic. Judge the strategy by the statistics in Analytics.
```

Other messages: TP1 hit (with the instruction to move the stop), TP2 hit, time exit, cancelled (with reason), final review update, system degraded/recovered, high-impact event upcoming (30 min before, signals paused), daily digest, weekly and monthly report.

Messages have `expires_at`. An entry alert not delivered within its validity window is dropped and marked `EXPIRED`.

The examples of this section are illustrative. **The exact layout is fixed by the golden tests of B21 and described in 14.1**; where an example differs from it (the label line comes first, prices have 3 decimals, every group line carries its state word), 14.1 is the rule.

### 14.1 Explanation and messages, details (B21)

Code: `packages/core/src/explain` (`buildExplanation`, `groupFacts`, `setupFacts`, `weakItems`, `warningsOf`) and `packages/core/src/messages` (`renderSignalNew`, `renderSignalTp1`, `renderSignalClosed`, `renderSignalCancelled`, `renderFinalReview`, the Web Push builders, `WORDS`, `escapeHtml`, `fitMessage`). Everything is pure: no I/O, no clock (the display zone is an argument). The stored explanation has the shape of `explanationSchema` of the contracts; a contract test parses what the builder makes and passes the parsed JSON back into the formatters, so the two cannot drift.

**The explanation.** It is built from the same facts that were scored (`QualityInputs`), so the "why" cannot say something the score did not see.
- *Groups.* One entry per group, in the order of section 8, with the state of the score and the real numbers: trend (EMA order such as `20>50>200` as the chart shows it, EMA 50 slope, ADX with +DI and -DI, Supertrend), structure (15m and 5m state, latest break, sweep, confluence, measured move), trigger (candle size and where it closed, RSI move, MACD run), volatility (ATR, percentile, squeeze), execution (spread, percentile, stop in ATR), session and macro (session, time to the next high-impact event), reward (TP1 in ATR, room to the next level). A group without data has no facts and state `NA`.
- *Strategy lines.* Each strategy adds its own numbers to the structure and the trigger group, in real prices (a SELL is never mirrored): A the pullback leg, zone and swing level; B the swept level, both CHoCH and the divergence; C the breakout, the squeeze and the retest; D the line, its touches, the break and the retest; E the pattern, boundary, target and break.
- *Weak points.* The components of the score (`ScoreComponent`, the parts a group is the mean of) that are below the "OK" line of 0.5, weakest first, at most 5, each in words with its number (`the spread is wide (95th percentile)`). Equal ones keep the order of the score. What is not known is never called weak.
- *Warnings.* One sentence for every advisory flag that is on, from its numbers (`News window: CPI m/m in 22 min`); the event name and the public numbers of open signals come from a context argument, because the flags only carry ids. The sentences stay in English in both languages (they are stored once).
- *Evidence, news, open risk.* Taken as given; evidence below 30 trades carries no percentage (rule C6), news distinguishes "feed unavailable" from "no headline".
- A setup without a score and a grade is no signal: the builder refuses it.

**The messages.** Telegram HTML, escaped as a whole (`& < >`), so that no headline or event name can add a tag. The few tags (bold, italic, a tap-to-copy `code` span, a quote, a folding quote) are written with private-use marker characters that real text never has and are turned into tags only after the escaping (`messages/markup.ts`); text that comes from outside (headlines, event names) has the markers removed first. A message that would not parse (a tag left open, a wrong nesting) is sent as plain text instead of being lost, because Telegram answers such a message with a 400, which is never retried. The look is in section 4.1 of the notifications document; the pictures are one table (`messages/style.ts`). The first line is the label of the signal, in bold, and a paper strategy's message always starts with `FORWARD-TEST (paper)` (rule C9; the entry alert adds "Manual execution only."); replay and backtest data say `SIMULATED` (rule C8); a validated live strategy says `VALIDATED strategy`. Prices and spreads have 3 decimals, R 2, as in the dashboard; times are in the display zone with its name (`11:38 IST`), and a date is added when the time falls on another day of that zone than the signal. Kinds built in B21: `SIGNAL_NEW` (short since P3: the levels, the style and hold time, the warnings that exist and one line of track record are plain; everything that explains the signal is in one folding quote), `SIGNAL_TP1` (only for `EP1_PARTIAL`: the other profiles end at their target), `SIGNAL_CLOSED` (win, partial win, loss, time exit, data invalid), `SIGNAL_CANCELLED`, `SIGNAL_REVIEW_FINAL`. The levels of the explanation must equal those of the signal, or the formatter refuses. The review is rendered from the autopsy data as it is stored: the primary cause with its category and the rule behind it, the other causes with their numbers (keys turned into words, nested values left out), the groups that were weak at entry, and for a final review where price went afterwards. The system messages and the command replies were built in B24 on the same words, escaping, clock, markup and length guard; the calendar messages (B25a) and `NEWS_HEADLINE`, `MARKET_MOVE` and the headline-feed notices (B25b) are built the same way; `DAILY_DIGEST` and `MONTHLY_REPORT` (B26) are built the same way (`alerts/reports.ts`).

**Languages.** `WORDS.en` and `WORDS.hinglish` have the same type, so a phrase missing in one does not compile; a test also checks that no text of either says guaranteed, sure, certain or risk-free. Only labels and sentences are translated: numbers, levels, ids, trading terms, the facts of the explanation and the warnings are the same (the stored explanation is one copy). The English dictionary is the same text as the dashboard uses; a test in the web package keeps the names of the groups and strategies, the rule of each cause, the category names and the bucket text equal.

**Length.** Under 3500 characters of the escaped text. The entry alert has five levels of detail; the first whose text fits is sent: 0 everything; 1 without research-only lines; 2 without the headline list (a count instead) and with at most 3 facts per group; 3 with 1 fact per group and 3 weak points; 4 with no facts and 1 weak point. The levels, the targets, the quality, the state of every group, the warnings, the open risk and the evidence are in every level. The message says which parts were left out (`dropped`). A message that is still over Telegram's 4096 characters at the last level is refused, not cut.

**Web Push.** Title `BUY XAUUSD #S-0042 (Strong 78)`, body `Entry 4017.370, stop 4010.900, TP1 4023.840, TP2 4030.310`, click `/signals/<id>`, TTL the entry validity (180 s, urgency high) for a new signal and 6 hours for the others, tag the outbox event key (`signal:<id>:confirmed`, `tp1`, `closed`, `review`) so that a repeated push replaces the earlier one. Pushes are English only (too short for labels) and, as in section 5 of the notifications document, carry no paper label: the page they open does. The TP1 push has urgency high (it asks for an action), the others normal. `messageTtlSec` is the one place that knows these lifetimes, for the outbox of B24 too.

**Decisions of B21 (mine, to review).** The label line first, as the delivery rules of the notifications document say, instead of after the headline as the example above has it; every group line has its state word (`[+] Trend STRONG: ...`) so that OK and STRONG can be told apart; `[n/a]` marks a group without data; the weak points come from the components of the score and not from group states alone; the review causes show their stored evidence by key, so a new cause needs no new template; TP1 shows the price move in R (`+1.00R on 50%`) and the partial-win line the contribution to the trade (`TP1 paid +0.50R`).

**To review in the research phases (B27 onward).** The Hinglish wording (the owner decides what reads naturally); the limit of 5 weak points; the "OK" line of 0.5 as the cut for weak; whether the explanation should store its warnings with their numbers so that they can be translated; the 3500-character limit and the order in which parts are dropped.

## 15. Validation and research discipline

- Data: HistData XAUUSD M1 bid bars (time zone fixed UTC-5 without DST, converted to UTC; spread modelled from the recorded live spread by hour of day) for the research backtest; the recorded live feed for forward testing.
- Splits by time: training, validation, untouched test, then forward paper trading. Parameter changes only on training and validation.
- Backtest uses the same `packages/core` code. Intrabar ambiguity at M1 resolution is resolved against the trade (stop first) and flagged.
- Execution cost scenarios (B28): every backtest report shows each result under three scenarios of the fill model of section 9: A baseline (slippage 0.05 USD, no delay), B slippage 0.30 USD with no delay, and C delay 20 s with slippage 0.05 USD. The decision gate of B28 needs net expectancy to stay positive in B and C as well; a result that is positive only in A is reported as cost-fragile and does not pass. Trades skipped because the delayed price is beyond `maxValidEntry` are reported with their count.
- Experiment registry: every run stores code commit, data range, parameters, number of variants tried, cost model and metrics. Failed variants are kept.
- Feature admission (ablation): baseline strategy vs baseline plus feature on out-of-sample data; promote only if expectancy and profit factor improve stably across sub-periods and after costs.
- Strategy status: `RESEARCH` -> `BACKTESTED` -> `FORWARD_TESTING` -> `VALIDATED`, with `PAUSED` and `DRIFTED`. `VALIDATED` requires a minimum forward sample (default 100 trades), positive net expectancy, acceptable drawdown and no material data-quality incidents. Alerts show the status of the strategy that fired.
- Backtest results on bar data are approximate. Forward results on live ticks are the real test.

### 15.1 Backtester, as built (B28)

Code: `tools/research/src/backtest` (`replay.ts`, `simulate.ts`, `metrics.ts`, `splits.ts`, `gate.ts`, `run.ts`, `registry.ts`, `variant.ts`, `ablation.ts`, `report.ts`, `command.ts`), `backtestCli.ts` and `args.ts`. Commands, from the repository root (the files are the HistData M1 zips of section 2.1; bar files only, not tick files):

- `pnpm research backtest:run [--strategy a,b] [--spread 0.2] [--through train|validation|test] [--notes text] [--out reports] <files or folders>`: the strategies with their default config over the history; the report `reports/backtest-<run>.md` and one line per strategy in `reports/experiments.jsonl`. About 2 minutes for three years. `--through` is the last period the run reads (default `validation`); `--holdout` is the old name of `--through test`.
- `pnpm research backtest:ablate [--strategy a,b] [--through train|validation|test] --variant "path=value;path=value" [--variant ...] [--set path=value ...] <files or folders>`: the strategies as they are (all five when none is named) and, for each variant, the same strategies with the changes made to every one of them, on the same bars; the baseline is run once (`reports/ablation-<run>.md`). Lists can be written without quotes: `acceptedRegimes=[TREND_UP,RANGE]`.

**One engine.** `replay` feeds the closed 5m, 15m and 1h candles (built from the minutes with the same `aggregateMinutes` as the live worker) to the `DecisionEngine` of section 10.1 in the order they closed (`mergeByClose`), decides on every 5m close that has a setup, and makes one signal for each setup, strategy and side (the duplicate key of section 10). Nothing but what had closed is known at a decision (tests: a run on a shorter history makes the same decisions before its end, and the same results for the trades that closed before it; a run twice is byte-equal). The confirming quote is the open of the first bar at or after the close (at most the entry validity later; otherwise no decision, counted as `noQuote`), the ask is the bid plus the spread. `plan` was added to the `SIGNAL` outcome of the engine for this.

**The fill and the trade (decisions of B28).**
- The signal is made on scenario A (as live); each scenario then fills with `findFill`: order time = decision + delay, price = quote there + slippage, skipped (and counted) when beyond `maxValidEntry`, expired or through the stop. The trade is followed by the live `TradeTracker`, bar by bar from the first bar at or after the fill, on the closing side: the bid for a BUY, the bid plus the spread for a SELL. R is the risk distance of the signal.
- A bar has four prices, not a path. A stop and a target in one bar: the stop is taken, `ambiguous`. A delayed fill (C, 20 s): the price is taken to have moved from the open of its minute towards the extreme that is worst for the trade (the high for a BUY, the low for a SELL) by the share of the minute that has passed, so 20 s cost a third of the way, never a gain (a first version took the whole range of the minute and skipped almost every trade of C: too harsh). The unknown is always settled against the trade.
- A minute without a bar is a minute without a tick (HistData leaves quiet minutes out): five minutes in a row without one close an open trade as `DATA_INVALID` (live: 60 s). A trade still open at the end of the data is in no statistic.
- The decision sees as open the trades of scenario A that are still open (the risk of each counted as 1 R).
- No calendar, headline or feed state exists for the past: the news state is unknown (the quality score leaves that part out, as live does when the calendar is down), no news window blocks, the feed is healthy. The spread is one number for all the time (default 0.20 USD, `--spread`), so the candles have no spread (the spread percentile is left out) and the evidence of a signal is always "insufficient". These make the backtest different from live in the news and spread parts only.

**Splits and the holdout guard.** `TRAIN` 2022 to 2024, `VALIDATION` 2025, `TEST` 2026 (`DEFAULT_SPLIT`; the boundaries are stored with every experiment). **The split was changed on 2026-10-25** from 2022-23, 2024 and 2025 on: gold in 2022 and 2023 moved about a quarter as much per 5 minutes as it does now (median ATR(5m) 1.0 to 1.15 USD against 4 and more in 2026), and the gates keep fixed USD limits (spread, slippage), so the years that decide a strategy must be recent ones. The change was made before any backtest had read a bar of 2025 or later; the 2024 numbers of the first report are training data now. Parameters are chosen on the training only; the validation is the check of a chosen variant and the gate; the test is a holdout. A run goes **through** a period (`--through`) and **reads no bar after its end**: tuning (`--through train`) reads nothing of 2025 or 2026, a check (`--through validation`, the default) nothing of 2026, and only `--through test` (or `--holdout`) opens the holdout. The registry counts the runs that opened it; a second look needs `--holdout-again` and is recorded, because what is tuned after seeing the test is tuned on it. The numbers are shown by period and by half year (the stability table). No parameter is fitted by the backtester: a variant is chosen on the training and then judged on the validation, which it has not seen.

**The decision gate.** On the last period the run went through, the validation (or the test when the holdout is open; a run through the training only has no gate: that period is in sample and the report says so), per strategy, with the costs of A, B and C: `INSUFFICIENT` below 30 trades in A; `FAIL` when the mean net R of A is not above zero; `COST_FRAGILE` when B or C is not above zero **or has fewer than 30 trades** (if the slippage or the delay make the owner skip most of the trades, what is left cannot be called positive); `PASS` otherwise. The gate is `PASS` when at least one strategy passes, otherwise `NO_EDGE`. The report says that five strategies were tried, which makes one good result more likely by chance, and that a pass is not proof: the forward test decides.

**The experiment registry.** `reports/experiments.jsonl`, one JSON line for each strategy of each run, in the fields of the `experiments` table (`03`): the run, time, git commit (and whether the tree was dirty), kind (`BACKTEST`, `ABLATION_BASELINE`, `ABLATION_VARIANT`), config (for a variant: the changes and the config), data (files, range, bars, spread), split, whether the holdout was open, `trialsInFamily` (the records of that strategy so far, this one included), the cost model and the metrics by period and scenario. Nothing is removed. The file is in the repository so that the work can be audited; the table is not written (no database role has INSERT on `experiments`), the file can be loaded into it later.

**Ablation.** A variant is the default config with `path=value` changes (only names that exist, checked by the config schema; the quality threshold cannot go below 65, the lowest grade). Its version is `x.y.(1000 + trialsInFamily)` (the baseline of the first run is trial 1, so the first variant is `0.1.1002`), never a version made on purpose. The same changes are made to every strategy of the run, and each variant is one more trial of each of them in the registry. On the training a variant that meets the criteria is only a **candidate** (the report says so and `admitted` stays false); it is admitted only when, on the validation (or test) period and in **all three scenarios**, it has at least 30 trades and a higher expectancy **and** profit factor than the baseline, and it is better (scenario A expectancy) in at least two thirds of the half years that have trades in both runs, in at least three of them.

**The first report (2026-10-25, `reports/backtest-20261025-173635.md`, made with the old split).** All five strategies with their default config, 2022-01-02 to 2024-12-31 (1,018,912 bars; the test period was not read). The strategies found 2,490 setups on 203,854 closed 5m candles, and **28 became signals in three years** (15 in 2022 and 2023, 13 in 2024, across the five strategies; 0 for the sweep reversal). Every strategy is `INSUFFICIENT` on the validation (1, 0, 6, 5 and 0 trades): there is nothing to say about an edge, and the numbers are descriptions. Why: of the 2,434 rejected setups, 2,061 failed `QUALITY_OK` (the score of 65 is a high bar), 1,397 `REGIME_OK`, 1,289 `STOP_OK` and `TARGET_OK`, 977 `SPREAD_OK` (at a gold price of 1,800 to 2,100 and an ATR(5m) near 1 USD, a spread of 0.20 is more than 12% of the stop), 134 `GAP_RECOVERY_OK`, 79 `WARMUP_OK`. A first look at 2022 alone gave the same picture (5 signals). The live engine is therefore very selective on this history; at about 9 signals a year in total it would take years to reach 30 trades for one strategy.

**To review in the research phases.** The constant spread of 0.20 USD; the adverse drift of the delayed fill (a third of the way to the extreme) and the five missing minutes; the 30 trades per scenario; the two thirds of the half years; the split years; whether the engine's gates (the spread to stop ratio, the stop and target bands, the regimes) fit the volatility of the years before 2024.

## 16. Headline news and market-move context

Scheduled calendar events (CPI, payrolls, FOMC) are handled by the calendar flags in section 6. This section covers unscheduled headlines (political statements, tariffs, war, sanctions) and sudden gold moves.

What the system can and cannot say. It can show which headlines were published around a move, how large the move was and how late the headline was seen. It cannot prove that a headline caused a move. Every message therefore says "possible cause" and shows measured numbers. If nothing matches, it says so instead of guessing.

### Sources (free, headline and link only)

- RSS feeds: BBC World, Al Jazeera, CNBC Top News, Federal Reserve press releases, and others the owner can add. The Biquote news endpoint is an extra source. A probe on 2026-10-23 confirmed that these feeds respond within a few hundred milliseconds.
- Polled every 60 s with conditional requests (ETag, If-Modified-Since), a 20 s timeout and per-feed backoff.
- Each headline shows the outlet name (for example "BBC News") and links to the original story. No outlet logos are used (BBC requires attribution and forbids its logo). HTML entities in titles are decoded.
- Only title, link, source, published time and a summary of at most 300 characters are stored. Full articles are never copied. Each feed's terms are checked before it is enabled, and any feed can be disabled in Settings.
- Not available for free, so not used: direct social-media posts (Truth Social, X), paid newswires (Reuters, Bloomberg, Dow Jones), scraping of channels whose terms forbid it. A politician's statement appears here only after a news outlet publishes it, typically minutes later.
- GDELT timed out from the development machine in the probe and is not used.

### Classification (deterministic, versioned, no LLM)

Each item is tagged by rules (keywords and entities, case-insensitive, word boundaries):

| Topic | Examples of triggers |
|---|---|
| `FED_RATES` | Fed, FOMC, Powell, rate cut, rate hike, Treasury yield |
| `USD_DOLLAR` | dollar index, DXY, dollar surges or slides |
| `INFLATION_JOBS` | CPI, PCE, payrolls, unemployment, inflation |
| `GEOPOLITICS_WAR` | war, missile, airstrike, invasion, ceasefire, Israel, Iran, Russia, Ukraine, Taiwan, Gaza, Houthi, Red Sea |
| `TRUMP_POLICY` | Trump, tariff, sanctions, executive order, trade deal |
| `CENTRAL_BANK_GOLD` | central bank gold purchases, PBoC gold |
| `GOLD_DIRECT` | gold price, bullion, XAU, gold ETF |
| `RISK_OFF` | sell-off, crash, banking crisis, default |

Impact score = topic weight x keyword strength x source tier x recency, mapped to LOW, MEDIUM or HIGH. Duplicate stories from several outlets are clustered (normalised title similarity within 60 minutes) into one item that lists all sources. The classifier has a version number and a golden-test set; changing it creates a new version.

The classifier states topics and impact only. It never claims "bullish" or "bearish" for gold, because those relationships change over time.

### Context line: where the indicators lean (P3)

A move alert and a headline alert carry one line that says where gold stands technically, so that the owner can tell a stretched market from one that is simply trending (code: `packages/core/src/news/lean.ts`, `marketLeanOf`). It reads the last 60 closed 5-minute candles and the latest price: RSI(14), the distance of the price from the EMA 20 in ATR(5m), the move of the last hour (12 candles) in ATR(5m) and the EMA 20 against the EMA 50 (a trend needs a gap of 0.3 ATR). The rules, in order: RSI at 30 or below, or 2.5 ATR below the EMA 20, with the last hour down is **BOUNCE_POSSIBLE** ("after a fall this long a bounce is possible, but it can also fall on"); the mirror is **PULLBACK_POSSIBLE**; a down trend with the last hour down and the price under the EMA 20 is **DOWN_WITH_TREND**; the mirror is **UP_WITH_TREND**; anything else is **MIXED** ("no clear lean"). It is built from prices alone: it does not read the headline, so it does not break the rule above, and it never says what will happen: every sentence ends with "Not a forecast, not a signal." It is left out when fewer than 50 candles can be read. It does not create, change or block a signal.

### Relevance filter and measured impact

- Only gold-relevant news is kept. An item that matches none of the topics above (sport, entertainment, local news) is dropped. It survives only in a 2-hour in-memory buffer so that the market-move detector can still show it as "unclassified, timing only" when gold jumps for a reason the rules did not anticipate.
- The topic list follows the usual drivers of gold: interest rates and the dollar, inflation and jobs, geopolitical stress and risk-off events, trade and sanctions policy, central-bank and direct gold demand. The initial weights are hypotheses.
- Whether a headline really moves gold is measured, not assumed. For every stored headline cluster the worker records gold's signed move 2, 5 and 10 minutes after publication and the largest excursion within 10 minutes (USD and in ATR(5m)). The rollup `news_topic_stats` keeps, per topic and impact level: how many headlines, the share that moved gold by 1 ATR or more, the average absolute move, and the same share over ordinary windows of the same sessions as a baseline.
- Analytics shows this table with sample sizes and intervals, and the headline alert shows the topic's history line (for example "HIGH geopolitics headlines moved gold by 1 ATR or more in 38% of cases, n=52, normal 14%"). Below 30 samples it says "not enough data yet".
- Weights are never tuned automatically. When the table shows that a topic does not move gold more than the baseline, the owner and I change the rules and release a new classifier version.

### Alerts

- `NEWS_HEADLINE`: a HIGH-impact cluster. Shows the headline, the outlets, the published time and the delay until we detected it, the topic tags, the link, and gold's measured move since publication (USD and ATR). The owner chooses the minimum impact and can mute topics.
- `MARKET_MOVE`: gold moves at least 2.0 x ATR(5m) within 5 minutes, or at least 3.0 x ATR(1m) within 1 minute (v0.1.0 hypotheses). The message shows the move and the spread, and lists the headlines of the previous 30 minutes ranked by impact as "possible causes, not confirmed", plus up to 3 unclassified headlines from the in-memory buffer that are closest in time, labelled "unclassified, timing only". If none match it says: "No matching headline found in the free feeds. The move may be technical, flow-driven, or the news may not be in these feeds yet."
- Both are information for the owner. They never block a signal or create one by themselves.

### Use inside signals and reviews

- A HIGH-impact headline in the last 30 minutes raises the advisory flag `HEADLINE_RECENT` and adds a "News (last 60 min)" line with up to 3 headlines to the signal message.
- The headlines shown at signal time are frozen into `explanation.news`, so they survive retention.
- The failure review uses headlines published during the trade. A HIGH headline followed by an adverse move of at least 1.5 x ATR within 10 minutes supports the cause `NEWS_SHOCK`, with the headline attached as evidence.
- Analytics breaks results down by news condition, including `HEADLINE_RECENT`, so the evidence shows whether signals taken near headlines perform differently.

### As built (B25b)

- **The feeds.** `DEFAULT_FEEDS` (`apps/worker/src/news/feeds.ts`): the Federal Reserve press releases (tier 1, official), BBC World, Al Jazeera and CNBC Top News (tier 2, major outlets) and Biquote's `GET /api/News/market?symbol=XAUUSD&maxResults=40` (tier 3, an aggregator). The list is in code; `news_sources.enabled` is the owner's switch (the table has no URL column, so a feed of the owner's own needs a code change). Each feed runs on its own clock, every 60 s, and after a failure 2, 5 and then 10 minutes, with native `fetch`, a 20 s timeout, a 2 MB limit on the body (a longer stream is cut and refused) and a user agent. The validators the server gave (`ETag`, `Last-Modified`) are sent back and a `304` is a good reading. In the probe of 2026-10-23 the Fed sent an ETag and answered `304`, BBC and CNBC sent no validator, and Al Jazeera sent an ETag but answered `200` anyway, so every item is also kept once by the hash of its canonical URL (tracking parameters removed). A feed that fails costs only itself; its last error is kept in `news_sources`.
- **Parsing.** RSS 2.0, RSS 1.0 and Atom with `fast-xml-parser` (a document that declares an `<!ENTITY` is refused; entities are decoded; a published time more than 10 minutes in the future is ignored). The titles of Biquote's news come with mojibake (UTF-8 read as Latin-1, such as `â€™`): it is repaired one sequence at a time, and invisible characters are removed. A link is kept only when it is `http` or `https` and at most 2048 characters. Only the title (at most 500 characters), the link and a summary of at most 300 characters are stored; an item first seen more than 6 hours after its published time is dropped. Biquote's items are stored under `biquote_news` without the name of their publisher, because the table has no column for it (the schema of `03` is not changed).
- **Classifier `1.0.0`** (`packages/core/src/news/`). A phrase is strong, medium or weak (1, 0.7, 0.4); a topic scores its weight times the strength of its best phrase (times 0.7 when the phrase is only in the summary) and counts from 0.3. The weights are `FED_RATES` 1.0, `USD_DOLLAR` 0.75, `INFLATION_JOBS` 0.9, `GEOPOLITICS_WAR` 0.9, `TRUMP_POLICY` 0.8, `CENTRAL_BANK_GOLD` 0.8, `GOLD_DIRECT` 0.9, `RISK_OFF` 0.85. The impact score is the best topic score times the tier factor (1, 0.9, 0.7) times a recency factor (1 up to 60 minutes after publication, 0.8 up to 3 hours, then 0.6); HIGH from 0.65, MEDIUM from 0.45, LOW below. So a lone headline of an aggregator rarely becomes HIGH. A headline that no rule recognises is not stored: it goes to the in-memory buffer (2 hours, at most 500). Known false positive: "Fed up" at the start of a sentence counts as `FED_RATES`.
- **Clustering.** Two items are one story when the Dice similarity of their normalised titles is at least 0.6, they share at least 3 words and are at most 60 minutes apart. The best match wins (a tie goes to the older story, then to the smaller id). A story that a second outlet runs later keeps its cluster, lists both outlets and may rise in impact.
- **Measured impact.** The `ImpactMeasurer` waits 10 minutes and 10 seconds after a story, then records the signed move of the mid price 2, 5 and 10 minutes after publication and the largest excursion in the 10 minutes, from stored ticks (a tick at most 30 seconds from each moment) and the ATR(5m) of the 15 complete candles before the story. A story is measured only when a tick sits near its publication and near +10 minutes and at least 14 complete 5m candles exist; otherwise it is left out, never guessed. `news_topic_stats` is rebuilt as a full recomputation from the samples (the SQL equals the pure `topicStats` of the core, and a test holds them to each other). The baseline, every 6 hours, is the share of ordinary 10-minute windows of the last 30 days in which gold moved at least 1 ATR, weighted by the sessions of the topic's samples; windows within 10 minutes of any story or of a HIGH calendar event are left out.
- **NEWS_HEADLINE.** Queued once for each story (`news:<cluster>:headline`) when its impact is at least `settings.newsAlerts.minImpact`, one of its topics is on, and the story is at most 30 minutes old by its published time. A story that becomes HIGH later is told at that point. The topic history line needs `n >= 30` (otherwise "not enough data yet").
- **MARKET_MOVE.** `MarketMoveDetector` watches the ticks the recorder has stored (it is fed by the recorder's `onPersistedTicks`; after a restart it reads the last 5 minutes from the database). A move is at least 2.0 x ATR(5m) within 5 minutes or 3.0 x ATR(1m) within 1 minute, over a run of ticks with no gap longer than 20 s; the ATR is read every 60 s. After a move there is a pause of 10 minutes (the time of the last move is read from `market_events`, so a restart keeps it). The move is always stored in `market_events` with the frozen headlines of the previous 30 minutes; it is told only when `newsAlerts.marketMoves` is `on`. When all headline feeds are disabled or down, the message says that the feeds are unavailable instead of "No matching headline found". Queuing the alert after the insert is not one transaction: if it fails the move is kept and the failure is logged.
- **Headline feed outage.** When every enabled feed has been silent for more than 10 minutes, one `SYSTEM_DEGRADED` notice is queued (`health:HEADLINES@<start>:degraded`; the start is the last good reading); `SYSTEM_RECOVERED` follows when a feed is read again, only for an outage that this process announced. Nothing is announced before a feed has ever worked.
- **For the decision engine (B26b).** `NewsContextReader.read()` gives the state of the feeds, the headlines of the last 60 minutes (at most 3, in the frozen shape of `explanation.news`) and the time of the last HIGH headline (for `HEADLINE_RECENT`). The line "News (last 60 min)" of the signal message, `HEADLINE_RECENT` and the failure cause `NEWS_SHOCK` are connected by the decision loop and the lifecycle in B26b (section 10.1); B25b only supplied the data.

## 17. Config `v0.1.0` (excerpt)

```json
{
  "timeframes": {"entry": "5m", "context": "15m", "bias": "1h"},
  "gates": {"maxTickAgeSec": 10, "maxSpreadUsd": 0.6, "maxSpreadToStop": 0.12, "stopAtr": [0.8, 2.0], "tp1MaxAtr": 2.5,
            "newsWindow": {"before": 45, "after": 20, "impact": ["high"], "currency": ["USD"]}},
  "quality": {"min": 65, "minCoverage": 0.7},
  "policy": {"throttles": "none", "dedupe": "per_setup_instance"},
  "advisory": {"newsWindow": "warn", "rollover": "warn", "offHours": "warn", "nearLevel": "warn"},
  "risk": {"simSlippageUsd": 0.05, "execDelaySec": 0, "entryValidSec": 180, "maxChaseAtr": 0.15, "exitProfile": "EP1_PARTIAL", "timeStopMin": 120},
  "stats": {"minN": 30, "lowSampleBelow": 100}
}
```
