import { describe, expect, it } from 'vitest';

import { LEAN_MIN_CANDLES, leanLine, marketLeanOf } from './lean';
import type { StatCandle } from './stats';

const T0 = Date.UTC(2026, 10, 23, 6, 0, 0);

/** 5-minute candles from a list of close-to-close moves, each with a range of `range` around its body. */
function series(moves: readonly number[], start = 4000, range = 0.6): StatCandle[] {
  let previous = start;
  return moves.map((move, index) => {
    const c = previous + move;
    const candle = {
      openTime: T0 + index * 300_000,
      o: previous,
      h: Math.max(previous, c) + range / 2,
      l: Math.min(previous, c) - range / 2,
      c,
    };
    previous = c;
    return candle;
  });
}

const repeat = (move: number, times: number): number[] => Array.from({ length: times }, () => move);
const alternate = (a: number, b: number, pairs: number): number[] =>
  Array.from({ length: pairs * 2 }, (_, index) => (index % 2 === 0 ? a : b));

describe('where the indicators lean', () => {
  it('needs 50 candles', () => {
    expect(marketLeanOf(series(repeat(0.3, LEAN_MIN_CANDLES - 1)))).toBeNull();
    expect(marketLeanOf([])).toBeNull();
  });

  it('has nothing to say when the candles have no range at all', () => {
    expect(marketLeanOf(series(repeat(0, 60), 4000, 0))).toBeNull();
  });

  it('says a bounce is possible after a long fall: RSI low, far below the average, down in the last hour', () => {
    const lean = marketLeanOf(series([...alternate(0.3, -0.3, 20), ...repeat(-1.5, 20)]));
    expect(lean).toMatchObject({ kind: 'BOUNCE_POSSIBLE', trend: 'DOWN' });
    expect(lean?.rsi).toBeLessThanOrEqual(30);
    expect(lean?.hourMoveAtr).toBeLessThan(0);
    expect(lean?.stretchAtr).toBeLessThan(0);
  });

  it('says a pullback is possible after a long rise, the mirror of the fall', () => {
    const lean = marketLeanOf(series([...alternate(-0.3, 0.3, 20), ...repeat(1.5, 20)]));
    expect(lean).toMatchObject({ kind: 'PULLBACK_POSSIBLE', trend: 'UP' });
    expect(lean?.rsi).toBeGreaterThanOrEqual(70);
    expect(lean?.hourMoveAtr).toBeGreaterThan(0);
  });

  it('says the fall is with the trend when it is steady and not stretched', () => {
    const lean = marketLeanOf(series(alternate(-1, 0.6, 30)));
    expect(lean).toMatchObject({ kind: 'DOWN_WITH_TREND', trend: 'DOWN' });
    expect(lean?.rsi).toBeGreaterThan(30);
  });

  it('says the rise is with the trend when it is steady and not stretched', () => {
    const lean = marketLeanOf(series(alternate(1, -0.6, 30)));
    expect(lean).toMatchObject({ kind: 'UP_WITH_TREND', trend: 'UP' });
    expect(lean?.rsi).toBeLessThan(70);
  });

  it('has no lean in a market that goes nowhere', () => {
    expect(marketLeanOf(series(alternate(0.5, -0.5, 30)))).toMatchObject({
      kind: 'MIXED',
      trend: 'FLAT',
    });
  });

  it('measures from the latest price when it is given, and from the last close when it is not', () => {
    const candles = series(alternate(0.5, -0.5, 30));
    const last = candles[candles.length - 1]?.c ?? 0;
    const atClose = marketLeanOf(candles);
    expect(marketLeanOf(candles, last)).toEqual(atClose);
    const jumped = marketLeanOf(candles, last + 20);
    expect(jumped?.hourMoveAtr).toBeGreaterThan(atClose?.hourMoveAtr ?? 0);
    expect(jumped?.kind).toBe('PULLBACK_POSSIBLE');
  });
});

describe('the line of a lean', () => {
  const lean = marketLeanOf(series([...alternate(0.3, -0.3, 20), ...repeat(-1.5, 20)]));

  it('says possible, with the measured numbers, and that it is not a forecast or a signal', () => {
    expect(lean).not.toBeNull();
    if (lean === null) return;
    const text = leanLine(lean, 'en');
    expect(text).toContain('a bounce is possible');
    expect(text).toContain(`RSI ${lean.rsi.toFixed(0)}`);
    expect(text).toContain('Not a forecast, not a signal.');
    expect(leanLine(lean, 'hinglish')).toContain('Forecast nahi, signal nahi.');
  });

  it('never says what will happen', () => {
    if (lean === null) return;
    for (const locale of ['en', 'hinglish'] as const) {
      expect(leanLine(lean, locale)).not.toMatch(/\bwill\b|\bzaroor\b|\bpakka\b/i);
    }
  });
});
