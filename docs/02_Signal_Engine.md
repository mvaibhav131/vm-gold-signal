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
  - Precedence (implemented in `packages/core/src/time/sessions.ts`): ROLLOVER first, then OVERLAP, LONDON, NEW_YORK, then ASIA. In summer London opens at 07:00 UTC and wins over ASIA from then. Moments that no session covers (the minutes between New York's close and 00:00 UTC, and weekends) are also ROLLOVER: thin liquidity, advisory only. London and New York exist Monday to Friday; bank holidays are not modelled.
- Candle build rules: the source timestamp is the clock; mid = (bid + ask) / 2 rounded half up to 3 decimals. A 1m candle is sealed (`complete`) once the newest source time is 2 s past its end, so a tick up to 2 s behind still counts in the right minute and a tick for a sealed minute is dropped and counted. Higher timeframes are derived from sealed 1m candles only. The 1d candle is the 17:00 New York trading day (24 h, or 23 h and 25 h on the weekend the clocks change). Gaps are never filled with fake candles; a gap longer than 60 s is reported, as `WEEKEND` when it spans the Friday close to Sunday open and as `FEED` otherwise.
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

### 3.1 Indicator conventions (implemented in `packages/core/src/indicators`, phases B4 and B5)

Every indicator is a streaming class (`update(candle)` returns the value for that candle or `null` during warm-up), so the worker, the backtester and the chart run the same code and a batch run is a loop over `update`. A bad number (NaN, infinite) throws instead of poisoning later values. Values are plain floating point numbers; rounding is a display matter.

- **SMA**: mean of the last n values. **EMA**: alpha = 2/(n+1), seeded with the SMA of the first n values (first value at input n). **WMA**: weights 1..n, newest heaviest. **Hull(n)**: WMA(round(sqrt n)) of 2 x WMA(floor(n/2)) - WMA(n).
- **ATR**: Wilder smoothing, seeded with the average of the first n true ranges; the first candle's true range is its own range. ATR(14) unless stated. **Keltner**: EMA(20) of the close plus and minus 1.5 x ATR(14).
- **Bollinger**: SMA plus and minus k population standard deviations (divide by n); bandwidth = (upper - lower) / middle. **Squeeze**: Bollinger(20, 2) strictly inside Keltner(20, 1.5 x ATR); it reports its duration, the release candle and the candles since the release.
- **Donchian(n)**: highest high and lowest low of the last n candles including this one, plus the same for the n candles before this one (`priorUpper`, `priorLower`): a breakout is a close beyond the prior value, so the candle never counts itself.
- **Supertrend(10, 3)**: Wilder ATR around the midpoint; the first value starts UP when the close is at or above the midpoint. **Parabolic SAR(0.02, 0.2)**: Wilder's rules, the SAR may not enter the range of the previous two candles; the first trend is UP when the second candle closes at or above the first. **Aroon(n)**: window of n+1 candles, the most recent extreme wins a tie. **Heikin-Ashi**: standard formulas, first open (o+c)/2, plus the streak of one colour. **Choppiness(n)**: 100 x log10(sum TR / range) / log10(n), 100 when the range is zero.
- **Efficiency ratio(n)**: net move of n closes over the path they travelled, 0 when the path is zero. **Linear regression(n)**: least squares on the last n values, with slope per candle, endpoint and R-squared (0 for a flat series). **Percent rank(n)**: share of the previous n values at or below the newest, 0 to 100.
- **RSI(14)**: Wilder smoothing, the first average gain and loss are the plain averages of the first n changes (first value at close n+1). 100 when there were no losses, 0 when there were no gains, 50 when nothing moved. **StochRSI(14, 14, 3, 3)**: the RSI's position inside its own last 14 values, 0 to 100 (50 when it has no range); %K is the SMA(3) of that and %D the SMA(3) of %K. It only has a value once %K and %D exist.
- **MACD(12, 26, 9)**: EMA(12) minus EMA(26) of the close, signal = EMA(9) of the line (seeded like every EMA), histogram = line minus signal, plus `histogramChange` (histogram minus the previous histogram, null on the first value). First value at close 26 + 9 - 1 = 34. **ROC(10)**: 100 x (close - close 10 candles ago) / close 10 candles ago (0 if that close is 0). **Change(n)**: the plain difference to n inputs ago (slopes and "rising for n candles").
- **CCI(20)**: typical price (h+l+c)/3 minus its average, over 0.015 x the mean absolute deviation (0 when there is no deviation). **Williams %R(14)**: -100 to 0, 0 at the highest high of the window, -100 at the lowest low, -50 when there is no range. **Awesome oscillator**: SMA(5) minus SMA(34) of the median price (h+l)/2.
- **ADX(14), +DI, -DI**: Wilder. True range and the two directional movements are smoothed as `previous - previous / n + new` (first value the sum of the first n), +DI and -DI are their share of the smoothed true range in percent, DX = 100 x |+DI - -DI| / (+DI + -DI) (0 when both are 0), and ADX is the Wilder average of DX, first value the mean of the first n DX. The first value needs 2n candles. Only the larger of the two directional movements counts, and only when it is positive.
- **Ichimoku(9, 26, 52, 26)**: tenkan, kijun and span B are the midpoint of the highest high and lowest low over 9, 26 and 52 candles, span A is (tenkan + kijun) / 2. Nothing is shifted into the past: the cloud that applies to a candle (`spanA`, `spanB`, `cloudTop`, `cloudBottom`, `thickness`, `position` ABOVE, INSIDE or BELOW) is the one computed 26 candles earlier, and the cloud computed now (`futureSpanA`, `futureSpanB`) will apply 26 candles later. `chikouDelta` is the close minus the close 26 candles ago. First value after max(26, 52) + 26 = 78 candles.
- **Realised volatility(n)**: the square root of the mean squared log return over the last n returns (mean return taken as zero), per candle and not annualised; scale by the square root of the number of candles if a longer horizon is wanted. **Garman-Klass(n)**: the root of the mean over n candles of `0.5 x ln(h/l)^2 - (2 ln 2 - 1) x ln(c/o)^2` (never below 0). Both need prices above zero.
- **Anchored mean price**: the weighted mean of the typical price since an anchor, with the tick count as the weight (the feed has no real volume, so this is an approximation of a VWAP, history without a tick count uses weight 1), the weighted standard deviation, and the 1 and 2 deviation bands. `reset()` starts a new anchor (session open, a swing, the previous-day close); candles with weight 0 count for nothing and there is no value until some weight exists. The update is West's weighted incremental algorithm, so it stays accurate at prices near 4000 over thousands of candles.
- Verification: hand-calculated vectors for every indicator, equality of incremental and batch runs, truncated history equals the start of the full run (no look-ahead), naive whole-array reference implementations on random candles, and an independent cross-check against `trading-signals` for SMA, WMA, EMA, true range, ATR and Bollinger (exact or after the seed has been forgotten). Parabolic SAR differs from that library only in looking at one previous candle instead of two for its limit, so it is checked by hand vectors and at its reversals. For B5 the same library also confirms RSI, MACD (line, signal, histogram), ROC, CCI, the awesome oscillator, Williams %R, ADX with +DI and -DI, and the raw stochastic RSI (the library reports ROC, the DI values and the stochastic RSI as fractions, we report percent). Ichimoku, realised and Garman-Klass volatility and the anchored mean have no counterpart there and rely on the hand vectors and the naive reference.

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

### 4.0 How the primitives above are implemented (`packages/core/src/structure`, phase B6)

`MarketStructure` runs them in one pass over the closed candles of one timeframe (`update(candle, levels)` per candle, no look-ahead: an answer for candle t never changes when later candles arrive). The pieces are also usable alone (`SwingDetector`, `StructureTracker`, `displacementOf`, `FvgTracker`, `OrderBlockTracker`, `SweepTracker`). All thresholds are in `STRUCTURE_DEFAULTS` (`v0.1.0`). Conventions that the definitions above leave open:

- **Pivots**: the highs (lows) of the `k` candles on both sides must be strictly lower (higher), so an equal neighbour is no pivot. A pivot is reported on the candle `k` later (`confirmedIndex = index + k`), and one candle can confirm a swing high and a swing low. Each pivot is labelled against the previous pivot of its kind: `HH`, `LH`, `EH` for highs, `HL`, `LL`, `EL` for lows (E = equal). The price of a pivot is the high or low of its candle.
- **State**: from the last two pivots of each kind; `null` until there are two of each. Equal pivots count as neither higher nor lower, so the state is `RANGE`.
- **BOS and CHoCH**: judged on the close, against the last confirmed swing high and low as they were when the previous candle closed (the pivots that the candle itself confirms count from the next candle). A pivot breaks at most once: the first candle that closes beyond it. Closing exactly on the pivot price is not a break. In `UP` a close above the swing high is a BOS and below the swing low a CHoCH; in `DOWN` the mirror; in `RANGE` either boundary gives a BOS. While the state is still `null` nothing is reported, but a pivot that was closed beyond in that time stays broken, so a late candle never reports an old break. The state itself changes only when new pivots confirm, not at the break.
- **ATR**: the ATR(14) of the same series including the candle being judged (null for the first 13 candles, in which nothing that needs the ATR is detected).
- **Displacement**: as defined; a doji never qualifies. **Fair value gap**: the middle candle is not examined; the gap must be at least 0.3 x ATR (ATR of the third candle). A later candle touches it when it trades strictly inside, and fills it when it reaches the far edge (the candle that creates a gap cannot touch it). A gap leaves the active list when filled (at most 20 are kept).
- **Order block** (research): for a displacement candle, the nearest candle of the opposite colour among the 5 candles before it (a down candle before an upward displacement); the zone is that candle's full range. The same candle is not reported twice for the same direction. A later candle touches the block when it trades strictly inside and invalidates it when it closes beyond the far edge (at most 10 are kept).
- **Sweep and reclaim**: the liquidity levels (id, `HIGH` or `LOW`, price) are supplied with each candle by the caller (B7 builds them: PDH/PDL, session highs and lows, equal levels) and withdrawn once price has broken them for good. The sweep candle is the first candle that trades beyond the level by at least 0.10 x ATR and whose wick beyond its body is at least 50% of its range; the reclaim is that candle or one of the next 3 closing back on the right side. The event is reported on the reclaim candle with the most extreme price in between (the stop reference of strategy B). A level can sweep once while it is supplied under the same id, whether or not the reclaim came.
- Prices are compared as given; derived thresholds (a multiple of the ATR) use a tolerance of 1e-9 so that float noise never flips an exact boundary.
- Candles are a contiguous series: feed and weekend gaps are handled by the `GAP_RECOVERY_OK` gate, not here. A malformed candle (high below low, NaN) or one that is not newer than the last throws.
- Verification: synthetic hand-checked fixtures for every primitive (a zigzag that turns exactly at known prices gives known pivots, states and breaks, and its mirror image gives the mirrored ones), edge cases on every boundary, the truncated-history test (the answers for the first t candles are byte-identical with or without the later candles), and naive whole-array implementations of every definition compared with the streaming classes on long random runs. The test suite was also run against deliberately injected bugs (a wick counting as a break, an off-by-one reclaim window, `>=` instead of `>` at a pivot or gap edge) to confirm that it fails.

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

### 4.2 How levels and zones are implemented (`packages/core/src/levels`, phase B7)

`PeriodRanges` and `LiquidityBook` are streaming (one `update(candle)` per closed candle, no look-ahead); the rest are pure functions of the confirmed swing points (`Pivot`s of phase B6), an ATR and a candle count, so the same inputs always give the same answer. Thresholds are in `LEVEL_DEFAULTS` (`v0.1.0`). Conventions that the definitions above leave open:

- **Periods** (`PeriodRanges`): a candle belongs to a trading day (17:00 New York to 17:00 New York, labelled by the date it ends), to a trading week (named by the label of its Monday; the Sunday-evening open belongs to Monday) and to a session, all by its open time, so feed 15-minute candles or shorter. PDH, PDL and the daily pivots come from the last complete trading day *that had candles* (after a weekend or a holiday that is the last trading day before it); the weekly pivots from the last complete week. After a restart the last days of history must be fed first.
- **Session ranges**: Asia is the candles labelled ASIA (the Asian morning before London opens, so 00:00-07:00 UTC in summer). London is every candle in London's opening hours, which is the LONDON and OVERLAP labels, and New York is OVERLAP and NEW_YORK, so a venue's range covers all the hours it trades, not only the hours it trades alone. A range of one UTC day is complete when the first candle outside it arrives. `session` is the range so far of the current session label (OVERLAP is its own session there).
- **Pivot points**: classic (P = (H+L+C)/3, R1 = 2P-L, S1 = 2P-H, R2 = P+(H-L), S2 = P-(H-L), R3 = H+2(P-L), S3 = L-2(H-P)) and Camarilla (the close plus and minus 1.1 x range x 1/12, 1/6, 1/4 and 1/2 for R1 to R4 and S1 to S4), from the high, low and close of the previous day or week.
- **Round numbers**: multiples of 10, ranked by the largest of 10, 50 and 100 that divides them (so 4050 is a 50 level, 4100 a 100 level). Arithmetic is done in thousandths, so three-decimal prices stay exact.
- **Equal highs and lows**: swing points of one kind of the last 100 candles (hypothesis) within 0.15 x ATR of each other, grown from the lowest price upward so a group is never wider than the tolerance; two or more points make a level. The price of the level is the highest of the equal highs and the lowest of the equal lows (where the stops sit). The id follows the oldest point, so a group that gains a point keeps its id and is not swept twice.
- **Support and resistance zones**: swing points (both kinds) of the last 300 5m, 200 15m and 150 1h candles, clustered by price in the same way with the tolerance 0.25 x ATR(15m); two or more points make a zone, padded by 0.05 x ATR on each side. Strength is the sum of timeframe weight (1h 3, 15m 2, 5m 1) x 0.5^(age/100), age in candles of the point's own timeframe. The base role is RESISTANCE when most points are swing highs and SUPPORT when most are swing lows; with equal numbers it follows the latest close (above the middle is SUPPORT, no closes means RESISTANCE). The flip rule is evaluated on the closes of the 15m series that come after the newest swing point of the zone: the latest close at least 0.2 x ATR beyond the zone decides the role (above it SUPPORT, below it RESISTANCE), so a zone can flip back, and a close inside the zone changes nothing. `flipped` says that the role differs from the base role.
- **Fibonacci**: the swing sequence is the confirmed highs and lows in time order, with consecutive pivots of one kind collapsed into the more extreme one (a candle that is both a swing high and a swing low is ordered so that they alternate). The impulse leg is the most recent leg of at least 2.5 x ATR(15m), optionally of a given direction. Retracements are measured back from the end of the leg (38.2, 50, 61.8, 78.6 percent), the entry zone is the band between 61.8 and 78.6, the value zone for pullbacks the band between 38.2 and 61.8, and the extensions 127.2 and 161.8 percent are measured from the start of the leg (so they lie beyond its end).
- **Liquidity for the sweep tracker** (`LiquidityBook`): PDH and PDL, the high and low of the latest finished Asia and of the latest finished London session, and the equal highs and lows that the caller passes in. A level is withdrawn for good once a candle has closed beyond it (a close above a high, below a low), including the candle that completes the level; a wick that goes beyond and comes back does not withdraw it, because that is the sweep. Ids carry the date (`PDH:2026-10-22`, `ASIA_LOW:2026-10-22`), so each day has its own levels. Order per candle: `structure.update(candle, book.levels)`, then `book.update(candle, equal)`.
- Verification: hand-checked fixtures for every function, the 17:00 New York roll and the London and New York daylight-saving changes, ranges compared with whole-array references over three weeks of 5-minute candles (including the changes on 25 October and 1 November), invariants on random swing points (zone width, no point used twice, left-over points really have no neighbour within the tolerance, strength recomputed), the truncated-history test for the book, and an end-to-end test where the book feeds `MarketStructure` and a previous-day-low sweep is reported. The suite was also run against injected bugs (a venue missing the overlap, a wrong week start, a lost previous day, off-by-one windows and recency, a wrong flip boundary, a wrong retracement sign, a wick counted as a break).

### 4.3 How trendlines and channels are implemented (`packages/core/src/trendlines`, phase B8)

`findTrendlines` and `channelOf` are pure functions of the recent candles, the confirmed swing points (phase B6), an ATR and a candle count; `TrendlineTracker` runs them candle by candle (call it right after the `MarketStructure` of the same timeframe: `structure.update(candle)`, then `trendlines.update(candle, structure)`), and `BreakRetestTracker` follows breaks and retests. Thresholds are in `TRENDLINE_DEFAULTS` (`v0.1.0`). Conventions that the definitions above leave open:

- **Lines**: through any two confirmed swing lows (support) or highs (resistance) of the last 80 candles that are at least 6 candles apart; the support line must rise and the resistance line fall, each by at most 0.15 x ATR per candle (a flat line is a zone, not a trendline). The ATR is one value, the current ATR of the timeframe, used for every condition including the ones about past candles, so a line can become valid or invalid as the ATR changes. Candles up to and including the ones at exactly 0.10 x ATR beyond a line are fine ("more than 0.10 x ATR" invalidates). The swing points between A and B are checked at 0.15 x ATR, and exactly 0.15 is still a touch.
- **Touches and score**: touches are all swing points of that kind from A on that lie within 0.15 x ATR of the line, A and B included (two needed, three confirm). Score = 2 x touches + min(length / 10, 3) + recency, where length = candles from A to the last touch and recency = max(0, 1 - candles since the last touch / 80) (the docs name the term without a formula; this one is a hypothesis). Several swing points on one straight line give several lines of the same geometry (every valid pair); the best one is the one with the most touches, so the earliest A in the window, then the earliest B. The engine keeps `support` and `resistance`, the best of each.
- **Time, not position**: a line is a straight line in time (`lineValueAt(line, openTime)`), so a line drawn on 15m candles can be read at 5m candles (strategy D) and between candles. A line never crosses a gap in the data (a missing candle, the weekend): only the swing points after the last gap are used.
- **Channel**: for the best support line, the parallel through the highest swing high strictly between A and B (the earlier one on a tie), for the best resistance line the parallel through the lowest swing low between them. Touches are the swing points of that kind from A on within 0.15 x ATR of the parallel, the anchor included, and two are needed. A close beyond the parallel does not end a channel (that is a breakout of the channel, not of the trendline).
- **Break**: a candle whose close is at least 0.10 x ATR beyond the line and whose body is at least half of its range (`breakOf`). The ATR is the one of the candle's own timeframe, which may differ from the one the line was drawn on. A line is judged against the candle as the line was known at the previous call, so a line that the candle itself invalidates can still be reported broken. A line breaks once.
- **Retest**: after a break the line is followed for 8 candles. A candle that closes back on the old side ends it (`FAILED`). A candle that comes back to within 0.30 x ATR of the line (exactly 0.30 counts) is the return; the first candle, the returning one or a later one, that closes at least 0.30 x ATR away from the line on the new side confirms the retest (so a rejection candle that dips into the zone and closes outside it confirms at once). If that has not happened 8 candles after the break the retest ends as `EXPIRED` (a confirmation on the 8th candle still counts). The rejection wick and the RSI condition of strategy D are the strategy's own and are applied to the confirming candle.
- Verification: hand-checked fixtures (clean, touched, exactly-at-the-boundary and broken lines, both sides as mirror images), invariants on random swing points that re-check every rule on every returned line, a whole-array reference that tries every pair of swing points and is compared with the tracker on long random, rising, falling and gapped series, the truncated-history test, and break and retest scenarios for both sides (confirmed on the returning candle, confirmed later, failed, expired, confirmed on the last allowed candle, too late). The suite was also run against injected bugs (an off-by-one span, a missing invalidation, a missing between-check, a wrong score term, a line running through a gap, a wrong recency, a wrong slope bound, a wrong channel anchor, a missing body check, a wrong expiry, a retest without a return, a line that breaks twice).

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
| `ROLLOVER` | 21:45-23:15 UTC | Warning line |
| `OFF_HOURS` | ASIA session or the last 30 minutes of a session | Warning line (thin liquidity) |
| `NEAR_LEVEL` | Entry within 0.3 x ATR(5m) of a major opposing level, unless the setup is a sweep of that level | Warning line, lowers Reward feasibility |
| `OPPOSES_OPEN` | Direction is opposite to an open signal | Warning naming that signal |
| `UNVALIDATED_STRATEGY` | Strategy status below VALIDATED | `FORWARD-TEST` label |
| `NEWS_UNKNOWN` | Calendar feed unavailable | Warning line, news state UNKNOWN |

By default every flag only warns. The owner can switch a flag to `block` in Settings (`advisoryGates`). That is a personal preference stored in `app_settings`, not in the strategy config, and the flags present at signal time are stored on each signal, so statistics always show how signals with and without a flag performed.

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
