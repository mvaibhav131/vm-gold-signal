import { aggregateMinutes, type MarketCandle } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import {
  ANCHOR,
  BAND,
  candlesResponse,
  ema,
  hash01,
  levels,
  minuteOhlc,
  priceAt,
  supertrend,
} from './world';

const MINUTE = 60_000;

describe('hash01', () => {
  it('is deterministic and stays in [0, 1)', () => {
    expect(hash01(123, 4)).toBe(hash01(123, 4));
    expect(hash01(123, 4)).not.toBe(hash01(123, 5));
    for (let n = 0; n < 5000; n += 1) {
      const v = hash01(n, 1);
      expect(v >= 0 && v < 1).toBe(true);
    }
  });
});

describe('the simulated price', () => {
  const start = Math.floor(Date.parse('2026-10-23T00:00:00Z') / MINUTE);

  it('never leaves the band around the anchor (so the simulated signals stay open)', () => {
    for (let m = start; m < start + 20 * 1440; m += 1) {
      const candle = minuteOhlc(m);
      expect(candle.h).toBeLessThan(ANCHOR + BAND);
      expect(candle.l).toBeGreaterThan(ANCHOR - BAND);
    }
  });

  it('is continuous: each 1m candle opens where the previous one closed', () => {
    for (let m = start; m < start + 2000; m += 1) {
      expect(minuteOhlc(m + 1).o).toBe(minuteOhlc(m).c);
    }
  });

  it('draws valid candles: the high is the highest and the low the lowest price', () => {
    for (let m = start; m < start + 2000; m += 1) {
      const { o, h, l, c } = minuteOhlc(m);
      expect(h).toBeGreaterThanOrEqual(Math.max(o, c));
      expect(l).toBeLessThanOrEqual(Math.min(o, c));
    }
  });

  it('gives the live price on the line between the surrounding minute prices', () => {
    const at = start * MINUTE;
    expect(priceAt(at)).toBeCloseTo(minuteOhlc(start).o, 2);
    const between = priceAt(at + 30_000);
    const low = Math.min(minuteOhlc(start).o, minuteOhlc(start).c);
    const high = Math.max(minuteOhlc(start).o, minuteOhlc(start).c);
    expect(between).toBeGreaterThanOrEqual(low - 0.001);
    expect(between).toBeLessThanOrEqual(high + 0.001);
  });
});

describe('candles', () => {
  const now = Date.parse('2026-10-23T10:07:30Z');

  it('leaves out the candle that is still forming', () => {
    const { candles } = candlesResponse({ tf: '5m', limit: 3, overlays: [], objects: [] }, now);
    // The 10:05 candle has run for 2.5 minutes only, so the last closed one opened at 10:00.
    expect(candles.map((c) => c.t)).toEqual([
      '2026-10-23T09:50:00.000Z',
      '2026-10-23T09:55:00.000Z',
      '2026-10-23T10:00:00.000Z',
    ]);
  });

  it('builds higher timeframes exactly as the B3 aggregator builds them from 1m candles', () => {
    const five = candlesResponse({ tf: '5m', limit: 20, overlays: [], objects: [] }, now).candles;
    const first = Date.parse(five[0]?.t ?? '') / MINUTE;
    const last = Date.parse(five.at(-1)?.t ?? '') / MINUTE + 5;
    const minutes: MarketCandle[] = [];
    for (let m = first; m < last; m += 1) {
      minutes.push({
        symbol: 'XAUUSD',
        tf: '1m',
        openTime: m * MINUTE,
        ...minuteOhlc(m),
        spreadAvg: null,
        spreadMax: null,
        tickCount: 0,
        complete: true,
        source: 'live',
      });
    }
    const viaCore = aggregateMinutes('XAUUSD', minutes).filter((c) => c.tf === '5m');
    expect(five.map(({ t, o, h, l, c }) => ({ openTime: Date.parse(t), o, h, l, c }))).toEqual(
      viaCore.map(({ openTime, o, h, l, c }) => ({ openTime, o, h, l, c })),
    );
  });

  it('puts every candle on its UTC boundary, one timeframe apart', () => {
    for (const [tf, step] of [
      ['1m', MINUTE],
      ['15m', 15 * MINUTE],
      ['1h', 60 * MINUTE],
      ['4h', 240 * MINUTE],
    ] as const) {
      const { candles } = candlesResponse({ tf, limit: 30, overlays: [], objects: [] }, now);
      const times = candles.map((c) => Date.parse(c.t));
      expect(
        times.every((t) => t % step === 0),
        tf,
      ).toBe(true);
      expect(
        times.slice(1).every((t, i) => t - (times[i] ?? 0) === step),
        tf,
      ).toBe(true);
    }
  });

  it('follows the New York trading day for 1d candles', () => {
    const { candles } = candlesResponse({ tf: '1d', limit: 5, overlays: [], objects: [] }, now);
    // 17:00 New York in October is 21:00 UTC.
    expect(candles.every((c) => c.t.endsWith('T21:00:00.000Z'))).toBe(true);
  });
});

describe('overlays', () => {
  it('ema skips the warm-up and follows a constant series', () => {
    const flat = ema(
      Array.from({ length: 30 }, () => 100),
      10,
    );
    expect(flat.slice(0, 9).every((v) => v === null)).toBe(true);
    expect(flat.slice(9).every((v) => v === 100)).toBe(true);
  });

  it('ema reacts faster for a shorter period', () => {
    const values = [
      ...Array.from({ length: 30 }, () => 100),
      ...Array.from({ length: 10 }, () => 110),
    ];
    expect(ema(values, 5).at(-1) ?? 0).toBeGreaterThan(ema(values, 20).at(-1) ?? 0);
  });

  it('supertrend sits below the price in an uptrend and above it in a downtrend', () => {
    const up = Array.from({ length: 60 }, (_, i) => ({
      o: 100 + i,
      h: 101 + i,
      l: 99.5 + i,
      c: 100.8 + i,
    }));
    const down = Array.from({ length: 60 }, (_, i) => ({
      o: 200 - i,
      h: 200.5 - i,
      l: 199 - i,
      c: 199.2 - i,
    }));
    const bandUp = supertrend(up).at(-1) ?? 0;
    const bandDown = supertrend(down).at(-1) ?? 0;
    expect(bandUp).toBeLessThan(up.at(-1)?.c ?? 0);
    expect(bandDown).toBeGreaterThan(down.at(-1)?.c ?? 0);
  });

  it('returns nothing before the period has passed', () => {
    expect(supertrend([{ o: 1, h: 2, l: 0.5, c: 1.5 }]).every((v) => v === null)).toBe(true);
  });
});

describe('chart objects', () => {
  it('are well formed at any time of the day (the mock follows the clock)', () => {
    const start = Date.parse('2026-10-20T00:00:00Z');
    for (let i = 0; i < 400; i += 1) {
      const now = start + i * 53 * 60_000 + 17_000;
      for (const tf of ['5m', '15m'] as const) {
        const { objects } = candlesResponse(
          { tf, limit: 200, overlays: [], objects: ['trendlines', 'zones', 'patterns', 'fib'] },
          now,
        );
        for (const object of objects) {
          const times = object.points.map((p) => Date.parse(p.t));
          if (object.type !== 'channel') {
            expect(times, `${object.id} at ${String(now)}`).toEqual(
              [...times].sort((a, b) => a - b),
            );
          }
          if (object.type === 'zone') {
            const [a, b] = object.points;
            expect(Math.abs((a?.price ?? 0) - (b?.price ?? 0))).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

describe('levels', () => {
  it('uses the real New York trading day and the real session of B3', () => {
    // 2026-10-23 10:07 UTC is the London session; the previous trading day ended 2026-10-22 21:00 UTC.
    const result = levels(Date.parse('2026-10-23T10:07:30Z'));
    const labels = result.map((l) => l.label);
    expect(labels).toEqual(expect.arrayContaining(['PDH', 'PDL', 'London high', 'London low']));
  });

  it('lists the round numbers around the price, the biggest step wins for a shared price', () => {
    const rounds = levels(Date.parse('2026-10-23T10:07:30Z')).filter((l) =>
      l.key.startsWith('round-'),
    );
    const byPrice = new Map(rounds.map((l) => [l.price, l.label]));
    expect(byPrice.get(4000)).toBe('$100 level');
    expect(byPrice.get(4050)).toBe('$50 level');
    expect(byPrice.get(4010)).toBe('$10 level');
  });
});
