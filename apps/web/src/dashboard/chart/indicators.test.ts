import { Bollinger, Macd, Rsi, computeSeries } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import {
  INDICATORS,
  INDICATOR_IDS,
  OVERLAY_INDICATORS,
  PANE_INDICATORS,
  computeIndicator,
  isIndicatorId,
} from './indicators';

/** 300 candles that rise and fall: smooth enough to warm every indicator up, with real highs and lows. */
function candles(count = 300) {
  return Array.from({ length: count }, (_, i) => {
    const mid = 4000 + 30 * Math.sin(i / 17) + 8 * Math.sin(i / 5) + i * 0.05;
    const o = mid + Math.sin(i * 1.3);
    const c = mid + Math.cos(i * 0.9);
    return { o, h: Math.max(o, c) + 1.5, l: Math.min(o, c) - 1.5, c };
  });
}

describe('the indicator table', () => {
  it('has a spec for every id, split into overlays and panes, with the keys its series are read by', () => {
    expect([...OVERLAY_INDICATORS, ...PANE_INDICATORS].sort()).toEqual([...INDICATOR_IDS].sort());
    for (const id of INDICATOR_IDS) {
      const spec = INDICATORS[id];
      expect(spec.id).toBe(id);
      expect(spec.kind).toBe(
        (OVERLAY_INDICATORS as readonly string[]).includes(id) ? 'overlay' : 'pane',
      );
      expect(Object.keys(computeIndicator(id, candles(120))).sort(), id).toEqual(
        spec.series.map((series) => series.key).sort(),
      );
    }
  });

  it('knows its ids and nothing else', () => {
    expect(isIndicatorId('rsi')).toBe(true);
    expect(isIndicatorId('ema20')).toBe(false);
    expect(isIndicatorId(7)).toBe(false);
  });
});

describe('computeIndicator', () => {
  const data = candles();

  it('gives one value for every candle, and nothing before the indicator has warmed up', () => {
    for (const id of INDICATOR_IDS) {
      for (const [key, values] of Object.entries(computeIndicator(id, data))) {
        expect(values, `${id}.${key}`).toHaveLength(data.length);
        expect(values.at(-1), `${id}.${key} has a value at the end`).not.toBeNull();
        expect(values[0], `${id}.${key} starts empty`).toBeNull();
      }
    }
  });

  it('is the computation of the core, the one the engine runs', () => {
    const closes = data.map((candle) => candle.c);
    expect(computeIndicator('rsi', data).rsi).toEqual(computeSeries(new Rsi(), closes));
    const bands = computeSeries(new Bollinger(), closes);
    const upper = computeIndicator('bollinger', data).upper;
    expect(upper).toEqual(bands.map((band) => band?.upper ?? null));
    const lines = computeSeries(new Macd(), closes);
    const { macd, signal, histogram } = computeIndicator('macd', data);
    expect(macd).toEqual(lines.map((line) => line?.macd ?? null));
    expect(signal).toEqual(lines.map((line) => line?.signal ?? null));
    expect(histogram).toEqual(lines.map((line) => line?.histogram ?? null));
  });

  it('keeps the oscillators inside their range and the bands in order', () => {
    for (const value of computeIndicator('rsi', data).rsi ?? []) {
      if (value !== null) expect(value).toBeGreaterThanOrEqual(0);
      if (value !== null) expect(value).toBeLessThanOrEqual(100);
    }
    for (const id of ['stochrsi'] as const) {
      for (const values of Object.values(computeIndicator(id, data))) {
        for (const value of values) {
          if (value !== null) expect(value).toBeGreaterThanOrEqual(0);
          if (value !== null) expect(value).toBeLessThanOrEqual(100);
        }
      }
    }
    for (const id of ['bollinger', 'keltner', 'donchian'] as const) {
      const { upper, middle, lower } = computeIndicator(id, data);
      upper?.forEach((top, i) => {
        const mid = middle?.[i];
        const bottom = lower?.[i];
        if (top === null || mid === null || mid === undefined) return;
        expect(top, `${id} ${String(i)}`).toBeGreaterThanOrEqual(mid);
        expect(mid, `${id} ${String(i)}`).toBeGreaterThanOrEqual(
          bottom ?? Number.NEGATIVE_INFINITY,
        );
      });
    }
  });

  it('draws the histogram of the MACD as the line minus its signal', () => {
    const { macd, signal, histogram } = computeIndicator('macd', data);
    const i = data.length - 1;
    expect(histogram?.[i]).toBeCloseTo((macd?.[i] ?? 0) - (signal?.[i] ?? 0), 9);
  });

  it('does not take the chart down for a candle that the core refuses', () => {
    const broken = [
      ...data.slice(0, 60),
      { o: Number.NaN, h: Number.NaN, l: Number.NaN, c: Number.NaN },
    ];
    const result = computeIndicator('atr', broken);
    expect(result.atr).toHaveLength(broken.length);
    expect(result.atr?.every((value) => value === null)).toBe(true);
  });

  it('is empty for no candles', () => {
    expect(computeIndicator('rsi', []).rsi).toEqual([]);
  });
});
