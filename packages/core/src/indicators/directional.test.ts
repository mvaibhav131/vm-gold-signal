import { describe, expect, it } from 'vitest';

import { Adx, Ichimoku } from './directional';
import { bar, round, roundAll } from './test-data';
import { computeSeries } from './types';

/** Bars given as [high, low, close]; the open is not used by these indicators. */
const hlc = (rows: readonly (readonly [number, number, number])[]) =>
  rows.map(([h, l, c]) => bar(c, h, l, c));

describe('Adx', () => {
  const rows = hlc([
    [10, 8, 9],
    [11, 9, 10.5],
    [12, 10, 11.5],
    [11.5, 9.5, 10],
    [11, 9, 9.5],
  ]);

  it('follows Wilder smoothing of true range and directional movement (hand-checked, period 2)', () => {
    const values = computeSeries(new Adx(2), rows);
    expect(values.slice(0, 3)).toEqual([null, null, null]);
    // index 3: smoothed TR 4, +DM 1, -DM 0.5 -> +DI 25, -DI 12.5, DX 33.33, ADX = (100 + 33.33) / 2
    expect(round(values[3]?.plusDI ?? null, 4)).toBe(25);
    expect(round(values[3]?.minusDI ?? null, 4)).toBe(12.5);
    expect(round(values[3]?.dx ?? null, 4)).toBe(33.3333);
    expect(round(values[3]?.adx ?? null, 4)).toBe(66.6667);
    // index 4: smoothed TR 4, +DM 0.5, -DM 0.75 -> +DI 12.5, -DI 18.75, DX 20, ADX = (66.67 + 20) / 2
    expect(round(values[4]?.plusDI ?? null, 4)).toBe(12.5);
    expect(round(values[4]?.minusDI ?? null, 4)).toBe(18.75);
    expect(round(values[4]?.dx ?? null, 4)).toBe(20);
    expect(round(values[4]?.adx ?? null, 4)).toBe(43.3333);
  });

  it('needs 2 x period candles', () => {
    expect(new Adx().warmup).toBe(28);
    expect(new Adx(2).warmup).toBe(4);
  });

  it('reads a steady climb as a strong up trend', () => {
    const climb = hlc(Array.from({ length: 40 }, (_, i) => [10 + i + 1, 10 + i, 10 + i + 0.5]));
    const last = computeSeries(new Adx(14), climb).at(-1);
    expect(last?.plusDI).toBeGreaterThan(40);
    expect(last?.minusDI).toBe(0);
    expect(last?.adx).toBeGreaterThan(90);
  });

  it('is 0 with no movement at all', () => {
    const flat = hlc(Array.from({ length: 10 }, () => [5, 5, 5] as const));
    expect(computeSeries(new Adx(3), flat).at(-1)).toEqual({
      plusDI: 0,
      minusDI: 0,
      dx: 0,
      adx: 0,
    });
  });
});

describe('Ichimoku', () => {
  // highs 5..11 and lows 3..9, close at the middle: a straight climb of 1 per candle.
  const climb = hlc(Array.from({ length: 7 }, (_, i) => [5 + i, 3 + i, 4 + i] as const));

  it('computes the lines from the candles, and the cloud from the candles `displacement` ago (hand-checked)', () => {
    const indicator = new Ichimoku(2, 3, 4, 2);
    expect(indicator.warmup).toBe(6);
    const values = computeSeries(indicator, climb);
    expect(values.slice(0, 5).every((v) => v === null)).toBe(true);
    // index 5: tenkan = mid of highs/lows of the last 2 = (10 + 7) / 2, kijun over 3 = (10 + 6) / 2
    expect(values[5]).toEqual({
      tenkan: 8.5,
      kijun: 8,
      spanA: 6.25,
      spanB: 5.5,
      futureSpanA: 8.25,
      futureSpanB: 7.5,
      cloudTop: 6.25,
      cloudBottom: 5.5,
      thickness: 0.75,
      position: 'ABOVE',
      chikouDelta: 2,
    });
  });

  it('knows when the close is inside or below the cloud', () => {
    const below = computeSeries(new Ichimoku(2, 3, 4, 2), [
      ...climb,
      bar(2, 3, 1, 2),
      bar(2, 3, 1, 2),
    ]);
    expect(below.at(-1)?.position).toBe('BELOW');
    const inside = computeSeries(new Ichimoku(2, 3, 4, 2), [...climb, bar(8, 8.5, 7.5, 8)]);
    expect(inside.at(-1)?.position).toBe('INSIDE');
  });

  it('does not look ahead: the cloud now was computed before now', () => {
    // changing a future candle cannot move the cloud already drawn for an earlier candle
    const base = computeSeries(new Ichimoku(2, 3, 4, 2), climb);
    const changed = computeSeries(new Ichimoku(2, 3, 4, 2), [
      ...climb.slice(0, 6),
      bar(100, 200, 1, 100),
    ]);
    expect(changed[5]).toEqual(base[5]);
  });

  it('has the standard 9/26/52/26 settings by default (first value after 78 candles)', () => {
    const indicator = new Ichimoku();
    expect(indicator.warmup).toBe(78);
    const rising = hlc(Array.from({ length: 100 }, (_, i) => [i + 2, i, i + 1] as const));
    const values = computeSeries(indicator, rising);
    expect(values.findIndex((v) => v !== null)).toBe(77);
    expect(roundAll([values.at(-1)?.thickness ?? null])).not.toEqual([null]);
  });

  it('refuses bad settings', () => {
    expect(() => new Ichimoku(0, 26, 52, 26)).toThrow(RangeError);
    expect(() => new Ichimoku(9, 26, 52, 0)).toThrow(RangeError);
  });
});
