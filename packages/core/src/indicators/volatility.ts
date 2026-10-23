import { Ema } from './averages';
import {
  type Bar,
  type Indicator,
  RollingWindow,
  assertBar,
  assertFinite,
  assertPeriod,
} from './types';

/** The parameters of 02_Signal_Engine section 3, used when a constructor gets no arguments. */
export const INDICATOR_DEFAULTS = {
  emaPeriods: [9, 20, 50, 200],
  atrPeriod: 14,
  bollinger: { period: 20, multiplier: 2 },
  keltner: { period: 20, multiplier: 1.5 },
  supertrend: { period: 10, multiplier: 3 },
  donchianPeriods: [20, 55],
  aroonPeriod: 25,
  choppinessPeriod: 14,
  efficiencyPeriod: 20,
  parabolicSar: { step: 0.02, max: 0.2 },
} as const;

/**
 * True range: the largest of the candle's own range and the distance from the previous close to
 * its high and low, so a gap counts. The first candle has no previous close and uses its range.
 */
export class TrueRange implements Indicator<Bar, number> {
  readonly warmup = 1;
  private seen = 0;
  private previousClose: number | null = null;
  private latest: number | null = null;

  get count(): number {
    return this.seen;
  }

  get value(): number | null {
    return this.latest;
  }

  update(bar: Bar): number {
    assertBar(bar);
    this.seen += 1;
    const range = bar.h - bar.l;
    const previous = this.previousClose;
    const result =
      previous === null
        ? range
        : Math.max(range, Math.abs(bar.h - previous), Math.abs(bar.l - previous));
    this.previousClose = bar.c;
    return (this.latest = result);
  }
}

/**
 * Average true range, Wilder smoothing: the first value is the simple average of the first
 * `period` true ranges, then `ATR = (previous x (period - 1) + TR) / period`.
 */
export class Atr implements Indicator<Bar, number> {
  readonly warmup: number;
  private readonly range = new TrueRange();
  private seen = 0;
  private seedSum = 0;
  private latest: number | null = null;

  constructor(readonly period: number = INDICATOR_DEFAULTS.atrPeriod) {
    assertPeriod(period);
    this.warmup = period;
  }

  get count(): number {
    return this.seen;
  }

  get value(): number | null {
    return this.latest;
  }

  update(bar: Bar): number | null {
    const tr = this.range.update(bar);
    this.seen += 1;
    if (this.seen < this.period) {
      this.seedSum += tr;
      return (this.latest = null);
    }
    if (this.seen === this.period) {
      this.seedSum += tr;
      return (this.latest = this.seedSum / this.period);
    }
    const previous = this.latest ?? tr;
    return (this.latest = (previous * (this.period - 1) + tr) / this.period);
  }
}

export interface BollingerValue {
  readonly middle: number;
  readonly upper: number;
  readonly lower: number;
  /** (upper - lower) / middle: how wide the bands are as a share of the price. */
  readonly bandwidth: number;
  /** Where the input sits between the bands: 0 at the lower band, 1 at the upper (0.5 for zero width). */
  readonly percentB: number;
}

/**
 * Bollinger bands on a series (normally the close): the simple average plus and minus
 * `multiplier` population standard deviations of the last `period` values.
 */
export class Bollinger implements Indicator<number, BollingerValue> {
  readonly warmup: number;
  private readonly window: RollingWindow;
  private seen = 0;
  private latest: BollingerValue | null = null;

  constructor(
    readonly period: number = INDICATOR_DEFAULTS.bollinger.period,
    readonly multiplier: number = INDICATOR_DEFAULTS.bollinger.multiplier,
  ) {
    assertPeriod(period, 'period', 2);
    assertFinite(multiplier, 'multiplier');
    this.warmup = period;
    this.window = new RollingWindow(period);
  }

  get count(): number {
    return this.seen;
  }

  get value(): BollingerValue | null {
    return this.latest;
  }

  update(input: number): BollingerValue | null {
    assertFinite(input, 'input');
    this.seen += 1;
    this.window.push(input);
    if (!this.window.full) return (this.latest = null);
    let sum = 0;
    for (let i = 0; i < this.period; i += 1) sum += this.window.at(i);
    const middle = sum / this.period;
    let squares = 0;
    for (let i = 0; i < this.period; i += 1) squares += (this.window.at(i) - middle) ** 2;
    const deviation = Math.sqrt(squares / this.period);
    const upper = middle + this.multiplier * deviation;
    const lower = middle - this.multiplier * deviation;
    const width = upper - lower;
    return (this.latest = {
      middle,
      upper,
      lower,
      bandwidth: width / middle,
      percentB: width === 0 ? 0.5 : (input - lower) / width,
    });
  }
}

export interface KeltnerValue {
  readonly middle: number;
  readonly upper: number;
  readonly lower: number;
  readonly atr: number;
}

/**
 * Keltner channel: an EMA of the close plus and minus `multiplier` x ATR. The ATR period is 14,
 * the engine-wide ATR (02_Signal_Engine section 4), unless given.
 */
export class Keltner implements Indicator<Bar, KeltnerValue> {
  readonly warmup: number;
  private readonly average: Ema;
  private readonly atr: Atr;
  private seen = 0;
  private latest: KeltnerValue | null = null;

  constructor(
    readonly period: number = INDICATOR_DEFAULTS.keltner.period,
    readonly multiplier: number = INDICATOR_DEFAULTS.keltner.multiplier,
    atrPeriod: number = INDICATOR_DEFAULTS.atrPeriod,
  ) {
    assertFinite(multiplier, 'multiplier');
    this.average = new Ema(period);
    this.atr = new Atr(atrPeriod);
    this.warmup = Math.max(period, atrPeriod);
  }

  get count(): number {
    return this.seen;
  }

  get value(): KeltnerValue | null {
    return this.latest;
  }

  update(bar: Bar): KeltnerValue | null {
    assertBar(bar);
    this.seen += 1;
    const middle = this.average.update(bar.c);
    const atr = this.atr.update(bar);
    if (middle === null || atr === null) return (this.latest = null);
    const offset = this.multiplier * atr;
    return (this.latest = { middle, upper: middle + offset, lower: middle - offset, atr });
  }
}

export interface DonchianValue {
  /** Highest high of the last `period` candles, this one included. */
  readonly upper: number;
  readonly lower: number;
  readonly middle: number;
  /**
   * Highest high of the `period` candles before this one, or null until there are `period + 1`
   * candles. A breakout means closing beyond this value, so the candle itself never counts.
   */
  readonly priorUpper: number | null;
  readonly priorLower: number | null;
}

/** Donchian channel: the highest high and lowest low of the last `period` candles. */
export class Donchian implements Indicator<Bar, DonchianValue> {
  readonly warmup: number;
  private readonly highs: RollingWindow;
  private readonly lows: RollingWindow;
  private seen = 0;
  private latest: DonchianValue | null = null;

  constructor(readonly period: number = INDICATOR_DEFAULTS.donchianPeriods[0]) {
    assertPeriod(period);
    this.warmup = period;
    // One extra candle, to be able to look at the period before the current candle.
    this.highs = new RollingWindow(period + 1);
    this.lows = new RollingWindow(period + 1);
  }

  get count(): number {
    return this.seen;
  }

  get value(): DonchianValue | null {
    return this.latest;
  }

  update(bar: Bar): DonchianValue | null {
    assertBar(bar);
    this.seen += 1;
    this.highs.push(bar.h);
    this.lows.push(bar.l);
    if (this.highs.length < this.period) return (this.latest = null);

    const length = this.highs.length;
    const newest = length - 1;
    let upper = Number.NEGATIVE_INFINITY;
    let lower = Number.POSITIVE_INFINITY;
    for (let i = newest - this.period + 1; i <= newest; i += 1) {
      upper = Math.max(upper, this.highs.at(i));
      lower = Math.min(lower, this.lows.at(i));
    }
    let priorUpper: number | null = null;
    let priorLower: number | null = null;
    if (length === this.period + 1) {
      priorUpper = Number.NEGATIVE_INFINITY;
      priorLower = Number.POSITIVE_INFINITY;
      for (let i = 0; i < this.period; i += 1) {
        priorUpper = Math.max(priorUpper, this.highs.at(i));
        priorLower = Math.min(priorLower, this.lows.at(i));
      }
    }
    return (this.latest = { upper, lower, middle: (upper + lower) / 2, priorUpper, priorLower });
  }
}

/**
 * Choppiness index: `100 x log10(sum of true ranges / (highest high - lowest low)) / log10(period)`
 * over the last `period` candles. Near 100 the market goes sideways; near 0 it trends in one
 * direction. A window with no range at all counts as fully choppy (100).
 */
export class Choppiness implements Indicator<Bar, number> {
  readonly warmup: number;
  private readonly range = new TrueRange();
  private readonly ranges: RollingWindow;
  private readonly highs: RollingWindow;
  private readonly lows: RollingWindow;
  private seen = 0;
  private latest: number | null = null;

  constructor(readonly period: number = INDICATOR_DEFAULTS.choppinessPeriod) {
    assertPeriod(period, 'period', 2);
    this.warmup = period;
    this.ranges = new RollingWindow(period);
    this.highs = new RollingWindow(period);
    this.lows = new RollingWindow(period);
  }

  get count(): number {
    return this.seen;
  }

  get value(): number | null {
    return this.latest;
  }

  update(bar: Bar): number | null {
    const tr = this.range.update(bar);
    this.seen += 1;
    this.ranges.push(tr);
    this.highs.push(bar.h);
    this.lows.push(bar.l);
    if (!this.ranges.full) return (this.latest = null);
    let sum = 0;
    let high = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.period; i += 1) {
      sum += this.ranges.at(i);
      high = Math.max(high, this.highs.at(i));
      low = Math.min(low, this.lows.at(i));
    }
    const span = high - low;
    if (span <= 0) return (this.latest = 100);
    return (this.latest = (100 * Math.log10(sum / span)) / Math.log10(this.period));
  }
}

export interface SqueezeValue {
  /** Bollinger bands are inside the Keltner channel (02_Signal_Engine section 4). */
  readonly on: boolean;
  /** Consecutive candles the squeeze has been on, including this one (0 when off). */
  readonly duration: number;
  /** The squeeze was on the candle before and is off now. */
  readonly released: boolean;
  /** Candles since the last release (0 on the release candle), or null if none happened yet. */
  readonly barsSinceRelease: number | null;
}

/** Squeeze: Bollinger(20, 2) inside Keltner(20, 1.5 x ATR). */
export class Squeeze implements Indicator<Bar, SqueezeValue> {
  readonly warmup: number;
  private readonly bollinger: Bollinger;
  private readonly keltner: Keltner;
  private seen = 0;
  private duration = 0;
  private sinceRelease: number | null = null;
  private latest: SqueezeValue | null = null;

  constructor(bollinger: Bollinger = new Bollinger(), keltner: Keltner = new Keltner()) {
    this.bollinger = bollinger;
    this.keltner = keltner;
    this.warmup = Math.max(bollinger.warmup, keltner.warmup);
  }

  get count(): number {
    return this.seen;
  }

  get value(): SqueezeValue | null {
    return this.latest;
  }

  update(bar: Bar): SqueezeValue | null {
    assertBar(bar);
    this.seen += 1;
    const bands = this.bollinger.update(bar.c);
    const channel = this.keltner.update(bar);
    if (bands === null || channel === null) return (this.latest = null);

    const on = bands.upper < channel.upper && bands.lower > channel.lower;
    const released = !on && this.duration > 0;
    this.duration = on ? this.duration + 1 : 0;
    if (released) this.sinceRelease = 0;
    else if (this.sinceRelease !== null) this.sinceRelease += 1;
    return (this.latest = {
      on,
      duration: this.duration,
      released,
      barsSinceRelease: this.sinceRelease,
    });
  }
}

/**
 * Where the newest value stands among the previous `window` values: the share of them (0 to 100)
 * that are less than or equal to it, as charting platforms define the percent rank. Used for the
 * "62nd percentile" of ATR, spread and bandwidth. Needs `window + 1` inputs.
 */
export class PercentileRank implements Indicator<number, number> {
  readonly warmup: number;
  private readonly items: RollingWindow;
  private seen = 0;
  private latest: number | null = null;

  constructor(readonly window: number) {
    assertPeriod(window, 'window');
    this.warmup = window + 1;
    this.items = new RollingWindow(window + 1);
  }

  get count(): number {
    return this.seen;
  }

  get value(): number | null {
    return this.latest;
  }

  update(input: number): number | null {
    assertFinite(input, 'input');
    this.seen += 1;
    this.items.push(input);
    if (!this.items.full) return (this.latest = null);
    let atOrBelow = 0;
    for (let i = 0; i < this.window; i += 1) {
      if (this.items.at(i) <= input) atOrBelow += 1;
    }
    return (this.latest = (100 * atOrBelow) / this.window);
  }
}
