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
- Warm-up: a timeframe is usable when it has at least `max(period)*3` candles (1h EMA200 needs 600 hourly candles). On a fresh install, history is bootstrapped (HistData M1 converted to mid, then Biquote OHLC for the recent gap) and marked in `candles.source`. Live signals are blocked until warm-up completes.
- Volume: the feed has no real volume (always 0). Only tick count per candle exists. Volume-based indicators are therefore research-only and flagged as tick-volume approximations.

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

**News shock and news window.** `MedianBaseline` is the 24h median: the median of the previous 288 closed 5m candles (a weekend has no candles, so it does not stretch the window), for ATR(5m) and for the average spread of the candles. `NEWS_SHOCK` is the news window being active and (ATR(5m) at least 2.5 times its median or the spread at least 3 times); a ratio that cannot be computed counts as not exceeded. `macroProximity` takes the calendar events that match the impact and currency of `gates.newsWindow` and gives the next event (after now) and the last one (at or before now) with the minutes to and since them, and whether now is inside [-before, +after] of an event (both ends included). The `NEWS_WINDOW` flag also stays on after the scheduled window while ATR(5m) or the spread is still at least 1.5 times its median; the docs gave no end for that, so it closes at the latest 120 minutes after the event. The news state is `UNKNOWN` when the calendar is not available and never `CLEAR` by guess.

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

### Alert policy by strategy status
Every signal is always recorded and tracked. Whether it is also sent to Telegram is a per-strategy alert switch (Settings, `strategyAlerts`). Defaults: ON for A, B and C (the messages carry the `FORWARD-TEST` label until a strategy is `VALIDATED`), OFF for D and E until their first backtest report (B28) is reviewed. The owner can switch any strategy on or off at any time. A strategy whose alerts are off still runs in shadow mode, so its evidence builds up without notifications.

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

## 9. Risk, exit profiles, entry and fill model

V1 uses market entries only, confirmed at the 5m candle close.

- `entry`: ask for BUY, bid for SELL at the confirming tick.
- Simulated fill = `entry` plus `simSlippage` adverse (default 0.05 USD). All outcome math uses the fill.
- `maxValidEntry`: entry plus min(0.15 x ATR(5m), 0.25 x risk distance) for BUY (minus for SELL). Beyond this the owner should skip the trade.
- `entryValidUntil`: 3 minutes after the signal.
- Risk distance R = |fill - stop|.

**Owner execution cost (decision of 2026-10-24, built in B20, used in B28).** The owner places the order by hand: later than the confirming tick and at a worse price than a fill at that tick. The paper statistics must not hide that. The fill model therefore has two inputs, both configurable per strategy version: `simSlippageUsd` (default 0.05, as above) and `execDelaySec` (default 0, B20 adds it to `risk` of the strategy config). With a delay the simulated fill is the first tick at or after the signal time plus the delay (ask for a BUY, bid for a SELL) plus the slippage. If the price at that moment is already beyond `maxValidEntry`, or the entry validity has run out, the owner would have skipped the trade, so it is counted as skipped and not as a trade. Live signals keep the defaults (the confirming tick); the delay matters for the cost scenarios of section 15.

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

## 10. Signal policy

There are no throttles. Signals are produced at any hour and in any number, regardless of how earlier signals ended.

- No daily cap, no cooldown timer, no loss-streak pause, no limit on open signals, no session or time-of-day block.
- Duplicate suppression only: a setup instance (the same pullback leg, sweep, trendline break or pattern, identified by `setup_key`) produces at most one signal per strategy and side. This stops the same idea from firing on consecutive candles. It is not a time-based throttle.
- Signals may overlap. Each open signal is tracked independently with its own R. A signal that opposes an open one is still sent, with the warning `OPPOSES_OPEN`. Every alert shows the open-signal count and the total open risk in R, so the owner can decide which to take.
- Each signal stores `open_signals_at_entry`, because simultaneous trades are correlated and Analytics can report them separately.
- The system pauses only when the owner presses Pause (dashboard or `/pause`). A paused system still records data and tracks open signals.
- A setup that satisfies the strategy rules but fails a blocking gate is written to `rejections` (30-day retention). The dashboard uses it to show "WAIT: spread too high" with the reason codes.

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

## 13. Evidence shown with every signal

Historical evidence comes only from recorded outcomes in `stats_bucket`:

- Bucket key: `strategy_key + version | side | session | regime | volatility_bucket`.
- If the exact bucket has fewer than 30 resolved trades, fall back in order: drop volatility bucket, drop regime, drop session, strategy and side only. The UI and Telegram message state which level was used.
- Two scopes are kept separately: `FORWARD` (live paper trades) and `BACKTEST_OOS` (out-of-sample backtest). Forward evidence is preferred when it has at least 30 trades.
- Displayed: win rate, n, Wilson 95% confidence interval, expectancy in R, profit factor, TP1-hit rate, TP2-hit rate.
- n < 30: "Insufficient evidence" with the raw counts. 30 <= n < 100: shown with a "low sample" label. n >= 100: normal.
- A calibrated probability model may be added after at least several hundred forward trades. Until then no probability is invented.

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

## 15. Validation and research discipline

- Data: HistData XAUUSD M1 bid bars (time zone fixed UTC-5 without DST, converted to UTC; spread modelled from the recorded live spread by hour of day) for the research backtest; the recorded live feed for forward testing.
- Splits by time: training, validation, untouched test, then forward paper trading. Parameter changes only on training and validation.
- Backtest uses the same `packages/core` code. Intrabar ambiguity at M1 resolution is resolved against the trade (stop first) and flagged.
- Execution cost scenarios (B28): every backtest report shows each result under three scenarios of the fill model of section 9: A baseline (slippage 0.05 USD, no delay), B slippage 0.30 USD with no delay, and C delay 20 s with slippage 0.05 USD. The decision gate of B28 needs net expectancy to stay positive in B and C as well; a result that is positive only in A is reported as cost-fragile and does not pass. Trades skipped because the delayed price is beyond `maxValidEntry` are reported with their count.
- Experiment registry: every run stores code commit, data range, parameters, number of variants tried, cost model and metrics. Failed variants are kept.
- Feature admission (ablation): baseline strategy vs baseline plus feature on out-of-sample data; promote only if expectancy and profit factor improve stably across sub-periods and after costs.
- Strategy status: `RESEARCH` -> `BACKTESTED` -> `FORWARD_TESTING` -> `VALIDATED`, with `PAUSED` and `DRIFTED`. `VALIDATED` requires a minimum forward sample (default 100 trades), positive net expectancy, acceptable drawdown and no material data-quality incidents. Alerts show the status of the strategy that fired.
- Backtest results on bar data are approximate. Forward results on live ticks are the real test.

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

## 17. Config `v0.1.0` (excerpt)

```json
{
  "timeframes": {"entry": "5m", "context": "15m", "bias": "1h"},
  "gates": {"maxTickAgeSec": 10, "maxSpreadUsd": 0.6, "maxSpreadToStop": 0.12, "stopAtr": [0.8, 2.0], "tp1MaxAtr": 2.5,
            "newsWindow": {"before": 45, "after": 20, "impact": ["high"], "currency": ["USD"]}},
  "quality": {"min": 65, "minCoverage": 0.7},
  "policy": {"throttles": "none", "dedupe": "per_setup_instance"},
  "advisory": {"newsWindow": "warn", "rollover": "warn", "offHours": "warn", "nearLevel": "warn"},
  "risk": {"simSlippageUsd": 0.05, "entryValidSec": 180, "maxChaseAtr": 0.15, "exitProfile": "EP1_PARTIAL", "timeStopMin": 120},
  "stats": {"minN": 30, "lowSampleBelow": 100}
}
```
