import { HeikinAshi, computeSeries } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { heikinBar, heikinSeries, isChartType } from './chartTypes';
import {
  DEFAULT_PREFS,
  MAX_INDICATORS,
  parsePrefs,
  serializePrefs,
  toggleIndicator,
} from './chartPrefs';
import {
  MAX_DRAWINGS,
  clipSegment,
  fibPrices,
  newDrawingId,
  parseDrawings,
  serializeDrawings,
  withDrawing,
  type Drawing,
} from './drawings';

const trend = (id: string, kind: 'trend' | 'fib' = 'trend'): Drawing => ({
  id,
  kind,
  a: { t: 1_700_000_000, price: 4000 },
  b: { t: 1_700_003_600, price: 4010 },
});

describe('drawings', () => {
  it('measures the Fibonacci levels back from the second point', () => {
    const levels = fibPrices({ t: 1, price: 4000 }, { t: 2, price: 4100 });
    expect(levels.map((level) => level.ratio)).toEqual([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
    expect(levels[0]?.price).toBe(4100);
    expect(levels[3]?.price).toBe(4050);
    expect(levels[6]?.price).toBe(4000);
    expect(levels[4]?.price).toBeCloseTo(4100 - 100 * 0.618, 9);
  });

  it('is stored and read back as it was', () => {
    const list: Drawing[] = [
      { id: 'a', kind: 'hline', price: 4012.5 },
      trend('b'),
      trend('c', 'fib'),
    ];
    expect(parseDrawings(serializeDrawings(list))).toEqual(list);
  });

  it('keeps only what is a valid drawing, whatever local storage holds', () => {
    expect(parseDrawings(null)).toEqual([]);
    expect(parseDrawings('')).toEqual([]);
    expect(parseDrawings('{not json')).toEqual([]);
    expect(parseDrawings('{"a":1}')).toEqual([]);
    const good = { id: 'ok', kind: 'hline', price: 4000 };
    const raw = JSON.stringify([
      good,
      { id: 'ok', kind: 'hline', price: 4001 },
      { id: 'x', kind: 'hline', price: -5 },
      { id: 'y', kind: 'hline', price: 'high' },
      { id: 'z', kind: 'trend', a: { t: 1, price: 2 } },
      { id: 'w', kind: 'circle', price: 3 },
      { id: '', kind: 'hline', price: 3 },
      { id: 'v', kind: 'trend', a: { t: 1, price: 2 }, b: { t: Number.NaN, price: 3 } },
      null,
      7,
    ]);
    expect(parseDrawings(raw)).toEqual([good]);
  });

  it('holds at most the limit and drops the oldest first', () => {
    let list: Drawing[] = [];
    for (let i = 0; i < MAX_DRAWINGS + 5; i += 1) {
      list = withDrawing(list, { kind: 'hline', price: 4000 + i }, `id${String(i)}`);
    }
    expect(list).toHaveLength(MAX_DRAWINGS);
    expect(list[0]?.id).toBe('id5');
    expect(parseDrawings(serializeDrawings(list))).toHaveLength(MAX_DRAWINGS);
  });

  it('makes ids that differ, in the same millisecond too', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newDrawingId(1_700_000_000_000)));
    expect(ids.size).toBe(50);
  });
});

describe('the segment of a drawing on the chart', () => {
  const HOUR = 3600;
  const first = 1_700_000_000 - (1_700_000_000 % (5 * 60)); // an open of a 5 minute candle
  const last = first + 100 * 300;

  it('puts both ends on the open of their candle', () => {
    const segment = clipSegment(
      '5m',
      { t: first + 1000 + 17, price: 4000 },
      { t: first + 5000 + 211, price: 4020 },
      first,
      last,
    );
    if (segment === null) throw new Error('the segment is inside the candles');
    expect(segment[0].t % 300).toBe(0);
    expect(segment[1].t % 300).toBe(0);
    expect(segment[0].t).toBeLessThan(segment[1].t);
  });

  it('cuts a segment that begins before the first candle where the line crosses it, with the price of the line there', () => {
    const segment = clipSegment(
      '5m',
      { t: first - 1000, price: 4000 },
      { t: first + 1000, price: 4020 },
      first,
      last,
    );
    expect(segment?.[0].t).toBe(first);
    expect(segment?.[0].price).toBeCloseTo(4010, 9);
  });

  it('has no segment when the line is wholly before the first candle or after the last one', () => {
    expect(
      clipSegment('5m', { t: first - 5000, price: 1 }, { t: first - HOUR, price: 2 }, first, last),
    ).toBeNull();
    expect(
      clipSegment(
        '5m',
        { t: last + HOUR, price: 1 },
        { t: last + 2 * HOUR, price: 2 },
        first,
        last,
      ),
    ).toBeNull();
    // both points on the same candle: nothing to draw
    expect(
      clipSegment('5m', { t: first + 10, price: 1 }, { t: first + 20, price: 2 }, first, last),
    ).toBeNull();
  });

  it('takes the points in any order', () => {
    const forward = clipSegment(
      '5m',
      { t: first + 600, price: 1 },
      { t: first + 6000, price: 2 },
      first,
      last,
    );
    const backward = clipSegment(
      '5m',
      { t: first + 6000, price: 2 },
      { t: first + 600, price: 1 },
      first,
      last,
    );
    expect(backward).toEqual(forward);
  });
});

describe('chart preferences', () => {
  it('reads what was saved and falls back to the defaults for anything else', () => {
    const prefs = { indicators: ['rsi', 'macd'], chartType: 'heikin' } as const;
    expect(parsePrefs(serializePrefs(prefs))).toEqual(prefs);
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('nonsense')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('5')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{"indicators":"rsi","chartType":"pie"}')).toEqual(DEFAULT_PREFS);
  });

  it('drops indicators that do not exist, repeats and what is beyond the limit', () => {
    const raw = JSON.stringify({
      indicators: ['rsi', 'rsi', 'ema20', 'macd', 'atr', 'adx', 'stochrsi', 'bollinger', 'sar'],
      chartType: 'line',
    });
    const prefs = parsePrefs(raw);
    expect(prefs.chartType).toBe('line');
    expect(prefs.indicators).toHaveLength(MAX_INDICATORS);
    expect(prefs.indicators).not.toContain('ema20');
    expect(new Set(prefs.indicators).size).toBe(prefs.indicators.length);
  });

  it('switches an indicator on and off, and the oldest goes when there are too many', () => {
    expect(toggleIndicator([], 'rsi')).toEqual(['rsi']);
    expect(toggleIndicator(['rsi', 'macd'], 'rsi')).toEqual(['macd']);
    const full = toggleIndicator(['rsi', 'macd', 'atr', 'adx', 'stochrsi', 'bollinger'], 'sar');
    expect(full).toHaveLength(MAX_INDICATORS);
    expect(full[0]).toBe('macd');
    expect(full.at(-1)).toBe('sar');
  });

  it('knows its chart types', () => {
    expect(isChartType('line')).toBe(true);
    expect(isChartType('renko')).toBe(false);
  });
});

describe('Heikin Ashi', () => {
  const candles = Array.from({ length: 40 }, (_, i) => {
    const mid = 4000 + 12 * Math.sin(i / 3);
    const o = mid + Math.sin(i);
    const c = mid + Math.cos(i * 1.7);
    return { o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c };
  });

  it('draws the closed candles with the class of the core', () => {
    const own = computeSeries(new HeikinAshi(), candles);
    heikinSeries(candles).forEach((bar, i) => {
      expect(bar.c).toBeCloseTo(own[i]?.c ?? Number.NaN, 12);
      expect(bar.o).toBeCloseTo(own[i]?.o ?? Number.NaN, 12);
    });
  });

  it('gives for the forming candle the bar that the core would give once it has closed', () => {
    const closed = heikinSeries(candles.slice(0, -1));
    const forming = heikinBar(
      closed.at(-1) ?? null,
      candles.at(-1) ?? candles[0] ?? { o: 0, h: 0, l: 0, c: 0 },
    );
    const full = heikinSeries(candles).at(-1);
    expect(forming.o).toBeCloseTo(full?.o ?? Number.NaN, 12);
    expect(forming.h).toBeCloseTo(full?.h ?? Number.NaN, 12);
    expect(forming.l).toBeCloseTo(full?.l ?? Number.NaN, 12);
    expect(forming.c).toBeCloseTo(full?.c ?? Number.NaN, 12);
    // the first bar has no bar before it
    expect(heikinBar(null, { o: 10, h: 12, l: 9, c: 11 })).toEqual({
      o: 10.5,
      h: 12,
      l: 9,
      c: 10.5,
    });
  });

  it('draws a broken candle as it is instead of failing', () => {
    const broken = [{ o: Number.NaN, h: Number.NaN, l: Number.NaN, c: Number.NaN }];
    expect(heikinSeries(broken)).toHaveLength(1);
  });
});
