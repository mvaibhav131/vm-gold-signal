# Yield study: can the engine give 10-15 signals a day?

Date: 2026-10-25. Data: HistData XAUUSD M1, **TRAIN only (2022-01 to 2024-12)**. No bar of 2025 (validation) or 2026 (test) was read.

## Question

The first backtest gave 28 signals in 3 years. The owner asked for 10-15 appropriate signals per 24 h. A signal is only appropriate if the trade has a positive expectancy after costs, so the study asks first whether any rule on price data has such an edge at a high frequency. The signal count then follows from the edge, not the other way round.

## Method

- Every 5m close of the train years is a possible entry (203,854 closes, about 260 a day per side). The trade enters at the first M1 open after the close, as in `simulate.ts`: BUY pays the ask (bid + 0.20 USD) and is followed on the bid, SELL sells the bid and is followed on bid + 0.20. Entry slippage 0.05 USD (scenario A cost). Stop and target are checked on every M1 bar, a stop and a target in the same bar count as the stop.
- Stop = 1, 1.5 or 2.5 x ATR(14, 5m). Target = 1, 1.5 or 2 R, or none (exit by time after 120 or 480 min).
- 36 features known at the close: hour, weekday, ATR and its ratio to the 2000-bar average, candle body / close location / range in ATR, EMA 20/50 distance and spread, RSI and its 3-bar change, Bollinger %B and width, ADX and DI difference, 3 and 12 bar returns, consecutive closes, Donchian 20 break, Supertrend 5m and 1h, 1h EMA 20/50 spread, distance to the 1h EMA 20 and 200, 1h RSI / ADX / DI / slope, distance to the previous day high and low, position in the day range and its size, distance to the Asian range high and low, distance to the day mean price, distance to the 10 USD round number.
- Test 1: every single feature of the first 28 (all but the 8 day-structure ones), 10 quantile bins (or every value for features with 8 or fewer), BUY and SELL, one exit (stop 1.5 ATR, target 1.5 R, 120 min). About 560 bins.
- Test 2: a regression tree (depth 4, at least 2,500 trades per leaf) grown on two years and judged on the third year (3 folds: 22-23 -> 24, 23-24 -> 22, 22+24 -> 23), for BUY and SELL, 5 exit settings. That is 30 folds. The leaves with a positive mean R in the training years form the rule; its result in the held-out year is the number that counts.
- Everything is repeated with zero cost (no spread, no slippage) to see whether there is any gross edge at all.

## Data by month (train)

ATR is the median of ATR(14) on 5m candles. "Spread/ATR" is 0.20 USD over that ATR. "Cost per R" is 0.25 USD (spread + slippage) over a 1.5 ATR stop.

| Month | ATR 5m | Spread/ATR | Cost per R | | Month | ATR 5m | Spread/ATR | Cost per R |
|---|---|---|---|---|---|---|---|---|
| 2022-01 | 0.89 | 22% | 19% | | 2023-07 | 0.88 | 23% | 19% |
| 2022-02 | 1.10 | 18% | 15% | | 2023-08 | 0.75 | 26% | 22% |
| 2022-03 | 1.77 | 11% | 9% | | 2023-09 | 0.64 | 31% | 26% |
| 2022-04 | 1.35 | 15% | 12% | | 2023-10 | 1.07 | 19% | 16% |
| 2022-05 | 1.29 | 15% | 13% | | 2023-11 | 0.93 | 21% | 18% |
| 2022-06 | 1.12 | 18% | 15% | | 2023-12 | 1.10 | 18% | 15% |
| 2022-07 | 1.11 | 18% | 15% | | 2024-01 | 1.04 | 19% | 16% |
| 2022-08 | 1.00 | 20% | 17% | | 2024-02 | 0.77 | 26% | 22% |
| 2022-09 | 1.14 | 18% | 15% | | 2024-03 | 1.14 | 18% | 15% |
| 2022-10 | 1.24 | 16% | 13% | | 2024-04 | 1.95 | 10% | 9% |
| 2022-11 | 1.11 | 18% | 15% | | 2024-05 | 1.56 | 13% | 11% |
| 2022-12 | 1.01 | 20% | 17% | | 2024-06 | 1.38 | 14% | 12% |
| 2023-01 | 1.19 | 17% | 14% | | 2024-07 | 1.49 | 13% | 11% |
| 2023-02 | 1.20 | 17% | 15% | | 2024-08 | 1.64 | 12% | 10% |
| 2023-03 | 1.30 | 15% | 13% | | 2024-09 | 1.46 | 14% | 11% |
| 2023-04 | 1.23 | 16% | 14% | | 2024-10 | 1.53 | 13% | 11% |
| 2023-05 | 1.10 | 18% | 15% | | 2024-11 | 1.90 | 11% | 9% |
| 2023-06 | 0.97 | 21% | 17% | | 2024-12 | 1.65 | 12% | 10% |

- A 5m move is small next to the cost: the median ATR(5m) over the three years is about 1.1 USD, so a 0.20 USD spread is a fifth of it. Every trade starts 9-26% of R down, 15% in a typical month. A strategy needs a gross edge above that before it earns anything.
- The months with the lowest ATR (2023-08/09, 2024-02, 2022-01) have the highest cost per R: a quiet gold market is the worst place for a short-term signal.
- HistData leaves out minutes without a tick. In 2023-03 to 2023-07 a trading day has about 880-950 M1 bars, against 1,080-1,170 in the busier months. Those months have thinner candles and fewer 5m closes (3,800-4,600 against about 6,000), which is a property of the file, not of the importer.

## Result 1: random entries

With 0.25 USD of cost, entering at every 5m close (either side) loses money in every year and every exit:

| Stop | Mean R per trade (BUY / SELL), TP 1.5 R |
|---|---|
| 1.0 ATR | -0.218 / -0.225 |
| 1.5 ATR | -0.141 / -0.157 |
| 2.5 ATR | -0.080 / -0.101 |

This is the cost of trading, nothing else. A wider stop lowers the drag but makes the trade longer and the signals fewer.

## Result 2: single features

The best single bin of about 560 (10 bins x 28 features x 2 sides) is "ATR more than 1.8 x its recent average, BUY": -0.049 R (n = 20,238, 2022 -0.034, 2023 -0.081, 2024 -0.035). **No single bin has a positive mean R.** The worst are SELL in quiet-market and late-night bins at -0.23 to -0.30 R.

## Result 3: trees, held-out years

With the real cost (0.25 USD), 30 folds (10 settings x 3 year folds):

| | Value |
|---|---|
| Mean R of the chosen leaves in the years they were grown on | +0.106 R |
| Mean R of the same rules in the held-out year (weighted by trades) | **-0.045 R** |
| Folds with a positive held-out R | 7 of 30 |
| Best held-out fold | +0.134 R |
| Worst held-out fold | -0.195 R |

The rules look good on the years they were found on (+0.11 R) and do not carry over (-0.05 R). That gap is the size of the overfitting, and it is what a backtest tuned on one period shows when it is put on another.

With **zero cost** (no spread, no slippage): in-sample +0.125 R, held-out **+0.014 R** (weighted), 17 of 30 folds positive, best +0.143 R, worst -0.140 R. The few positive folds are mostly BUY rules in 2023-2024 when gold rose from about 1,900 to 2,600 USD: the market's drift, not a rule. So even if trading were free, these features would not predict the next 2 to 8 hours. With the real cost the net result is negative.

## Result 4: the engine, as built

The B28 ablation on the same train years (old strategies, gates loosened step by step):

| Variant | Trades in 3 years | Per day | Mean R (scenario A) |
|---|---|---|---|
| Baseline | 26 | 0.03 | not enough trades |
| V1: wider stop and target band | 67 | 0.09 | -0.122 |
| V2: V1 + spread cap 0.20 of the stop | 101 | 0.13 | -0.122 |
| V3: V2 + any regime | 187 | 0.24 | -0.179 |

More signals came only with more losing trades. This agrees with the study above.

## Result 5 (round 2): wider timeframes and fixed rules, train years only

Because the cost per R is large at 5m (the stop is only about 1 USD), the same tree test (same 36-feature family, with 1h/4h or 4h/daily context, 3 held-out-year folds, 5 exit settings, BUY and SELL) was run on **15m** and **1h** entries, with the stop in ATR of that timeframe.

| Entry timeframe | Cost | Held-out R (weighted) | Folds positive | Trades per day (all leaves) |
|---|---|---|---|---|
| 15m | real (0.20 + 0.05) | **-0.041 R** | 5 of 30 | about 26 |
| 15m | zero | +0.017 R | 18 of 30 | about 41 |
| 1h | real | **-0.039 R** | 14 of 30 | about 9 |
| 1h | zero | -0.012 R | 16 of 30 | about 9 |

In-sample the rules score +0.15 R (15m) and +0.21 R (1h); held-out they are at or below zero. Same pattern as at 5m: more yield, no carry-over.

Then 1,440 fixed-rule settings were run (60 rule variants x 3 stop sizes x 2 holding times x 4 exits), real cost, by year: Asian-range break and fade (00-07 UTC), opening-range break and fade at 07, 08, 12, 13 and 14 UTC (30-minute range), previous-day high / low break and fade, and BUY / SELL at every hour of the day.

- **19 of 1,440 settings are positive in all three years.** Most of the rules lose on average (about -0.05 to -0.15 R). With this many settings, a few positive ones are expected from chance alone.
- The 19 are mostly **one idea seen through different stops and exits**: fade the first 5m close outside the 12:00-12:30 UTC range (after 12:30, until 16:00). At real cost: +0.06 to +0.09 R, 713 trades (about 0.9 a day), years +0.13 / +0.09 / +0.06 R (stop 5 x ATR, target 2R, 4 h). At spread 0.12: +0.10 R. At zero cost: +0.13 R.
- Why it is **not** accepted:
  1. **Fragile to its own definition.** Range 12:00-12:30 works, but 11:30-12:30 (+0.01 R, 2023 -0.15 R), 12:00-13:00 (-0.01 R), 11:30-12:00 (-0.04 R) and 12:00-12:15 (+0.02 R, 2023 -0.06 R) do not. A real effect does not usually disappear when the window moves by 15 minutes.
  2. **Only in US summer-time months** (+0.15 R, 454 trades). In winter months it is about 0 R (-0.02 to +0.02). A data-release effect (US data at 12:30 UTC in summer) would explain that, but the winter equivalent (range 13:00-13:30 UTC, 13:30 UTC release) does not show it (-0.04 R), so the explanation does not hold.
  3. It is the best of 1,440 settings found on the same three years. Its expected size (+0.09 R) is smaller than the selection bias.
  4. About 0.9 signals a day, not 7-8.
- The other positives are long-only rules (previous-day high break BUY, previous-day low break fade BUY, 21 UTC BUY) in years when gold rose: drift, not a rule.

**Result:** nothing in round 2 gives a held-out edge. The one candidate worth a single forward check is the 12:00-12:30 UTC fade; it is recorded here and not used.

## What this means

1. **10-15 appropriate signals a day cannot be had from price and indicators at 5m, 15m or 1h with a 0.20 USD spread.** The data does not show an edge, even before costs. Forcing the count with looser gates gives about 10-15 signals a day that lose 0.1-0.2 R each (that is 1-3 R of loss per day at 1R risk per trade).
2. The engine's gate (positive expectancy in scenarios A, B and C on out-of-sample data) is doing its job: it returned NO_EDGE, and this study explains why.
3. The target must come from the data. What the data supports today is a small number of selective signals that are tested on forward data first.

## Limits of this study

- Trades from neighbouring 5m closes overlap, so `n` is larger than the number of independent trades (a 2-hour trade covers 24 closes). The mean R is unaffected; the confidence bands are wider than `n` suggests.
- One constant spread of 0.20 USD for all hours. Real spreads are wider at the roll-over and narrower in London / New York; the live feed will record them (B32).
- The features are price and indicators. There is no news, calendar, order flow or tick data, and no other market (DXY, silver, yields) in this study.
- The tests looked at about 560 single bins, 30 trees at 5m and 60 more at 15m / 1h (15 leaves each), and 1,440 fixed-rule settings, all on the same three years, with real cost and zero cost. Any result that looked good would have needed a clearly stronger bar; none did.
- Fixed rules use UTC clock times; the daylight-saving shift moves the real market open by one hour, which blurs rules tied to a session open.
- Only TRAIN was read. VALIDATION and TEST are untouched.

## Options

0. **One-shot check of the 12:00-12:30 UTC fade on 2025 (VALIDATION)**, declared before looking: summer months only, stop 5 x ATR(5m), target 2R, 4 h window. It uses the validation year once; if it is not clearly positive, it is dropped. Expected: about 0.9 trades a day for roughly 7 months, not a source of 7-8 signals a day.
1. **Commit B28 as it is** and go to B29/B30: the forward test (B32) will record real spreads and real news, which this study could not use.
2. **A second tier of "watch" alerts** (setup forming, no entry and no stop, clearly not a signal) can reach 10-15 a day without claiming an edge. It is a product choice, not a statistical result.
3. **Paper-only "tier B" signals** (gates loosened) for the forward test: they would lose on average on the train data, so they must stay out of the win-rate and the live count, and only serve to collect data.
4. **New information** that may carry an edge: the economic calendar and news in the backtest (needs a historical source), real spreads, other markets (DXY, silver, US yields). Wider holding times were tested (15m and 1h entries) and did not help on price alone.
