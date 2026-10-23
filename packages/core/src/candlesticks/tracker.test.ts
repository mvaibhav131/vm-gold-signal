import { describe, expect, it } from 'vitest';

import { type Bar, computeSeries } from '../indicators/types';
import { Atr } from '../indicators/volatility';
import { MarketStructure } from '../structure/marketStructure';
import type { Direction } from '../structure/types';
import { candlesticksOf } from './detect';
import { k, mirror, ohlc, randomBars, timed } from './test-data';
import {
  CANDLE_DEFAULTS,
  CandlestickTracker,
  type CandlePattern,
  type CandlePatternName,
} from './index';

/** Runs the tracker the way the live worker does: structure first, then the tracker with its ATR. */
function run(bars: readonly Bar[]): CandlePattern[][] {
  const structure = new MarketStructure();
  const tracker = new CandlestickTracker('5m');
  return timed(bars).map((candle) => {
    structure.update(candle);
    return [...tracker.update(candle, structure.atr)];
  });
}

const MIRROR_NAME: Record<CandlePatternName, CandlePatternName> = {
  PIN_BAR: 'PIN_BAR',
  ENGULFING: 'ENGULFING',
  INSIDE_BAR: 'INSIDE_BAR',
  NR7: 'NR7',
  MORNING_STAR: 'EVENING_STAR',
  EVENING_STAR: 'MORNING_STAR',
};
const FLIP: Record<Direction, Direction> = { UP: 'DOWN', DOWN: 'UP' };
const keyOf = (p: CandlePattern) => `${p.name}:${p.direction ?? '-'}`;
const mirrorKeyOf = (p: CandlePattern) =>
  `${MIRROR_NAME[p.name]}:${p.direction === null ? '-' : FLIP[p.direction]}`;

describe('CandlestickTracker', () => {
  it('gives at every candle what candlesticksOf gives for all the candles so far', () => {
    for (const seed of [1, 2, 3]) {
      const bars = randomBars(seed, 600);
      const candles = timed(bars);
      const atrs = computeSeries(new Atr(), bars);
      run(bars).forEach((found, i) => {
        expect(found).toEqual(
          candlesticksOf(candles.slice(0, i + 1), i + 1, atrs[i] ?? null, '5m'),
        );
      });
    }
  });

  it('finds every kind of pattern on long random series, in both directions where there are two', () => {
    const seen = new Map<string, number>();
    for (const seed of [11, 12, 13]) {
      for (const found of run(randomBars(seed, 1500))) {
        for (const p of found) seen.set(keyOf(p), (seen.get(keyOf(p)) ?? 0) + 1);
      }
    }
    for (const key of [
      'PIN_BAR:UP',
      'PIN_BAR:DOWN',
      'ENGULFING:UP',
      'ENGULFING:DOWN',
      'INSIDE_BAR:-',
      'NR7:-',
      'MORNING_STAR:UP',
      'EVENING_STAR:DOWN',
    ]) {
      expect(seen.get(key) ?? 0, key).toBeGreaterThan(0);
    }
  });

  it('answers the same at a candle with or without the candles that come later', () => {
    const bars = randomBars(5, 400);
    expect(JSON.stringify(run(bars).slice(0, 300))).toBe(JSON.stringify(run(bars.slice(0, 300))));
  });

  it('is not fooled by a mirrored series: every answer is the mirror image', () => {
    const bars = randomBars(8, 600);
    const down = run(bars.map((b) => mirror(b, 8000)));
    run(bars).forEach((found, i) => {
      expect((down[i] ?? []).map(keyOf)).toEqual(found.map(mirrorKeyOf));
    });
  });

  it('numbers the candles from the first one it was given and counts them', () => {
    const tracker = new CandlestickTracker('15m');
    const [first, second] = timed([ohlc(100, 100.1, 98.5, 100.05), k(100, 100.2)]);
    if (!first || !second) throw new Error('fixture');
    expect(tracker.count).toBe(0);
    expect(tracker.update(first, 1)[0]).toMatchObject({ id: '15mPIN:UP:0', index: 0 });
    tracker.update(second, 1);
    expect(tracker.count).toBe(2);
  });

  it('honours a different NR lookback', () => {
    const tracker = new CandlestickTracker('5m', {
      ...CANDLE_DEFAULTS,
      narrowRange: { lookback: 3 },
    });
    const bars = [k(100, 101, 0.5), k(100, 101, 0.4), k(100, 100.2, 0.05)];
    const found = timed(bars).map((c) => tracker.update(c, null).filter((p) => p.name === 'NR7'));
    expect(found.map((f) => f.length)).toEqual([0, 0, 1]);
  });

  it('refuses a candle that is not newer than the last one, or that is malformed', () => {
    const tracker = new CandlestickTracker('5m');
    const [first, second] = timed([k(100, 100.5), k(100.5, 101)]);
    if (!first || !second) throw new Error('fixture');
    tracker.update(second, 1);
    expect(() => tracker.update(first, 1)).toThrow(RangeError);
    expect(() => tracker.update(second, 1)).toThrow(RangeError);
    const broken = { ...second, openTime: second.openTime + 300_000, h: 99, l: 101 };
    expect(() => tracker.update(broken, 1)).toThrow(RangeError);
  });
});
