import { describe, expect, it } from 'vitest';

import {
  allSqueezeChecksPass,
  breakoutOf,
  chooseBreakout,
  judgeSqueeze,
  retestOf,
  retestStop,
  squeezeReleased,
  type BreakoutInput,
} from './rules';
import {
  SQUEEZE_CHECKS,
  SQUEEZE_RETEST_DEFAULTS,
  type BreakoutCandidate,
  type Candle,
  type SqueezeCheck,
  type SqueezeContext,
  type SqueezeInputs,
} from './types';

const P = SQUEEZE_RETEST_DEFAULTS;

describe('the 15m squeeze that was released', () => {
  const released = (change: Partial<SqueezeContext> = {}, params = P) =>
    squeezeReleased({ on: false, releasedRun: 13, barsSinceRelease: 2, ...change }, params);

  it('holds for a long enough squeeze that was released recently', () => {
    expect(released()).toBe(true);
  });

  it('the squeeze was on for at least 8 candles', () => {
    expect(released({ releasedRun: 8 })).toBe(true);
    expect(released({ releasedRun: 7 })).toBe(false);
    expect(released({ releasedRun: 7 }, { ...P, squeezeMinCandles15m: 7 })).toBe(true);
    expect(released({ releasedRun: 12 }, { ...P, squeezeMinCandles15m: 13 })).toBe(false);
  });

  it('the release is among the newest 6 candles, the release candle counting as the first', () => {
    expect(released({ barsSinceRelease: 0 })).toBe(true);
    expect(released({ barsSinceRelease: 5 })).toBe(true);
    expect(released({ barsSinceRelease: 6 })).toBe(false);
    expect(released({ barsSinceRelease: 6 }, { ...P, releaseWithinCandles15m: 7 })).toBe(true);
    expect(released({ barsSinceRelease: 3 }, { ...P, releaseWithinCandles15m: 3 })).toBe(false);
  });

  it('the bands are outside the channel now', () => {
    expect(released({ on: true })).toBe(false);
  });

  it('anything that does not exist yet fails', () => {
    expect(released({ on: null })).toBe(false);
    expect(released({ releasedRun: null })).toBe(false);
    expect(released({ barsSinceRelease: null })).toBe(false);
  });
});

describe('the breakout', () => {
  /** A bullish displacement candle (range 4.1 = 2.05 ATR, body 95%, closing at the top). */
  const candle: Candle = { o: 100, h: 104, l: 99.9, c: 103.9 };
  const input = (change: Partial<BreakoutInput> = {}): BreakoutInput => ({
    candle,
    atr: 2,
    priorUpper: 103.5,
    adx: 22,
    adxBefore: 20,
    ...change,
  });

  it('is a displacement candle that closes above the prior high, with ADX rising', () => {
    expect(breakoutOf(input(), P)).toMatchObject({
      level: 103.5,
      adx: 22,
      adxBefore: 20,
    });
    const found = breakoutOf(input(), P);
    expect(found?.closeAtr).toBeCloseTo(0.2, 9);
    expect(found?.displacementAtr).toBeCloseTo(4.1 / 2, 9);
  });

  it('closes at least 0.1 x ATR above the prior high, and not a hair less', () => {
    expect(breakoutOf(input({ priorUpper: 103.7 }), P)).not.toBeNull();
    expect(breakoutOf(input({ priorUpper: 103.7001 }), P)).toBeNull();
    expect(breakoutOf(input({ priorUpper: 103.9 }), P)).toBeNull();
    expect(breakoutOf(input({ priorUpper: 104 }), P)).toBeNull();
    expect(breakoutOf(input({ priorUpper: 103.5 }), { ...P, breakoutMinAtr: 0.2 })).not.toBeNull();
    expect(breakoutOf(input({ priorUpper: 103.5 }), { ...P, breakoutMinAtr: 0.21 })).toBeNull();
  });

  it('the float noise at the boundary does not decide: 4018.2 - 4017 is 1.1999999999997726', () => {
    // 0.1 x ATR of 12 is 1.2; the close is 1.2 above the prior high, give or take the last bit.
    const edge = { o: 4002, h: 4018.3, l: 4001.9, c: 4018.2 };
    const loose = { ...P, breakoutMinAtr: 0.1 };
    expect(4018.2 - 4017).toBeLessThan(1.2);
    expect(breakoutOf(input({ candle: edge, atr: 12, priorUpper: 4017 }), loose)).not.toBeNull();
    expect(breakoutOf(input({ candle: edge, atr: 12, priorUpper: 4017.01 }), loose)).toBeNull();
    expect(
      breakoutOf(input({ candle: edge, atr: 12, priorUpper: 4017 }), loose)?.closeAtr,
    ).toBeCloseTo(0.1, 9);
  });

  it('ADX must be higher than on the candle before, strictly', () => {
    expect(breakoutOf(input({ adx: 20.01, adxBefore: 20 }), P)).not.toBeNull();
    expect(breakoutOf(input({ adx: 20, adxBefore: 20 }), P)).toBeNull();
    expect(breakoutOf(input({ adx: 19, adxBefore: 20 }), P)).toBeNull();
  });

  it('must be a bullish displacement candle', () => {
    const weak = { o: 100, h: 104, l: 99.9, c: 102 };
    expect(breakoutOf(input({ candle: weak, priorUpper: 101 }), P)).toBeNull();
    const bearish = { o: 104, h: 104.1, l: 99.9, c: 100 };
    expect(breakoutOf(input({ candle: bearish, priorUpper: 99 }), P)).toBeNull();
  });

  it('anything that does not exist yet fails', () => {
    expect(breakoutOf(input({ atr: null }), P)).toBeNull();
    expect(breakoutOf(input({ atr: 0 }), P)).toBeNull();
    expect(breakoutOf(input({ priorUpper: null }), P)).toBeNull();
    expect(breakoutOf(input({ adx: null }), P)).toBeNull();
    expect(breakoutOf(input({ adxBefore: null }), P)).toBeNull();
  });
});

describe('the retest candle', () => {
  const level = 100;
  const retest = (candle: Candle, atr: number | null = 2, params = P) =>
    retestOf({ level }, candle, atr, params);
  /** Low 99.8, close 100.6, range 1.4: a lower wick of 0.8 / 1.4 = 57 percent. */
  const good: Candle = { o: 101, h: 101.2, l: 99.8, c: 100.6 };

  it('touches the level, closes above it, with a lower wick', () => {
    expect(retest(good)).toMatchObject({ touched: true, closedAbove: true, wick: true });
    expect(retest(good).wickRatio).toBeCloseTo(0.8 / 1.4, 9);
  });

  it('reaches to within 0.25 x ATR of the level (or through it), not a hair less', () => {
    expect(retest({ ...good, l: 100.5 }).touched).toBe(true);
    expect(retest({ ...good, l: 100.51 }).touched).toBe(false);
    expect(retest({ ...good, l: 99 }).touched).toBe(true);
    expect(retest({ ...good, l: 100.4 }, 1.6).touched).toBe(true);
    expect(retest({ ...good, l: 100.41 }, 1.6).touched).toBe(false);
    expect(retest({ ...good, l: 100.5 }, 2, { ...P, retestMaxDistanceAtr: 0.2 }).touched).toBe(
      false,
    );
    expect(retest({ ...good, l: 100.4 }, 2, { ...P, retestMaxDistanceAtr: 0.2 }).touched).toBe(
      true,
    );
  });

  it('the float noise at the boundary does not decide: 4000.1 + 0.1 x 12 is 4001.2999999999997', () => {
    const near = { o: 4003, h: 4003.2, l: 4001.3, c: 4002 };
    const loose = { ...P, retestMaxDistanceAtr: 0.1 };
    expect(4000.1 + 0.1 * 12).toBeLessThan(4001.3);
    expect(retestOf({ level: 4000.1 }, near, 12, loose).touched).toBe(true);
    expect(retestOf({ level: 4000.1 }, { ...near, l: 4001.31 }, 12, loose).touched).toBe(false);
  });

  it('closes above the level, strictly', () => {
    expect(retest({ ...good, c: 100.01 }).closedAbove).toBe(true);
    expect(retest({ ...good, c: 100 }).closedAbove).toBe(false);
    expect(retest({ ...good, c: 99.9 }).closedAbove).toBe(false);
  });

  it('has a lower wick of at least 30 percent of its range, whichever way the body goes', () => {
    // Range 1.4 (99.8 to 101.2): a wick of 0.42 is 30 percent.
    expect(retest({ o: 101, h: 101.2, l: 99.8, c: 100.22 }).wick).toBe(true);
    expect(retest({ o: 101, h: 101.2, l: 99.8, c: 100.2 }).wick).toBe(false);
    expect(retest({ o: 100.22, h: 101.2, l: 99.8, c: 101 }).wick).toBe(true);
    expect(retest({ o: 100.2, h: 101.2, l: 99.8, c: 101 }).wick).toBe(false);
    expect(retest(good, 2, { ...P, rejectionWickRatio: 0.57 }).wick).toBe(true);
    expect(retest(good, 2, { ...P, rejectionWickRatio: 0.58 }).wick).toBe(false);
  });

  it('a candle with no range has no wick, and no ATR means nothing is touched', () => {
    const flat = { o: 100.5, h: 100.5, l: 100.5, c: 100.5 };
    expect(retest(flat)).toMatchObject({ wick: false, wickRatio: 0 });
    expect(retest(good, null).touched).toBe(false);
  });
});

function candidate(change: Partial<BreakoutCandidate> = {}): BreakoutCandidate {
  return {
    level: 100,
    openTime: 1000,
    candlesSince: 3,
    lowest: 99.8,
    closeAtr: 0.6,
    displacementAtr: 2,
    adx: 22,
    adxBefore: 20,
    ...change,
  };
}

describe('which breakout the retest candle is judged against', () => {
  const retestCandle: Candle = { o: 101, h: 101.2, l: 99.8, c: 100.6 };
  const choose = (candidates: BreakoutCandidate[], candle = retestCandle) =>
    chooseBreakout(candidates, candle, 2, P);

  it('none without a breakout', () => {
    expect(choose([])).toBeNull();
  });

  it('the newest one whose retest the candle completes', () => {
    const older = candidate({ openTime: 1, candlesSince: 5, level: 100 });
    const newer = candidate({ openTime: 2, candlesSince: 2, level: 100.2 });
    expect(choose([older, newer])?.openTime).toBe(2);
    expect(choose([newer, older])?.openTime).toBe(2);
  });

  it('the newest one when the candle has no wick, even if an older one is touched and closed above', () => {
    const noWick: Candle = { o: 100.1, h: 101.2, l: 100, c: 100.2 };
    const older = candidate({ openTime: 1, candlesSince: 5, level: 99.5 });
    const newer = candidate({ openTime: 2, candlesSince: 2, level: 110 });
    expect(retestOf(older, noWick, 2, P)).toMatchObject({
      touched: true,
      closedAbove: true,
      wick: false,
    });
    expect(choose([older, newer], noWick)?.openTime).toBe(2);
    expect(choose([newer, older], noWick)?.openTime).toBe(2);
  });

  it('an older one when the newer one is not completed', () => {
    const older = candidate({ openTime: 1, candlesSince: 5, level: 100 });
    const higher = candidate({ openTime: 2, candlesSince: 2, level: 100.9 });
    expect(choose([older, higher])?.openTime).toBe(1);
    expect(choose([higher, older])?.openTime).toBe(1);
  });

  it('the newest one when none is completed, so that the missing rules can be shown', () => {
    const older = candidate({ openTime: 1, candlesSince: 5, level: 102 });
    const newer = candidate({ openTime: 2, candlesSince: 2, level: 103 });
    expect(choose([older, newer])?.openTime).toBe(2);
    expect(choose([newer, older])?.openTime).toBe(2);
  });
});

describe('the rules of Squeeze Retest', () => {
  const PASSING: SqueezeInputs = {
    context: { on: false, releasedRun: 13, barsSinceRelease: 2 },
    breakout: candidate(),
    candle: { o: 101, h: 101.2, l: 99.8, c: 100.6 },
    atr: 2,
  };
  const failing = (change: Partial<SqueezeInputs>): SqueezeCheck[] => {
    const checks = judgeSqueeze({ ...PASSING, ...change }, P);
    return SQUEEZE_CHECKS.filter((check) => !checks[check]);
  };

  it('all hold for the passing inputs', () => {
    expect(failing({})).toEqual([]);
    expect(allSqueezeChecksPass(judgeSqueeze(PASSING, P))).toBe(true);
  });

  it('lists the rules in the order of docs/02 section 7.C', () => {
    expect(SQUEEZE_CHECKS).toEqual([
      'squeezeReleased',
      'breakout',
      'retestTouched',
      'closeAboveLevel',
      'rejectionWick',
    ]);
  });

  it('a single missing rule means no setup', () => {
    for (const check of SQUEEZE_CHECKS) {
      const checks = { ...judgeSqueeze(PASSING, P), [check]: false };
      expect(allSqueezeChecksPass(checks), check).toBe(false);
    }
  });

  it('each rule is judged on its own', () => {
    expect(failing({ context: { on: false, releasedRun: 7, barsSinceRelease: 2 } })).toEqual([
      'squeezeReleased',
    ]);
    expect(failing({ candle: { o: 100.75, h: 101.2, l: 100.7, c: 100.8 } })).toEqual([
      'retestTouched',
      'rejectionWick',
    ]);
    expect(failing({ candle: { o: 101, h: 101.2, l: 98.8, c: 99.9 } })).toEqual([
      'closeAboveLevel',
    ]);
    expect(failing({ candle: { o: 100.1, h: 101.2, l: 100, c: 100.2 } })).toEqual([
      'rejectionWick',
    ]);
  });

  it('without a breakout none of the retest rules can hold', () => {
    expect(failing({ breakout: null })).toEqual([
      'breakout',
      'retestTouched',
      'closeAboveLevel',
      'rejectionWick',
    ]);
  });
});

describe('the stop', () => {
  it('lies 0.2 x ATR beyond the retest low', () => {
    expect(retestStop(99.8, 2, P)).toBeCloseTo(99.4, 9);
    expect(retestStop(99.8, 5, P)).toBeCloseTo(98.8, 9);
  });

  it('takes the buffer from the params', () => {
    expect(retestStop(99.8, 2, { stopBufferAtr: 1 })).toBe(97.8);
    expect(retestStop(99.8, 2, { stopBufferAtr: 0 })).toBe(99.8);
  });

  it('cannot be placed without the retest low or the ATR', () => {
    expect(retestStop(null, 2, P)).toBeNull();
    expect(retestStop(99.8, null, P)).toBeNull();
  });
});
