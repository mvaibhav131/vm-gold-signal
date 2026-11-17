import { HeikinAshi, computeSeries } from '@vmgs/core';

export const CHART_TYPES = ['candles', 'heikin', 'line'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const CHART_TYPE_LABELS: Readonly<Record<ChartType, string>> = {
  candles: 'Candles',
  heikin: 'Heikin Ashi',
  line: 'Line',
};

export function isChartType(value: unknown): value is ChartType {
  return typeof value === 'string' && (CHART_TYPES as readonly string[]).includes(value);
}

interface Ohlc {
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

/**
 * The Heikin Ashi bar of `bar`, given the one before it (null for the first). The same formula as `HeikinAshi` of the core,
 * for the candle that is still forming; the closed candles are drawn with the core's class itself.
 */
export function heikinBar(previous: Ohlc | null, bar: Ohlc): Ohlc {
  const c = (bar.o + bar.h + bar.l + bar.c) / 4;
  const o = previous ? (previous.o + previous.c) / 2 : (bar.o + bar.c) / 2;
  return { o, h: Math.max(bar.h, o, c), l: Math.min(bar.l, o, c), c };
}

/** Heikin Ashi bars of the closed candles (oldest first). A bar that the core refuses (a broken number) is drawn as it is. */
export function heikinSeries(candles: readonly Ohlc[]): Ohlc[] {
  try {
    const bars = computeSeries(new HeikinAshi(), candles);
    return candles.map((own, i) => {
      const bar = bars[i];
      return bar ? { o: bar.o, h: bar.h, l: bar.l, c: bar.c } : own;
    });
  } catch {
    return [...candles];
  }
}
