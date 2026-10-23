import { type Bar, type Indicator, RollingWindow, assertBar, assertPeriod } from './types';
import { INDICATOR_DEFAULTS } from './volatility';

export interface AdxValue {
  /** Positive directional indicator: how strongly the highs are pushing up, 0 to 100. */
  readonly plusDI: number;
  /** Negative directional indicator: how strongly the lows are pushing down. */
  readonly minusDI: number;
  /** Directional movement index of this candle: the gap between the two, as a share of their sum. */
  readonly dx: number;
  /** Average directional index: how strong the trend is, in either direction, 0 to 100. */
  readonly adx: number;
}

/**
 * ADX with +DI and -DI (Wilder). True range and the two directional movements are smoothed with
 * Wilder's method (first value the sum of the first `period`, then `previous - previous / period +
 * new`); the DI values are their share of the true range, DX their normalised gap, and ADX the
 * Wilder average of DX (first value the mean of the first `period` DX). The first value needs
 * `2 x period` candles.
 */
export class Adx implements Indicator<Bar, AdxValue> {
  readonly warmup: number;
  private seen = 0;
  private previous: Bar | null = null;
  private changes = 0;
  private trSmooth = 0;
  private plusSmooth = 0;
  private minusSmooth = 0;
  private dxCount = 0;
  private dxSeed = 0;
  private adx = 0;
  private latest: AdxValue | null = null;

  constructor(readonly period: number = INDICATOR_DEFAULTS.adxPeriod) {
    assertPeriod(period);
    this.warmup = 2 * period;
  }

  get count(): number {
    return this.seen;
  }

  get value(): AdxValue | null {
    return this.latest;
  }

  update(bar: Bar): AdxValue | null {
    assertBar(bar);
    this.seen += 1;
    const before = this.previous;
    this.previous = bar;
    if (before === null) return (this.latest = null);

    const up = bar.h - before.h;
    const down = before.l - bar.l;
    const plus = up > down && up > 0 ? up : 0;
    const minus = down > up && down > 0 ? down : 0;
    const range = Math.max(bar.h - bar.l, Math.abs(bar.h - before.c), Math.abs(bar.l - before.c));

    this.changes += 1;
    if (this.changes <= this.period) {
      this.trSmooth += range;
      this.plusSmooth += plus;
      this.minusSmooth += minus;
      if (this.changes < this.period) return (this.latest = null);
    } else {
      this.trSmooth = this.trSmooth - this.trSmooth / this.period + range;
      this.plusSmooth = this.plusSmooth - this.plusSmooth / this.period + plus;
      this.minusSmooth = this.minusSmooth - this.minusSmooth / this.period + minus;
    }

    const plusDI = this.trSmooth === 0 ? 0 : (100 * this.plusSmooth) / this.trSmooth;
    const minusDI = this.trSmooth === 0 ? 0 : (100 * this.minusSmooth) / this.trSmooth;
    const total = plusDI + minusDI;
    const dx = total === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / total;

    this.dxCount += 1;
    if (this.dxCount < this.period) {
      this.dxSeed += dx;
      return (this.latest = null);
    }
    if (this.dxCount === this.period) this.adx = (this.dxSeed + dx) / this.period;
    else this.adx = (this.adx * (this.period - 1) + dx) / this.period;
    return (this.latest = { plusDI, minusDI, dx, adx: this.adx });
  }
}

export type CloudPosition = 'ABOVE' | 'INSIDE' | 'BELOW';

export interface IchimokuValue {
  /** Conversion line: midpoint of the highest high and lowest low of the last `tenkan` candles. */
  readonly tenkan: number;
  /** Base line, the same over `kijun` candles. */
  readonly kijun: number;
  /** The cloud edges that apply to this candle: they were computed `displacement` candles ago. */
  readonly spanA: number;
  readonly spanB: number;
  /** The cloud edges computed now; they will apply `displacement` candles from now. */
  readonly futureSpanA: number;
  readonly futureSpanB: number;
  readonly cloudTop: number;
  readonly cloudBottom: number;
  /** Height of the cloud now. */
  readonly thickness: number;
  /** Where the close is relative to the cloud now. */
  readonly position: CloudPosition;
  /** The close minus the close `displacement` candles ago (the lagging span's position against price). */
  readonly chikouDelta: number;
}

/**
 * Ichimoku cloud (9, 26, 52, 26). Everything is computed from this candle and earlier ones: the
 * cloud that applies to a candle is the one that was computed `displacement` candles before, so
 * nothing is shifted into the past. The first value needs `max(kijun, spanB) + displacement` candles.
 */
export class Ichimoku implements Indicator<Bar, IchimokuValue> {
  readonly warmup: number;
  private readonly highs: RollingWindow;
  private readonly lows: RollingWindow;
  private readonly closes: RollingWindow;
  private readonly spanAHistory: RollingWindow;
  private readonly spanBHistory: RollingWindow;
  private seen = 0;
  private latest: IchimokuValue | null = null;

  constructor(
    readonly tenkanPeriod: number = INDICATOR_DEFAULTS.ichimoku.tenkan,
    readonly kijunPeriod: number = INDICATOR_DEFAULTS.ichimoku.kijun,
    readonly spanBPeriod: number = INDICATOR_DEFAULTS.ichimoku.spanB,
    readonly displacement: number = INDICATOR_DEFAULTS.ichimoku.displacement,
  ) {
    assertPeriod(tenkanPeriod, 'tenkanPeriod');
    assertPeriod(kijunPeriod, 'kijunPeriod');
    assertPeriod(spanBPeriod, 'spanBPeriod');
    assertPeriod(displacement, 'displacement');
    const longest = Math.max(tenkanPeriod, kijunPeriod, spanBPeriod);
    this.highs = new RollingWindow(longest);
    this.lows = new RollingWindow(longest);
    this.closes = new RollingWindow(displacement + 1);
    this.spanAHistory = new RollingWindow(displacement + 1);
    this.spanBHistory = new RollingWindow(displacement + 1);
    this.warmup = Math.max(kijunPeriod, spanBPeriod, tenkanPeriod) + displacement;
  }

  get count(): number {
    return this.seen;
  }

  get value(): IchimokuValue | null {
    return this.latest;
  }

  /** Midpoint of the highest high and the lowest low of the last `period` candles, or NaN if fewer exist. */
  private midpoint(period: number): number {
    if (this.highs.length < period) return Number.NaN;
    let high = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    for (let back = 0; back < period; back += 1) {
      high = Math.max(high, this.highs.fromEnd(back));
      low = Math.min(low, this.lows.fromEnd(back));
    }
    return (high + low) / 2;
  }

  update(bar: Bar): IchimokuValue | null {
    assertBar(bar);
    this.seen += 1;
    this.highs.push(bar.h);
    this.lows.push(bar.l);
    this.closes.push(bar.c);

    const tenkan = this.midpoint(this.tenkanPeriod);
    const kijun = this.midpoint(this.kijunPeriod);
    const futureSpanB = this.midpoint(this.spanBPeriod);
    const futureSpanA = (tenkan + kijun) / 2;
    this.spanAHistory.push(futureSpanA);
    this.spanBHistory.push(futureSpanB);

    if (!this.spanAHistory.full) return (this.latest = null);
    const spanA = this.spanAHistory.at(0);
    const spanB = this.spanBHistory.at(0);
    if (Number.isNaN(spanA) || Number.isNaN(spanB) || Number.isNaN(tenkan) || Number.isNaN(kijun)) {
      return (this.latest = null);
    }
    const cloudTop = Math.max(spanA, spanB);
    const cloudBottom = Math.min(spanA, spanB);
    const position: CloudPosition =
      bar.c > cloudTop ? 'ABOVE' : bar.c < cloudBottom ? 'BELOW' : 'INSIDE';
    return (this.latest = {
      tenkan,
      kijun,
      spanA,
      spanB,
      futureSpanA,
      futureSpanB,
      cloudTop,
      cloudBottom,
      thickness: cloudTop - cloudBottom,
      position,
      chikouDelta: bar.c - this.closes.at(0),
    });
  }
}
