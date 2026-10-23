import { Atr, INDICATOR_DEFAULTS } from './volatility';
import {
  type Bar,
  type Indicator,
  RollingWindow,
  assertBar,
  assertFinite,
  assertPeriod,
} from './types';

export type Direction = 'UP' | 'DOWN';

export interface SupertrendValue {
  /** The trailing line: below the price in an uptrend, above it in a downtrend. */
  readonly value: number;
  readonly direction: Direction;
  readonly upper: number;
  readonly lower: number;
  /** The direction changed on this candle. */
  readonly flipped: boolean;
}

/**
 * Supertrend: a trailing band at `multiplier` x ATR (Wilder) around the candle midpoint that only
 * moves in the direction of the trend and flips when the close crosses it. The first candle with
 * an ATR starts UP when it closes at or above its midpoint, otherwise DOWN; any difference to
 * other platforms at the start disappears at the first flip.
 */
export class Supertrend implements Indicator<Bar, SupertrendValue> {
  readonly warmup: number;
  private readonly atr: Atr;
  private seen = 0;
  private previous: { upper: number; lower: number; direction: Direction; close: number } | null =
    null;
  private latest: SupertrendValue | null = null;

  constructor(
    readonly period: number = INDICATOR_DEFAULTS.supertrend.period,
    readonly multiplier: number = INDICATOR_DEFAULTS.supertrend.multiplier,
  ) {
    assertFinite(multiplier, 'multiplier');
    this.atr = new Atr(period);
    this.warmup = period;
  }

  get count(): number {
    return this.seen;
  }

  get value(): SupertrendValue | null {
    return this.latest;
  }

  update(bar: Bar): SupertrendValue | null {
    assertBar(bar);
    this.seen += 1;
    const atr = this.atr.update(bar);
    if (atr === null) return (this.latest = null);

    const mid = (bar.h + bar.l) / 2;
    const basicUpper = mid + this.multiplier * atr;
    const basicLower = mid - this.multiplier * atr;
    const before = this.previous;

    let upper = basicUpper;
    let lower = basicLower;
    let direction: Direction = bar.c >= mid ? 'UP' : 'DOWN';
    if (before) {
      upper = basicUpper < before.upper || before.close > before.upper ? basicUpper : before.upper;
      lower = basicLower > before.lower || before.close < before.lower ? basicLower : before.lower;
      direction = before.direction;
      if (before.direction === 'DOWN' && bar.c > upper) direction = 'UP';
      else if (before.direction === 'UP' && bar.c < lower) direction = 'DOWN';
    }
    this.previous = { upper, lower, direction, close: bar.c };
    return (this.latest = {
      value: direction === 'UP' ? lower : upper,
      direction,
      upper,
      lower,
      flipped: before !== null && before.direction !== direction,
    });
  }
}

export interface ParabolicSarValue {
  readonly sar: number;
  /** UP: the stop trails below the price (long trend). */
  readonly direction: Direction;
  readonly accelerationFactor: number;
  /** The extreme price of the current trend. */
  readonly extremePoint: number;
  /** The trend reversed on this candle. */
  readonly reversed: boolean;
}

/**
 * Parabolic SAR (Wilder): a stop that accelerates towards the price. The first trend is UP when
 * the second candle closes at or above the first, and the first SAR is the first candle's low
 * (UP) or high (DOWN). In a trend the SAR never enters the previous two candles' range.
 */
export class ParabolicSar implements Indicator<Bar, ParabolicSarValue> {
  readonly warmup = 2;
  private seen = 0;
  private older: Bar | null = null;
  private newer: Bar | null = null;
  private long = true;
  private sar = 0;
  private extreme = 0;
  private af: number;
  private latest: ParabolicSarValue | null = null;

  constructor(
    readonly step: number = INDICATOR_DEFAULTS.parabolicSar.step,
    readonly max: number = INDICATOR_DEFAULTS.parabolicSar.max,
  ) {
    assertFinite(step, 'step');
    assertFinite(max, 'max');
    if (step <= 0 || max < step) throw new RangeError('need 0 < step <= max');
    this.af = step;
  }

  get count(): number {
    return this.seen;
  }

  get value(): ParabolicSarValue | null {
    return this.latest;
  }

  update(bar: Bar): ParabolicSarValue | null {
    assertBar(bar);
    this.seen += 1;
    const one = this.newer; // the candle before this one
    const two = this.older; // the candle before that

    if (one === null) {
      this.newer = bar;
      return (this.latest = null);
    }

    if (two === null) {
      // Second candle: pick the first trend and start the SAR at the first candle's extreme.
      this.long = bar.c >= one.c;
      this.sar = this.long ? one.l : one.h;
      this.extreme = this.long ? bar.h : bar.l;
      this.af = this.step;
      this.older = one;
      this.newer = bar;
      return (this.latest = this.snapshot(false));
    }

    let next = this.sar + this.af * (this.extreme - this.sar);
    let reversed = false;
    if (this.long) {
      next = Math.min(next, one.l, two.l);
      if (bar.l < next) {
        reversed = true;
        this.long = false;
        next = this.extreme;
        this.extreme = bar.l;
        this.af = this.step;
      } else if (bar.h > this.extreme) {
        this.extreme = bar.h;
        this.af = Math.min(this.af + this.step, this.max);
      }
    } else {
      next = Math.max(next, one.h, two.h);
      if (bar.h > next) {
        reversed = true;
        this.long = true;
        next = this.extreme;
        this.extreme = bar.h;
        this.af = this.step;
      } else if (bar.l < this.extreme) {
        this.extreme = bar.l;
        this.af = Math.min(this.af + this.step, this.max);
      }
    }
    this.sar = next;
    this.older = one;
    this.newer = bar;
    return (this.latest = this.snapshot(reversed));
  }

  private snapshot(reversed: boolean): ParabolicSarValue {
    return {
      sar: this.sar,
      direction: this.long ? 'UP' : 'DOWN',
      accelerationFactor: this.af,
      extremePoint: this.extreme,
      reversed,
    };
  }
}

export interface AroonValue {
  /** 100 when the highest high is this candle, 0 when it is `period` candles old. */
  readonly up: number;
  readonly down: number;
  readonly oscillator: number;
}

/**
 * Aroon: how recently the highest high and lowest low of the last `period + 1` candles happened.
 * `up = 100 x (period - candles since the highest high) / period`. When the same extreme occurs
 * twice, the more recent one counts.
 */
export class Aroon implements Indicator<Bar, AroonValue> {
  readonly warmup: number;
  private readonly highs: RollingWindow;
  private readonly lows: RollingWindow;
  private seen = 0;
  private latest: AroonValue | null = null;

  constructor(readonly period: number = INDICATOR_DEFAULTS.aroonPeriod) {
    assertPeriod(period);
    this.warmup = period + 1;
    this.highs = new RollingWindow(period + 1);
    this.lows = new RollingWindow(period + 1);
  }

  get count(): number {
    return this.seen;
  }

  get value(): AroonValue | null {
    return this.latest;
  }

  update(bar: Bar): AroonValue | null {
    assertBar(bar);
    this.seen += 1;
    this.highs.push(bar.h);
    this.lows.push(bar.l);
    if (!this.highs.full) return (this.latest = null);
    let sinceHigh = this.period;
    let sinceLow = this.period;
    let high = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    for (let back = this.period; back >= 0; back -= 1) {
      // Walking from the oldest to the newest: `>=` and `<=` keep the most recent tie.
      const h = this.highs.fromEnd(back);
      const l = this.lows.fromEnd(back);
      if (h >= high) {
        high = h;
        sinceHigh = back;
      }
      if (l <= low) {
        low = l;
        sinceLow = back;
      }
    }
    const up = (100 * (this.period - sinceHigh)) / this.period;
    const down = (100 * (this.period - sinceLow)) / this.period;
    return (this.latest = { up, down, oscillator: up - down });
  }
}

export interface HeikinAshiValue extends Bar {
  /** Consecutive Heikin-Ashi candles of the same colour: +3 is three bullish, -2 two bearish, 0 a flat one. */
  readonly streak: number;
}

/**
 * Heikin-Ashi candles: `close = (o + h + l + c) / 4`, `open = (previous open + previous close) / 2`
 * (the first one `(o + c) / 2`), high and low widened to include both. Smooths the noise; the
 * streak counts how long the colour has not changed.
 */
export class HeikinAshi implements Indicator<Bar, HeikinAshiValue> {
  readonly warmup = 1;
  private seen = 0;
  private previous: { o: number; c: number } | null = null;
  private streak = 0;
  private latest: HeikinAshiValue | null = null;

  get count(): number {
    return this.seen;
  }

  get value(): HeikinAshiValue | null {
    return this.latest;
  }

  update(bar: Bar): HeikinAshiValue {
    assertBar(bar);
    this.seen += 1;
    const c = (bar.o + bar.h + bar.l + bar.c) / 4;
    const o = this.previous ? (this.previous.o + this.previous.c) / 2 : (bar.o + bar.c) / 2;
    const h = Math.max(bar.h, o, c);
    const l = Math.min(bar.l, o, c);
    const colour = Math.sign(c - o);
    if (colour === 0) this.streak = 0;
    else this.streak = Math.sign(this.streak) === colour ? this.streak + colour : colour;
    this.previous = { o, c };
    return (this.latest = { o, h, l, c, streak: this.streak });
  }
}

/**
 * Kaufman efficiency ratio: the net move of the last `period` closes divided by the total path
 * they travelled. 1 is a straight line, 0 is going nowhere (also when the path is zero).
 */
export class EfficiencyRatio implements Indicator<number, number> {
  readonly warmup: number;
  private readonly closes: RollingWindow;
  private seen = 0;
  private latest: number | null = null;

  constructor(readonly period: number = INDICATOR_DEFAULTS.efficiencyPeriod) {
    assertPeriod(period);
    this.warmup = period + 1;
    this.closes = new RollingWindow(period + 1);
  }

  get count(): number {
    return this.seen;
  }

  get value(): number | null {
    return this.latest;
  }

  update(close: number): number | null {
    assertFinite(close, 'close');
    this.seen += 1;
    this.closes.push(close);
    if (!this.closes.full) return (this.latest = null);
    let path = 0;
    for (let i = 1; i <= this.period; i += 1)
      path += Math.abs(this.closes.at(i) - this.closes.at(i - 1));
    if (path === 0) return (this.latest = 0);
    return (this.latest = Math.abs(this.closes.at(this.period) - this.closes.at(0)) / path);
  }
}

export interface RegressionValue {
  /** Price change per candle of the fitted line. */
  readonly slope: number;
  readonly intercept: number;
  /** Share of the variance the line explains, 0 to 1: how clean the trend is. 0 for a flat series. */
  readonly r2: number;
  /** The fitted line at the newest candle (the regression endpoint). */
  readonly endpoint: number;
}

/** Least-squares line through the last `period` values (x = 0 for the oldest). */
export class LinearRegression implements Indicator<number, RegressionValue> {
  readonly warmup: number;
  private readonly window: RollingWindow;
  private seen = 0;
  private latest: RegressionValue | null = null;

  constructor(readonly period: number) {
    assertPeriod(period, 'period', 2);
    this.warmup = period;
    this.window = new RollingWindow(period);
  }

  get count(): number {
    return this.seen;
  }

  get value(): RegressionValue | null {
    return this.latest;
  }

  update(input: number): RegressionValue | null {
    assertFinite(input, 'input');
    this.seen += 1;
    this.window.push(input);
    if (!this.window.full) return (this.latest = null);
    const n = this.period;
    const meanX = (n - 1) / 2;
    let sumY = 0;
    for (let i = 0; i < n; i += 1) sumY += this.window.at(i);
    const meanY = sumY / n;
    // Centred on the means: stable for prices around 4000.
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i += 1) {
      const dx = i - meanX;
      const dy = this.window.at(i) - meanY;
      sxy += dx * dy;
      sxx += dx * dx;
      syy += dy * dy;
    }
    const slope = sxy / sxx;
    const intercept = meanY - slope * meanX;
    const r2 = syy === 0 ? 0 : Math.min(1, Math.max(0, (slope * sxy) / syy));
    return (this.latest = { slope, intercept, r2, endpoint: intercept + slope * (n - 1) });
  }
}
