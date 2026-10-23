import {
  type Bar,
  type Indicator,
  RollingWindow,
  assertBar,
  assertFinite,
  assertPeriod,
} from './types';

function assertPositive(value: number, name: string): void {
  assertFinite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be above zero`);
}

/**
 * Realised volatility of the closes: the root of the mean squared log return over the last
 * `period` returns, per candle and not annualised (multiply by the square root of the number of
 * candles to scale it). The mean return is taken as zero, the usual convention for realised volatility.
 */
export class RealisedVolatility implements Indicator<number, number> {
  readonly warmup: number;
  private readonly returns: RollingWindow;
  private previous: number | null = null;
  private seen = 0;
  private latest: number | null = null;

  constructor(readonly period: number) {
    assertPeriod(period);
    this.warmup = period + 1;
    this.returns = new RollingWindow(period);
  }

  get count(): number {
    return this.seen;
  }

  get value(): number | null {
    return this.latest;
  }

  update(close: number): number | null {
    assertPositive(close, 'close');
    this.seen += 1;
    const before = this.previous;
    this.previous = close;
    if (before === null) return (this.latest = null);
    this.returns.push(Math.log(close / before));
    if (!this.returns.full) return (this.latest = null);
    let squares = 0;
    for (let i = 0; i < this.period; i += 1) squares += this.returns.at(i) ** 2;
    return (this.latest = Math.sqrt(squares / this.period));
  }
}

/**
 * Garman-Klass volatility: an estimator that uses the whole candle. One candle gives
 * `0.5 x ln(high/low)^2 - (2 ln 2 - 1) x ln(close/open)^2`; the value is the root of their mean
 * over the last `period` candles (per candle, not annualised, never below zero).
 */
export class GarmanKlass implements Indicator<Bar, number> {
  readonly warmup: number;
  private readonly variances: RollingWindow;
  private seen = 0;
  private latest: number | null = null;

  constructor(readonly period: number) {
    assertPeriod(period);
    this.warmup = period;
    this.variances = new RollingWindow(period);
  }

  get count(): number {
    return this.seen;
  }

  get value(): number | null {
    return this.latest;
  }

  update(bar: Bar): number | null {
    assertBar(bar);
    for (const [name, price] of [
      ['open', bar.o],
      ['high', bar.h],
      ['low', bar.l],
      ['close', bar.c],
    ] as const) {
      assertPositive(price, name);
    }
    this.seen += 1;
    const range = Math.log(bar.h / bar.l);
    const body = Math.log(bar.c / bar.o);
    this.variances.push(0.5 * range ** 2 - (2 * Math.LN2 - 1) * body ** 2);
    if (!this.variances.full) return (this.latest = null);
    let sum = 0;
    for (let i = 0; i < this.period; i += 1) sum += this.variances.at(i);
    return (this.latest = Math.sqrt(Math.max(0, sum / this.period)));
  }
}

/** One candle for the anchored mean: its prices and its weight (the tick count, the feed has no real volume). */
export interface WeightedBar {
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly weight: number;
}

export interface AnchoredMeanValue {
  /** Weighted mean of the typical prices since the anchor. */
  readonly mean: number;
  /** Weighted standard deviation of the typical prices around the mean. */
  readonly deviation: number;
  readonly upper1: number;
  readonly lower1: number;
  readonly upper2: number;
  readonly lower2: number;
  readonly totalWeight: number;
}

/**
 * Anchored mean price (a VWAP with tick count as volume): the weighted mean of the typical price
 * `(high + low + close) / 3` since an anchor (session open, a swing, the previous-day close),
 * with 1 and 2 standard deviation bands. Call `reset()` to move the anchor. The weights are tick
 * counts, so this is an approximation of a volume-weighted price. Candles with weight 0 count for
 * nothing; until some weight exists there is no value.
 */
export class AnchoredMean implements Indicator<WeightedBar, AnchoredMeanValue> {
  readonly warmup = 1;
  private seen = 0;
  private weight = 0;
  private mean = 0;
  private spread = 0;
  private latest: AnchoredMeanValue | null = null;

  get count(): number {
    return this.seen;
  }

  get value(): AnchoredMeanValue | null {
    return this.latest;
  }

  /** Starts a new anchor: everything before is forgotten (the count of inputs keeps running). */
  reset(): void {
    this.weight = 0;
    this.mean = 0;
    this.spread = 0;
    this.latest = null;
  }

  update(bar: WeightedBar): AnchoredMeanValue | null {
    assertFinite(bar.h, 'high');
    assertFinite(bar.l, 'low');
    assertFinite(bar.c, 'close');
    assertFinite(bar.weight, 'weight');
    if (bar.weight < 0) throw new RangeError('weight must not be negative');
    this.seen += 1;
    if (bar.weight > 0) {
      // West's weighted incremental update: stable for prices near 4000.
      const typical = (bar.h + bar.l + bar.c) / 3;
      const total = this.weight + bar.weight;
      const delta = typical - this.mean;
      const mean = this.mean + (bar.weight / total) * delta;
      this.spread += bar.weight * delta * (typical - mean);
      this.mean = mean;
      this.weight = total;
    }
    if (this.weight === 0) return (this.latest = null);
    const deviation = Math.sqrt(Math.max(0, this.spread / this.weight));
    return (this.latest = {
      mean: this.mean,
      deviation,
      upper1: this.mean + deviation,
      lower1: this.mean - deviation,
      upper2: this.mean + 2 * deviation,
      lower2: this.mean - 2 * deviation,
      totalWeight: this.weight,
    });
  }
}
