import { Ema, Sma } from './averages';
import {
  type Bar,
  type Indicator,
  RollingWindow,
  assertBar,
  assertFinite,
  assertPeriod,
} from './types';
import { INDICATOR_DEFAULTS } from './volatility';

/**
 * Relative strength index (Wilder). The first value uses the plain average of the first `period`
 * gains and losses, then Wilder smoothing. `100 - 100 / (1 + average gain / average loss)`;
 * no losses means 100, no gains means 0, and a window where nothing moved is neutral (50).
 */
export class Rsi implements Indicator<number, number> {
  readonly warmup: number;
  private seen = 0;
  private previous: number | null = null;
  private gainSeed = 0;
  private lossSeed = 0;
  private averageGain = 0;
  private averageLoss = 0;
  private latest: number | null = null;

  constructor(readonly period: number = INDICATOR_DEFAULTS.rsiPeriod) {
    assertPeriod(period);
    this.warmup = period + 1;
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
    const before = this.previous;
    this.previous = close;
    if (before === null) return (this.latest = null);

    const change = close - before;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    const changes = this.seen - 1;
    if (changes < this.period) {
      this.gainSeed += gain;
      this.lossSeed += loss;
      return (this.latest = null);
    }
    if (changes === this.period) {
      this.averageGain = (this.gainSeed + gain) / this.period;
      this.averageLoss = (this.lossSeed + loss) / this.period;
    } else {
      this.averageGain = (this.averageGain * (this.period - 1) + gain) / this.period;
      this.averageLoss = (this.averageLoss * (this.period - 1) + loss) / this.period;
    }
    if (this.averageLoss === 0) return (this.latest = this.averageGain === 0 ? 50 : 100);
    if (this.averageGain === 0) return (this.latest = 0);
    return (this.latest = 100 - 100 / (1 + this.averageGain / this.averageLoss));
  }
}

export interface StochRsiValue {
  /** Where the RSI stands in its own range of the last `stochPeriod` values, 0 to 100 (50 when it has no range). */
  readonly raw: number;
  /** `raw` smoothed with a simple average. */
  readonly k: number;
  /** `k` smoothed again. */
  readonly d: number;
}

/** Stochastic RSI: the stochastic oscillator applied to the RSI instead of the price. */
export class StochRsi implements Indicator<number, StochRsiValue> {
  readonly warmup: number;
  private readonly rsi: Rsi;
  private readonly window: RollingWindow;
  private readonly kAverage: Sma;
  private readonly dAverage: Sma;
  private seen = 0;
  private latest: StochRsiValue | null = null;

  constructor(
    rsiPeriod: number = INDICATOR_DEFAULTS.stochRsi.rsiPeriod,
    readonly stochPeriod: number = INDICATOR_DEFAULTS.stochRsi.stochPeriod,
    kSmooth: number = INDICATOR_DEFAULTS.stochRsi.kSmooth,
    dSmooth: number = INDICATOR_DEFAULTS.stochRsi.dSmooth,
  ) {
    assertPeriod(stochPeriod, 'stochPeriod', 2);
    this.rsi = new Rsi(rsiPeriod);
    this.window = new RollingWindow(stochPeriod);
    this.kAverage = new Sma(kSmooth);
    this.dAverage = new Sma(dSmooth);
    this.warmup = this.rsi.warmup + stochPeriod - 1 + (kSmooth - 1) + (dSmooth - 1);
  }

  get count(): number {
    return this.seen;
  }

  get value(): StochRsiValue | null {
    return this.latest;
  }

  update(close: number): StochRsiValue | null {
    this.seen += 1;
    const rsi = this.rsi.update(close);
    if (rsi === null) return (this.latest = null);
    this.window.push(rsi);
    if (!this.window.full) return (this.latest = null);
    let high = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.stochPeriod; i += 1) {
      high = Math.max(high, this.window.at(i));
      low = Math.min(low, this.window.at(i));
    }
    const raw = high === low ? 50 : 100 * ((rsi - low) / (high - low));
    const k = this.kAverage.update(raw);
    if (k === null) return (this.latest = null);
    const d = this.dAverage.update(k);
    if (d === null) return (this.latest = null);
    return (this.latest = { raw, k, d });
  }
}

export interface MacdValue {
  /** Fast EMA minus slow EMA. */
  readonly macd: number;
  /** EMA of the MACD line. */
  readonly signal: number;
  /** MACD minus signal. */
  readonly histogram: number;
  /** Histogram minus the histogram of the candle before, or null for the first value. */
  readonly histogramChange: number | null;
}

/** MACD(12, 26, 9) on the close: fast and slow EMA, a signal EMA of their difference, and the histogram. */
export class Macd implements Indicator<number, MacdValue> {
  readonly warmup: number;
  private readonly fast: Ema;
  private readonly slow: Ema;
  private readonly signalAverage: Ema;
  private seen = 0;
  private previousHistogram: number | null = null;
  private latest: MacdValue | null = null;

  constructor(
    fastPeriod: number = INDICATOR_DEFAULTS.macd.fast,
    slowPeriod: number = INDICATOR_DEFAULTS.macd.slow,
    signalPeriod: number = INDICATOR_DEFAULTS.macd.signal,
  ) {
    if (fastPeriod >= slowPeriod)
      throw new RangeError('the fast period must be shorter than the slow one');
    this.fast = new Ema(fastPeriod);
    this.slow = new Ema(slowPeriod);
    this.signalAverage = new Ema(signalPeriod);
    this.warmup = slowPeriod + signalPeriod - 1;
  }

  get count(): number {
    return this.seen;
  }

  get value(): MacdValue | null {
    return this.latest;
  }

  update(close: number): MacdValue | null {
    this.seen += 1;
    const fast = this.fast.update(close);
    const slow = this.slow.update(close);
    if (fast === null || slow === null) return (this.latest = null);
    const macd = fast - slow;
    const signal = this.signalAverage.update(macd);
    if (signal === null) return (this.latest = null);
    const histogram = macd - signal;
    const histogramChange =
      this.previousHistogram === null ? null : histogram - this.previousHistogram;
    this.previousHistogram = histogram;
    return (this.latest = { macd, signal, histogram, histogramChange });
  }
}

/** Rate of change: `100 x (close - close n candles ago) / close n candles ago`. */
export class Roc implements Indicator<number, number> {
  readonly warmup: number;
  private readonly window: RollingWindow;
  private seen = 0;
  private latest: number | null = null;

  constructor(readonly period: number = INDICATOR_DEFAULTS.rocPeriod) {
    assertPeriod(period);
    this.warmup = period + 1;
    this.window = new RollingWindow(period + 1);
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
    this.window.push(close);
    if (!this.window.full) return (this.latest = null);
    const base = this.window.at(0);
    return (this.latest = base === 0 ? 0 : (100 * (close - base)) / base);
  }
}

/** The plain difference between the newest value and the one `lookback` inputs ago (slopes, "rising for n candles"). */
export class Change implements Indicator<number, number> {
  readonly warmup: number;
  private readonly window: RollingWindow;
  private seen = 0;
  private latest: number | null = null;

  constructor(readonly lookback: number) {
    assertPeriod(lookback, 'lookback');
    this.warmup = lookback + 1;
    this.window = new RollingWindow(lookback + 1);
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
    this.window.push(input);
    if (!this.window.full) return (this.latest = null);
    return (this.latest = input - this.window.at(0));
  }
}

/**
 * Commodity channel index: `(typical price - its average) / (0.015 x mean deviation)` over the
 * last `period` candles, typical price = (high + low + close) / 3. Zero deviation gives 0.
 */
export class Cci implements Indicator<Bar, number> {
  readonly warmup: number;
  private readonly window: RollingWindow;
  private seen = 0;
  private latest: number | null = null;

  constructor(readonly period: number = INDICATOR_DEFAULTS.cciPeriod) {
    assertPeriod(period);
    this.warmup = period;
    this.window = new RollingWindow(period);
  }

  get count(): number {
    return this.seen;
  }

  get value(): number | null {
    return this.latest;
  }

  update(bar: Bar): number | null {
    assertBar(bar);
    this.seen += 1;
    const typical = (bar.h + bar.l + bar.c) / 3;
    this.window.push(typical);
    if (!this.window.full) return (this.latest = null);
    let sum = 0;
    for (let i = 0; i < this.period; i += 1) sum += this.window.at(i);
    const mean = sum / this.period;
    let deviation = 0;
    for (let i = 0; i < this.period; i += 1) deviation += Math.abs(this.window.at(i) - mean);
    deviation /= this.period;
    return (this.latest = deviation === 0 ? 0 : (typical - mean) / (0.015 * deviation));
  }
}

/**
 * Williams %R: `-100 x (highest high - close) / (highest high - lowest low)` over the last
 * `period` candles, from -100 (at the low) to 0 (at the high). No range at all is neutral (-50).
 */
export class WilliamsR implements Indicator<Bar, number> {
  readonly warmup: number;
  private readonly highs: RollingWindow;
  private readonly lows: RollingWindow;
  private seen = 0;
  private latest: number | null = null;

  constructor(readonly period: number = INDICATOR_DEFAULTS.williamsPeriod) {
    assertPeriod(period);
    this.warmup = period;
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
    assertBar(bar);
    this.seen += 1;
    this.highs.push(bar.h);
    this.lows.push(bar.l);
    if (!this.highs.full) return (this.latest = null);
    let high = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.period; i += 1) {
      high = Math.max(high, this.highs.at(i));
      low = Math.min(low, this.lows.at(i));
    }
    return (this.latest = high === low ? -50 : 100 * ((bar.c - high) / (high - low)));
  }
}

/** Awesome oscillator: SMA(5) minus SMA(34) of the median price (high + low) / 2. */
export class AwesomeOscillator implements Indicator<Bar, number> {
  readonly warmup: number;
  private readonly fast: Sma;
  private readonly slow: Sma;
  private seen = 0;
  private latest: number | null = null;

  constructor(
    fastPeriod: number = INDICATOR_DEFAULTS.awesome.fast,
    slowPeriod: number = INDICATOR_DEFAULTS.awesome.slow,
  ) {
    if (fastPeriod >= slowPeriod)
      throw new RangeError('the fast period must be shorter than the slow one');
    this.fast = new Sma(fastPeriod);
    this.slow = new Sma(slowPeriod);
    this.warmup = slowPeriod;
  }

  get count(): number {
    return this.seen;
  }

  get value(): number | null {
    return this.latest;
  }

  update(bar: Bar): number | null {
    assertBar(bar);
    this.seen += 1;
    const median = (bar.h + bar.l) / 2;
    const fast = this.fast.update(median);
    const slow = this.slow.update(median);
    if (fast === null || slow === null) return (this.latest = null);
    return (this.latest = fast - slow);
  }
}
