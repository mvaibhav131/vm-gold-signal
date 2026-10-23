import { describe, expect, it } from 'vitest';

import { patternBreakout } from './breakout';
import { doubleExtremeFor } from './reversal';
import { bar, makeLine, noTrend, patternInput, pivot, series } from './test-data';
import { trianglesOf } from './triangles';
import type { Pattern } from './types';

// ATR 1. A double top: tops 110.0 and 110.2, neckline 108.5, height 1.7 (see reversal.test.ts).
function doubleTop(): Pattern {
  const candles = series(60, () => 109, {
    10: [109, 110.0, 108.8, 109],
    30: [109, 110.2, 108.8, 109],
    20: [109, 109.2, 108.5, 109],
  });
  const found = doubleExtremeFor(
    pivot('HIGH', 110.2, 30),
    patternInput(candles, [pivot('HIGH', 110.0, 10), pivot('HIGH', 110.2, 30)], []),
  );
  if (!found) throw new Error('fixture');
  return found;
}

// A symmetrical triangle: resistance 120 -> 116 and support 108 -> 112 between candles 10 and 40, meeting at candle 55.
function triangle(): Pattern {
  const found = trianglesOf(
    patternInput(
      series(45, () => 114),
      [],
      [],
    ),
    {
      ...noTrend,
      support: makeLine('SUPPORT', [10, 108], [40, 112]),
      resistance: makeLine('RESISTANCE', [10, 100], [40, 104]),
    },
  )[0];
  if (!found) throw new Error('fixture');
  return found;
}

describe('patternBreakout: a double top', () => {
  const pattern = doubleTop();

  it('is a displacement candle that closes below the neckline by 0.10 x ATR (hand-checked)', () => {
    // range 1.3, body 1.1, close in the bottom 8% of the range; 0.7 below the neckline at 108.5
    const found = patternBreakout(pattern, bar(60, 109.0, 109.05, 107.75, 107.8), 1);
    expect(found).toMatchObject({ direction: 'DOWN', close: 107.8 });
    expect(found?.level).toBeCloseTo(108.5, 9);
    expect(found?.beyondAtr).toBeCloseTo(0.7, 9);
    // the target is the neckline minus the height: 108.5 - 1.7
    expect(found?.target).toBeCloseTo(106.8, 9);
    expect(found?.pattern).toBe(pattern);
  });

  it('needs the close to be at least 0.10 x ATR beyond the neckline (exactly 0.10 counts)', () => {
    // the same displacement candle (range 1.2, close in the bottom 25%) each time; only the close moves
    const candle = (close: number) => bar(60, 109.3, 109.4, 108.2, close);
    expect(patternBreakout(pattern, candle(108.4), 1)).not.toBeNull(); // 0.10 below
    expect(patternBreakout(pattern, candle(108.41), 1)).toBeNull(); // 0.09
    expect(patternBreakout(pattern, candle(108.5), 1)).toBeNull(); // right on the neckline
  });

  it('needs a displacement candle: a small candle closing below the neckline is not enough', () => {
    expect(patternBreakout(pattern, bar(60, 108.6, 108.65, 108.0, 108.1), 1)).toBeNull();
  });

  it('breaks only downward: an upward displacement does nothing to a double top', () => {
    expect(patternBreakout(pattern, bar(60, 108.0, 109.7, 107.95, 109.6), 1)).toBeNull();
  });

  it('uses the ATR it is given: the same candle is not a displacement against a bigger ATR', () => {
    const candle = bar(60, 109.0, 109.05, 107.75, 107.8);
    expect(patternBreakout(pattern, candle, 1)).not.toBeNull();
    expect(patternBreakout(pattern, candle, 3)).toBeNull();
    expect(patternBreakout(pattern, candle, null)).toBeNull();
    expect(patternBreakout(pattern, candle, 0)).toBeNull();
  });
});

describe('patternBreakout: a symmetrical triangle', () => {
  const pattern = triangle();
  // at candle 50 the support is at 113.33 and the resistance at 114.67; the apex is at candle 55

  it('breaks upward through the resistance and downward through the support, with the width at the start as the target', () => {
    const up = patternBreakout(pattern, bar(50, 114.4, 116.0, 114.3, 115.9), 1);
    expect(up?.direction).toBe('UP');
    expect(up?.level).toBeCloseTo(114.6667, 3);
    expect(up?.target).toBeCloseTo(114.6667 + 12, 3);
    const down = patternBreakout(pattern, bar(50, 113.0, 113.1, 111.8, 111.9), 1);
    expect(down?.direction).toBe('DOWN');
    expect(down?.level).toBeCloseTo(113.3333, 3);
    expect(down?.target).toBeCloseTo(113.3333 - 12, 3);
  });

  it('must be broken before the apex: a candle at or after it breaks nothing', () => {
    // at candle 54 the lines are 0.27 apart and a candle just beyond the support is a break
    expect(patternBreakout(pattern, bar(54, 114.5, 114.6, 112.5, 112.6), 1)).not.toBeNull();
    expect(patternBreakout(pattern, bar(55, 114.5, 114.6, 112.5, 112.6), 1)).toBeNull();
    expect(patternBreakout(pattern, bar(56, 114.5, 114.6, 112.5, 112.6), 1)).toBeNull();
  });
});
