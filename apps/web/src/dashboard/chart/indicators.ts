import {
  Adx,
  Atr,
  Bollinger,
  Donchian,
  Ichimoku,
  Keltner,
  Macd,
  ParabolicSar,
  Rsi,
  StochRsi,
  computeSeries,
} from '@vmgs/core';

import { INDICATORS, type IndicatorId } from './indicatorSpecs';

export * from './indicatorSpecs';

interface Ohlc {
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

/** The values of one indicator, one list per series (`SeriesSpec.key`), each as long as the candles; null while warming up. */
export type IndicatorValues = Readonly<Record<string, (number | null)[]>>;

function split<T>(
  values: readonly (T | null)[],
  pick: Readonly<Record<string, (value: T) => number>>,
): Record<string, (number | null)[]> {
  const out: Record<string, (number | null)[]> = {};
  for (const [key, read] of Object.entries(pick)) {
    out[key] = values.map((value) => (value === null ? null : read(value)));
  }
  return out;
}

function compute(id: IndicatorId, candles: readonly Ohlc[]): Record<string, (number | null)[]> {
  const closes = candles.map((candle) => candle.c);
  switch (id) {
    case 'bollinger':
      return split(computeSeries(new Bollinger(), closes), {
        upper: (v) => v.upper,
        middle: (v) => v.middle,
        lower: (v) => v.lower,
      });
    case 'keltner':
      return split(computeSeries(new Keltner(), candles), {
        upper: (v) => v.upper,
        middle: (v) => v.middle,
        lower: (v) => v.lower,
      });
    case 'donchian':
      return split(computeSeries(new Donchian(), candles), {
        upper: (v) => v.upper,
        middle: (v) => v.middle,
        lower: (v) => v.lower,
      });
    case 'sar':
      return split(computeSeries(new ParabolicSar(), candles), { sar: (v) => v.sar });
    case 'ichimoku':
      return split(computeSeries(new Ichimoku(), candles), {
        tenkan: (v) => v.tenkan,
        kijun: (v) => v.kijun,
        spanA: (v) => v.spanA,
        spanB: (v) => v.spanB,
      });
    case 'rsi':
      return { rsi: computeSeries(new Rsi(), closes) };
    case 'macd':
      return split(computeSeries(new Macd(), closes), {
        macd: (v) => v.macd,
        signal: (v) => v.signal,
        histogram: (v) => v.histogram,
      });
    case 'atr':
      return { atr: computeSeries(new Atr(), candles) };
    case 'adx':
      return split(computeSeries(new Adx(), candles), {
        adx: (v) => v.adx,
        plusDI: (v) => v.plusDI,
        minusDI: (v) => v.minusDI,
      });
    case 'stochrsi':
      return split(computeSeries(new StochRsi(), closes), { k: (v) => v.k, d: (v) => v.d });
  }
}

/**
 * One indicator over the candles (oldest first). A candle that the core refuses (a broken number) must not take the chart
 * down: the indicator is then empty.
 */
export function computeIndicator(id: IndicatorId, candles: readonly Ohlc[]): IndicatorValues {
  try {
    return compute(id, candles);
  } catch {
    const empty = candles.map(() => null);
    return Object.fromEntries(INDICATORS[id].series.map((series) => [series.key, empty]));
  }
}
