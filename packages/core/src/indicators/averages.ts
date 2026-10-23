import { type Indicator, RollingWindow, assertFinite, assertPeriod } from './types';

/** Simple moving average: the plain mean of the last `period` values. */
export class Sma implements Indicator<number, number> {
  readonly warmup: number;
  private readonly window: RollingWindow;
  private seen = 0;
  private latest: number | null = null;

  constructor(readonly period: number) {
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

  update(input: number): number | null {
    assertFinite(input, 'input');
    this.seen += 1;
    this.window.push(input);
    if (!this.window.full) return (this.latest = null);
    let sum = 0;
    for (let i = 0; i < this.period; i += 1) sum += this.window.at(i);
    return (this.latest = sum / this.period);
  }
}

/**
 * Exponential moving average with alpha = 2 / (period + 1). It starts with the simple average of
 * the first `period` values (the usual convention), so the first value appears at input `period`.
 * Older values never drop out completely: three times the period is the working rule of 02_Signal_Engine
 * section 2 before the value is trusted.
 */
export class Ema implements Indicator<number, number> {
  readonly warmup: number;
  private readonly alpha: number;
  private seen = 0;
  private seedSum = 0;
  private latest: number | null = null;

  constructor(readonly period: number) {
    assertPeriod(period);
    this.warmup = period;
    this.alpha = 2 / (period + 1);
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
    if (this.seen < this.period) {
      this.seedSum += input;
      return (this.latest = null);
    }
    if (this.seen === this.period) {
      this.seedSum += input;
      return (this.latest = this.seedSum / this.period);
    }
    const previous = this.latest ?? input;
    return (this.latest = input * this.alpha + previous * (1 - this.alpha));
  }
}

/** Linearly weighted moving average: the newest value weighs `period`, the oldest weighs 1. */
export class Wma implements Indicator<number, number> {
  readonly warmup: number;
  private readonly window: RollingWindow;
  private readonly weightSum: number;
  private seen = 0;
  private latest: number | null = null;

  constructor(readonly period: number) {
    assertPeriod(period);
    this.warmup = period;
    this.window = new RollingWindow(period);
    this.weightSum = (period * (period + 1)) / 2;
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
    let weighted = 0;
    for (let i = 0; i < this.period; i += 1) weighted += this.window.at(i) * (i + 1);
    return (this.latest = weighted / this.weightSum);
  }
}

/**
 * Hull moving average (Alan Hull): WMA of `2 x WMA(period / 2) - WMA(period)` over
 * `round(sqrt(period))` values. The half period is rounded down and the square root rounded to
 * the nearest whole number, as charting platforms do. Smooth and fast; its slope is the feature.
 */
export class Hull implements Indicator<number, number> {
  readonly warmup: number;
  private readonly half: Wma;
  private readonly full: Wma;
  private readonly smooth: Wma;
  private seen = 0;
  private latest: number | null = null;

  constructor(readonly period: number) {
    assertPeriod(period, 'period', 2);
    const root = Math.max(1, Math.round(Math.sqrt(period)));
    this.half = new Wma(Math.max(1, Math.floor(period / 2)));
    this.full = new Wma(period);
    this.smooth = new Wma(root);
    this.warmup = period + root - 1;
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
    const half = this.half.update(input);
    const full = this.full.update(input);
    if (half === null || full === null) return (this.latest = null);
    return (this.latest = this.smooth.update(2 * half - full));
  }
}
