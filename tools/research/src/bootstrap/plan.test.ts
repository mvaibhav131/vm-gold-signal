import type { MarketCandle, Timeframe } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { BOOTSTRAP_TIMEFRAMES, planBootstrap } from './plan';

const MINUTE = 60_000;
const HOUR = 3_600_000;
/** A Wednesday, 10:00 UTC. */
const T = Date.UTC(2023, 0, 4, 10, 0, 0);

const candle = (tf: Timeframe, openTime: number): MarketCandle => ({
  symbol: 'XAUUSD',
  tf,
  openTime,
  o: 1,
  h: 1,
  l: 1,
  c: 1,
  spreadAvg: null,
  spreadMax: null,
  tickCount: 0,
  complete: true,
  source: 'histdata_bootstrap',
});

const keys = (candles: readonly MarketCandle[]): string[] =>
  candles.map((item) => `${item.tf}@${String((item.openTime - T) / MINUTE)}`);

describe('planBootstrap', () => {
  it('writes the timeframes of the engine and the charts, and no 1m candle', () => {
    const all: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
    const plan = planBootstrap(
      all.map((tf) => candle(tf, T - 24 * HOUR)),
      null,
    );
    expect(plan.write.map((item) => item.tf)).toEqual(BOOTSTRAP_TIMEFRAMES);
    expect(plan.overlapsLive).toBe(0);
    expect(plan.junction).toBeNull();
  });

  it('keeps what is over by the first live minute, the edge in', () => {
    const candles = [
      candle('5m', T),
      candle('5m', T + 5 * MINUTE),
      candle('5m', T + 10 * MINUTE),
      candle('15m', T),
    ];
    const plan = planBootstrap(candles, T + 10 * MINUTE);
    expect(keys(plan.write)).toEqual(['5m@0', '5m@5']);
    expect(plan.overlapsLive).toBe(2);
  });

  it('leaves out a candle that ends one millisecond after the first live minute', () => {
    const plan = planBootstrap(
      [candle('5m', T), candle('5m', T + 5 * MINUTE)],
      T + 10 * MINUTE - 1,
    );
    expect(keys(plan.write)).toEqual(['5m@0']);
    expect(plan.overlapsLive).toBe(1);
  });

  it('does not count a 1m candle as an overlap', () => {
    const plan = planBootstrap([candle('1m', T + 20 * MINUTE)], T);
    expect(plan.overlapsLive).toBe(0);
    expect(plan.write).toEqual([]);
  });

  it('measures the hole between the history and the live data in hours of an open market', () => {
    const plan = planBootstrap([candle('5m', T)], T + 5 * MINUTE + 3 * HOUR);
    expect(plan.junction).toEqual({
      fromMs: T + 5 * MINUTE,
      toMs: T + 5 * MINUTE + 3 * HOUR,
      tradingHours: 3,
    });
  });

  it('takes the newest 5m candle for the end of the history, whatever the order', () => {
    const plan = planBootstrap(
      [candle('5m', T + 5 * MINUTE), candle('5m', T + 10 * MINUTE), candle('5m', T)],
      T + HOUR,
    );
    expect(plan.junction?.fromMs).toBe(T + 15 * MINUTE);
  });

  it('does not count the weekend closure as a hole', () => {
    const fridayClose = Date.UTC(2023, 0, 6, 21, 55);
    const sundayEvening = Date.UTC(2023, 0, 8, 23, 0);
    const plan = planBootstrap([candle('5m', fridayClose)], sundayEvening);
    expect(plan.junction?.tradingHours).toBe(1);
  });

  it('has no hole when the live data starts right after the history, and none without live data or without 5m candles', () => {
    expect(planBootstrap([candle('5m', T)], T + 5 * MINUTE).junction).toBeNull();
    expect(planBootstrap([candle('5m', T)], null).junction).toBeNull();
    expect(planBootstrap([candle('1h', T)], T + 5 * HOUR).junction).toBeNull();
  });
});
