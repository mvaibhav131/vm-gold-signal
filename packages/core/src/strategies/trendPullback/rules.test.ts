import { describe, expect, it } from 'vitest';

import { allChecksPass, judgePullback, pullbackStop, zoneReached } from './rules';
import {
  PULLBACK_CHECKS,
  TREND_PULLBACK_DEFAULTS,
  type PullbackCheck,
  type PullbackInputs,
} from './types';

/** Every rule is met, none of them by a hair. */
const PASSING: PullbackInputs = {
  ema1h: { fast: 4030, mid: 4020, slow: 4000 },
  midSlope1h: 0.5,
  state15m: 'UP',
  lowIntact15m: true,
  fibTop: 4050,
  close: 4072,
  previousHigh: 4071,
  emaFast5m: 4070,
  emaTouched: true,
  rsi: { now: 52, lowest: 40, before: 44 },
  histogram: [-0.5, -0.3, -0.1],
  legLow: 4060,
  breakLevel: 4071.5,
  displacement: false,
};

const P = TREND_PULLBACK_DEFAULTS;

function checksOf(change: Partial<PullbackInputs>, params = P) {
  return judgePullback({ ...PASSING, ...change }, params);
}

/** The rules that do not hold. */
function failing(change: Partial<PullbackInputs>, params = P): PullbackCheck[] {
  const checks = checksOf(change, params);
  return PULLBACK_CHECKS.filter((check) => !checks[check]);
}

describe('the rules of Trend Pullback', () => {
  it('all hold for the passing inputs', () => {
    const checks = checksOf({});
    expect(PULLBACK_CHECKS.filter((check) => !checks[check])).toEqual([]);
    expect(allChecksPass(checks)).toBe(true);
  });

  it('a single missing rule means no setup', () => {
    for (const check of PULLBACK_CHECKS) {
      const checks = { ...checksOf({}), [check]: false };
      expect(allChecksPass(checks), check).toBe(false);
    }
  });

  it('lists the rules in the order of docs/02 section 7.A', () => {
    expect(PULLBACK_CHECKS).toEqual([
      'trend1h',
      'slope1h',
      'structure15m',
      'lowIntact15m',
      'pulledBack',
      'rsiReset',
      'rsiTurning',
      'closeAboveEma',
      'closeAbovePreviousHigh',
      'breakOrDisplacement',
      'macdRising',
    ]);
  });
});

describe('trend on 1h: EMA20 > EMA50 > EMA200, and EMA50 rising', () => {
  it('needs the three averages in strict order', () => {
    expect(failing({ ema1h: { fast: 4020, mid: 4020, slow: 4000 } })).toEqual(['trend1h']);
    expect(failing({ ema1h: { fast: 4030, mid: 4000, slow: 4000 } })).toEqual(['trend1h']);
    expect(failing({ ema1h: { fast: 4010, mid: 4020, slow: 4000 } })).toEqual(['trend1h']);
    expect(failing({ ema1h: { fast: 4030, mid: 4020, slow: 4025 } })).toEqual(['trend1h']);
    expect(failing({ ema1h: { fast: 4020.01, mid: 4020, slow: 4019.99 } })).toEqual([]);
  });

  it('an average that does not exist yet fails the rule', () => {
    expect(failing({ ema1h: { fast: null, mid: 4020, slow: 4000 } })).toEqual(['trend1h']);
    expect(failing({ ema1h: { fast: 4030, mid: null, slow: 4000 } })).toEqual(['trend1h']);
    expect(failing({ ema1h: { fast: 4030, mid: 4020, slow: null } })).toEqual(['trend1h']);
  });

  it('and so does a missing one among negative prices (null is 0 in a comparison)', () => {
    // The SELL side is fed negated prices, where 0 is higher than every real average.
    expect(failing({ ema1h: { fast: null, mid: -4020, slow: -4040 } })).toEqual(['trend1h']);
    expect(failing({ ema1h: { fast: -4000, mid: null, slow: -4040 } })).toEqual(['trend1h']);
    expect(failing({ ema1h: { fast: -4000, mid: -4020, slow: null } })).toEqual(['trend1h']);
    expect(failing({ ema1h: { fast: -4000, mid: -4020, slow: -4040 } })).toEqual([]);
  });

  it('the slope must be above zero', () => {
    expect(failing({ midSlope1h: 0 })).toEqual(['slope1h']);
    expect(failing({ midSlope1h: -0.01 })).toEqual(['slope1h']);
    expect(failing({ midSlope1h: null })).toEqual(['slope1h']);
    expect(failing({ midSlope1h: 1e-9 })).toEqual([]);
  });
});

describe('structure on 15m', () => {
  it('the state must be UP', () => {
    expect(failing({ state15m: 'RANGE' })).toEqual(['structure15m']);
    expect(failing({ state15m: 'DOWN' })).toEqual(['structure15m']);
    expect(failing({ state15m: null })).toEqual(['structure15m']);
  });

  it('the last swing low must be intact, and exist', () => {
    expect(failing({ lowIntact15m: false })).toEqual(['lowIntact15m']);
    expect(failing({ lowIntact15m: null })).toEqual(['lowIntact15m']);
  });
});

describe('the value zone', () => {
  it('the EMA band was touched', () => {
    expect(zoneReached({ ...PASSING, fibTop: 4000 })).toBe('EMA');
    expect(failing({ emaTouched: false, fibTop: 4000 })).toEqual(['pulledBack']);
  });

  it('or the pullback low is at or below the upper edge of the Fibonacci zone', () => {
    const base = { ...PASSING, emaTouched: false };
    expect(zoneReached({ ...base, legLow: 4050, fibTop: 4050 })).toBe('FIB');
    expect(zoneReached({ ...base, legLow: 4049.99, fibTop: 4050 })).toBe('FIB');
    expect(zoneReached({ ...base, legLow: 4050.01, fibTop: 4050 })).toBeNull();
  });

  it('both zones can be reached', () => {
    expect(zoneReached({ ...PASSING, legLow: 4040, fibTop: 4050 })).toBe('EMA+FIB');
  });

  it('an unknown pullback low or Fibonacci zone reaches nothing by itself', () => {
    expect(zoneReached({ ...PASSING, emaTouched: false, legLow: null })).toBeNull();
    expect(zoneReached({ ...PASSING, emaTouched: false, fibTop: null })).toBeNull();
    expect(zoneReached({ ...PASSING, legLow: null, fibTop: 5000 })).toBe('EMA');
    expect(zoneReached({ ...PASSING, fibTop: null })).toBe('EMA');
  });
});

describe('RSI(14, 5m)', () => {
  it('was at or below 45 within the lookback', () => {
    expect(failing({ rsi: { now: 52, lowest: 45, before: 44 } })).toEqual([]);
    expect(failing({ rsi: { now: 52, lowest: 45.0001, before: 44 } })).toEqual(['rsiReset']);
    expect(failing({ rsi: { now: 52, lowest: null, before: 44 } })).toEqual(['rsiReset']);
  });

  it('takes the limit from the params', () => {
    const strict = { ...P, rsiPullbackMax: 30 };
    expect(failing({}, strict)).toEqual(['rsiReset']);
    expect(failing({ rsi: { now: 52, lowest: 30, before: 44 } }, strict)).toEqual([]);
  });

  it('is now above its value some candles ago', () => {
    expect(failing({ rsi: { now: 44.01, lowest: 40, before: 44 } })).toEqual([]);
    expect(failing({ rsi: { now: 44, lowest: 40, before: 44 } })).toEqual(['rsiTurning']);
    expect(failing({ rsi: { now: 43, lowest: 40, before: 44 } })).toEqual(['rsiTurning']);
    expect(failing({ rsi: { now: null, lowest: 40, before: 44 } })).toEqual(['rsiTurning']);
    expect(failing({ rsi: { now: 52, lowest: 40, before: null } })).toEqual(['rsiTurning']);
  });
});

describe('the trigger candle', () => {
  it('closes above the EMA20 of 5m', () => {
    const level = { previousHigh: 4070, emaFast5m: 4070, breakLevel: 4060 };
    expect(failing({ ...level, close: 4070.01 })).toEqual([]);
    expect(failing({ ...level, close: 4070, previousHigh: 4069 })).toEqual(['closeAboveEma']);
    expect(failing({ emaFast5m: null })).toEqual(['closeAboveEma']);
  });

  it('closes above the high of the candle before', () => {
    expect(failing({ close: 4072, previousHigh: 4071.99 })).toEqual([]);
    expect(failing({ close: 4072, previousHigh: 4072 })).toEqual(['closeAbovePreviousHigh']);
    expect(failing({ close: 4072, previousHigh: null })).toEqual(['closeAbovePreviousHigh']);
  });

  it('breaks the last swing high of the pullback', () => {
    expect(failing({ close: 4072, breakLevel: 4071.99 })).toEqual([]);
    expect(failing({ close: 4072, breakLevel: 4072 })).toEqual(['breakOrDisplacement']);
    expect(failing({ breakLevel: null })).toEqual(['breakOrDisplacement']);
  });

  it('or is itself a displacement candle', () => {
    expect(failing({ breakLevel: 5000, displacement: true })).toEqual([]);
    expect(failing({ breakLevel: null, displacement: true })).toEqual([]);
    expect(failing({ breakLevel: 5000, displacement: false })).toEqual(['breakOrDisplacement']);
  });

  it('has a MACD histogram that rose on each of the last two candles', () => {
    expect(failing({ histogram: [-0.5, -0.3, -0.1] })).toEqual([]);
    expect(failing({ histogram: [-0.5, -0.5, -0.1] })).toEqual(['macdRising']);
    expect(failing({ histogram: [-0.5, -0.1, -0.1] })).toEqual(['macdRising']);
    expect(failing({ histogram: [-0.1, -0.3, -0.5] })).toEqual(['macdRising']);
    expect(failing({ histogram: [-0.5, -0.3, -0.4] })).toEqual(['macdRising']);
    expect(failing({ histogram: [-0.1, -0.5, -0.3] })).toEqual(['macdRising']);
    expect(failing({ histogram: null })).toEqual(['macdRising']);
  });

  it('looks only at the newest candles of the histogram', () => {
    expect(failing({ histogram: [9, -0.5, -0.3, -0.1] })).toEqual([]);
    expect(failing({ histogram: [-0.5, -0.3, -0.1, -0.2] })).toEqual(['macdRising']);
  });

  it('needs one more histogram value than the number of rises', () => {
    expect(failing({ histogram: [-0.3, -0.1] })).toEqual(['macdRising']);
    expect(failing({ histogram: [-0.3, -0.1] }, { ...P, macdRisingCandles: 1 })).toEqual([]);
    expect(failing({ histogram: [-0.5, -0.3, -0.1] }, { ...P, macdRisingCandles: 3 })).toEqual([
      'macdRising',
    ]);
    expect(
      failing({ histogram: [-0.9, -0.5, -0.3, -0.1] }, { ...P, macdRisingCandles: 3 }),
    ).toEqual([]);
    expect(failing({ histogram: [-0.1, -0.3, -0.1] }, { ...P, macdRisingCandles: 1 })).toEqual([]);
  });
});

describe('the stop', () => {
  it('lies 0.25 x ATR beyond the pullback low', () => {
    expect(pullbackStop(4060, 2, P)).toBe(4059.5);
    expect(pullbackStop(4060, 4, P)).toBe(4059);
  });

  it('takes the buffer from the params', () => {
    expect(pullbackStop(4060, 2, { stopBufferAtr: 1 })).toBe(4058);
    expect(pullbackStop(4060, 2, { stopBufferAtr: 0 })).toBe(4060);
  });

  it('cannot be placed without the low or the ATR', () => {
    expect(pullbackStop(null, 2, P)).toBeNull();
    expect(pullbackStop(4060, null, P)).toBeNull();
  });
});
