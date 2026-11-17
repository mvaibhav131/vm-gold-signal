import { describe, expect, it } from 'vitest';

import { mirrorCandle } from '../mirror';
import type { StructureCandle } from '../../structure/types';
import { HourlyTrendStrategy } from './tracker';
import { HOURLY_TREND_DEFAULTS, type HourlyTrendParams } from './types';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0);
const HOURLY: HourlyTrendParams = { ...HOURLY_TREND_DEFAULTS, everyMin: 60 };

/** One 1h candle that rises (or falls) by `step` and ends at `close`, with half a unit of wick on each side of its body. */
function hourCandle(h: number, close: number, step: number): StructureCandle {
  const open = close - step;
  return {
    openTime: T0 + h * HOUR,
    o: open,
    h: Math.max(open, close) + 0.5,
    l: Math.min(open, close) - 0.5,
    c: close,
  };
}

/** The 5m candle that opens `offsetMin` minutes after hour `h` (the default is the last one of the hour). */
function five(h: number, close: number, offsetMin = 55): StructureCandle {
  return {
    openTime: T0 + h * HOUR + offsetMin * MINUTE,
    o: close,
    h: close + 0.1,
    l: close - 0.1,
    c: close,
  };
}

/** `hours` 1h candles with a steady move of `step` an hour; the strategy has seen the 5m candle of the last one too. */
function run(hours: number, step: number, params = HOURLY, start = 4000): HourlyTrendStrategy {
  const strategy = new HourlyTrendStrategy(params);
  for (let h = 0; h < hours; h += 1) {
    const close = start + step * (h + 1);
    strategy.update('1h', hourCandle(h, close, step));
    strategy.update('5m', five(h, close));
  }
  return strategy;
}

describe('the hourly trend strategy', () => {
  it('buys with the trend at the 5m candle that closes an hour, stop 2.5 x ATR(1h) below the price', () => {
    const setup = run(260, 1).evaluate()?.setup;
    expect(setup).not.toBeNull();
    const close = 4000 + 260;
    expect(setup).toMatchObject({
      strategyKey: 'hourly_trend',
      side: 'BUY',
      setupKey: `hourly_trend:5m:${new Date(T0 + 259 * HOUR + 55 * MINUTE).toISOString().replace('.000Z', 'Z')}`,
      at: T0 + 259 * HOUR + 55 * MINUTE,
      close,
    });
    // the true range of every candle is 2 (the body 1 and half a unit of wick on each side): the ATR is 2
    expect(setup?.facts.atr1h).toBeCloseTo(2, 9);
    expect(setup?.facts.trend).toBe('UP');
    expect(setup?.facts.hourOpen).toBe(T0 + 259 * HOUR);
    expect(setup?.facts.hourClose).toBe(close);
    expect(setup?.stopLoss).toBeCloseTo(close - 2.5 * 2, 9);
    expect(setup?.facts.emaFast).toBeGreaterThan(setup?.facts.emaMid ?? Infinity);
    expect(setup?.facts.emaMid).toBeGreaterThan(setup?.facts.emaSlow ?? Infinity);
  });

  it('sells with a downtrend, and a mirrored market gives the mirrored setup exactly', () => {
    const down = run(260, -1, HOURLY, 4400).evaluate()?.setup;
    expect(down?.side).toBe('SELL');
    expect(down?.facts.trend).toBe('DOWN');
    expect(down?.stopLoss).toBeGreaterThan(down?.close ?? 0);

    const mirrored = new HourlyTrendStrategy(HOURLY);
    for (let h = 0; h < 260; h += 1) {
      const close = 4000 + (h + 1);
      mirrored.update('1h', mirrorCandle(hourCandle(h, close, 1)));
      mirrored.update('5m', mirrorCandle(five(h, close)));
    }
    const mirror = mirrored.evaluate()?.setup;
    const up = run(260, 1).evaluate()?.setup;
    expect(mirror?.side).toBe('SELL');
    expect(up?.side).toBe('BUY');
    // the same distance from the price to the stop, on the other side
    expect(Math.abs((mirror?.stopLoss ?? 0) - (mirror?.close ?? 0))).toBeCloseTo(
      Math.abs((up?.stopLoss ?? 0) - (up?.close ?? 0)),
      9,
    );
  });

  it('decides once an hour when it is asked to, and only on the 5m candle that closes the hour', () => {
    // the 5m candles inside the hour have no setup
    for (const minute of [0, 5, 25, 30, 50]) {
      const inside = run(259, 1);
      inside.update('5m', five(259, 4000 + 260, minute));
      expect(inside.evaluate()?.setup, `minute ${String(minute)}`).toBeNull();
    }
    // the candle of the last 5 minutes has it once the 1h candle is in; without it the newest 1h candle is an hour old
    const strategy = run(259, 1);
    strategy.update('5m', five(259, 4000 + 260));
    expect(strategy.evaluate()?.setup).toBeNull();
    strategy.update('1h', hourCandle(259, 4000 + 260, 1));
    expect(strategy.evaluate()?.setup?.side).toBe('BUY');
  });

  it('decides twice an hour by default, at :00 and :30, on the trend of the newest closed 1h candle', () => {
    const strategy = run(259, 1, HOURLY_TREND_DEFAULTS);
    const close = 4000 + 259;
    // the slot at :30 of hour 259 (the 5m candle that opened at :25) uses the 1h candle of hour 258
    strategy.update('5m', five(259, close + 0.2, 25));
    const half = strategy.evaluate()?.setup;
    expect(half).toMatchObject({
      side: 'BUY',
      at: T0 + 259 * HOUR + 25 * MINUTE,
      facts: { hourOpen: T0 + 258 * HOUR, hourClose: close },
    });
    // the slot at :00 of hour 260 (the candle of :55) uses the new 1h candle, and has another key
    strategy.update('1h', hourCandle(259, close + 1, 1));
    strategy.update('5m', five(259, close + 1));
    const full = strategy.evaluate()?.setup;
    expect(full?.facts.hourOpen).toBe(T0 + 259 * HOUR);
    expect(full?.setupKey).not.toBe(half?.setupKey);
    // the candles between the slots have none
    const between = run(259, 1, HOURLY_TREND_DEFAULTS);
    between.update('5m', five(259, close + 0.2, 20));
    expect(between.evaluate()?.setup).toBeNull();
  });

  it('has no decision when the newest 1h candle is old (a gap, the weekend)', () => {
    const strategy = run(259, 1, HOURLY_TREND_DEFAULTS);
    // 3 hours after the last 1h candle closed, a slot at :30
    strategy.update('5m', five(262, 4300, 25));
    expect(strategy.evaluate()?.setup).toBeNull();
  });

  it('has no setup before the slow average has its first value, or when the trend is not clear', () => {
    // 199 hours: the 200-hour average has no value yet
    expect(run(199, 1).evaluate()?.setup).toBeNull();
    expect(run(200, 1).evaluate()?.setup?.side).toBe('BUY');

    // a long rise, then a fall that takes the price under the slow average while the fast one is still above the middle one
    const strategy = new HourlyTrendStrategy(HOURLY);
    let close = 4000;
    for (let h = 0; h < 300; h += 1) {
      const step = h < 250 ? 1 : -9;
      close += step;
      strategy.update('1h', hourCandle(h, close, step));
      strategy.update('5m', five(h, close));
    }
    const setup = strategy.evaluate()?.setup;
    // either the averages disagree (no setup) or the whole stack has turned down (a SELL): never a BUY against a fall
    expect(setup === null || setup?.side === 'SELL').toBe(true);
  });

  it('makes one setup key for each slot, and the same key when asked again', () => {
    const keys = new Set<string>();
    const strategy = new HourlyTrendStrategy(HOURLY_TREND_DEFAULTS);
    for (let h = 0; h < 270; h += 1) {
      const close = 4000 + (h + 1);
      // the 5m candle of :25 closes at :30, before the 1h candle of this hour has closed
      for (const minute of [25, 55]) {
        if (minute === 55) strategy.update('1h', hourCandle(h, close, 1));
        strategy.update('5m', five(h, close, minute));
        const setup = strategy.evaluate()?.setup;
        if (setup) {
          expect(keys.has(setup.setupKey)).toBe(false);
          keys.add(setup.setupKey);
          expect(strategy.evaluate()?.setup?.setupKey).toBe(setup.setupKey);
        }
      }
    }
    // two for every hour from the first with a slow average (hour 200 on, and the :30 slot of hour 199 has none)
    expect(keys.size).toBe(2 * (270 - 199) - 1);
  });

  it('refuses candles that are out of order, broken numbers and bad parameters', () => {
    const strategy = new HourlyTrendStrategy(HOURLY);
    strategy.update('1h', hourCandle(5, 4005, 1));
    expect(() => {
      strategy.update('1h', hourCandle(4, 4004, 1));
    }).toThrow();
    strategy.update('5m', five(5, 4005));
    expect(() => {
      strategy.update('5m', five(4, 4004));
    }).toThrow();
    expect(() => {
      strategy.update('1h', { ...hourCandle(6, 4006, 1), h: Number.NaN });
    }).toThrow();
    expect(() => new HourlyTrendStrategy({ ...HOURLY, stopAtr1h: 0 })).toThrow(RangeError);
    for (const everyMin of [0, 7, 45, 120, 2.5]) {
      expect(() => new HourlyTrendStrategy({ ...HOURLY, everyMin }), String(everyMin)).toThrow(
        RangeError,
      );
    }
    expect(
      () =>
        new HourlyTrendStrategy({
          ...HOURLY,
          periods: { ...HOURLY.periods, emaSlow: 0 },
        }),
    ).toThrow();
  });

  it('ignores the 15m candles', () => {
    const strategy = run(260, 1);
    const before = strategy.evaluate()?.setup;
    strategy.update('15m', five(0, 1));
    strategy.update('15m', five(0, 1));
    expect(strategy.evaluate()?.setup).toEqual(before);
  });
});
