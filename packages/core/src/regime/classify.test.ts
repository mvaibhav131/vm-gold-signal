import { describe, expect, it } from 'vitest';

import { REGIMES } from '../domain';
import { classifyRegime, volBucketOf } from './classify';
import { REGIME_DEFAULTS, REGIME_PRECEDENCE, type RegimeInputs, type RegimeParams } from './types';

/** Meets no rule: the 1h trend is neither there (ADX 19) nor absent (ADX 18 or more), and the 15m range is wide. */
const NOTHING: RegimeInputs = {
  emaFast: 4000,
  emaMid: 4000,
  emaSlow: 4000,
  adx1h: 19,
  efficiency1h: 0.2,
  atr15m: 2,
  atrPercentile15m: 50,
  rangeWidth15m: 10,
  squeezeDuration: 0,
  releasedBarsAgo: null,
  displacementBarsAgo: null,
  displacementDirection: null,
};

const UP = { emaFast: 4020, emaMid: 4010, emaSlow: 4000, adx1h: 25, efficiency1h: 0.5 };
const DOWN = { emaFast: 3980, emaMid: 3990, emaSlow: 4000, adx1h: 25, efficiency1h: 0.5 };
const RANGE = { adx1h: 15, rangeWidth15m: 6 };
const SQUEEZED = { squeezeDuration: 8 };
const BROKEN = {
  releasedBarsAgo: 3,
  displacementBarsAgo: 2,
  displacementDirection: 'UP' as const,
};
const WILD = { atrPercentile15m: 90 };

const make = (...changes: Partial<RegimeInputs>[]): RegimeInputs =>
  Object.assign({}, NOTHING, ...changes) as RegimeInputs;

describe('what each regime needs', () => {
  it('UNCERTAIN: no rule is met', () => {
    expect(classifyRegime(NOTHING)).toEqual({ regime: 'UNCERTAIN', direction: null, matched: [] });
  });

  it('TREND_UP: the 1h averages in order upwards, ADX 20 or more and efficiency 0.30 or more', () => {
    expect(classifyRegime(make(UP))).toEqual({
      regime: 'TREND_UP',
      direction: 'UP',
      matched: ['TREND_UP'],
    });
  });

  it('TREND_DOWN: the mirror', () => {
    expect(classifyRegime(make(DOWN))).toEqual({
      regime: 'TREND_DOWN',
      direction: 'DOWN',
      matched: ['TREND_DOWN'],
    });
  });

  it('RANGE: ADX(1h) below 18 and a 15m width of at most 3 ATR', () => {
    expect(classifyRegime(make(RANGE))).toEqual({
      regime: 'RANGE',
      direction: null,
      matched: ['RANGE'],
    });
  });

  it('SQUEEZE: the 15m squeeze has been on for 8 candles', () => {
    expect(classifyRegime(make(SQUEEZED))).toEqual({
      regime: 'SQUEEZE',
      direction: null,
      matched: ['SQUEEZE'],
    });
  });

  it('BREAKOUT: the squeeze was released in the last 6 candles and a displacement came with or after it', () => {
    expect(classifyRegime(make(BROKEN))).toEqual({
      regime: 'BREAKOUT',
      direction: 'UP',
      matched: ['BREAKOUT'],
    });
    expect(classifyRegime(make(BROKEN, { displacementDirection: 'DOWN' })).direction).toBe('DOWN');
  });

  it('HIGH_VOL: the ATR(15m) percentile is 90 or more', () => {
    expect(classifyRegime(make(WILD))).toEqual({
      regime: 'HIGH_VOL',
      direction: null,
      matched: ['HIGH_VOL'],
    });
  });
});

describe('the edges of every threshold', () => {
  const regimeOf = (...changes: Partial<RegimeInputs>[]) => classifyRegime(make(...changes)).regime;

  it('trend: ADX 20 counts, just below does not', () => {
    expect(regimeOf(UP, { adx1h: 20 })).toBe('TREND_UP');
    expect(regimeOf(UP, { adx1h: 19.99 })).toBe('UNCERTAIN');
    expect(regimeOf(DOWN, { adx1h: 20 })).toBe('TREND_DOWN');
    expect(regimeOf(DOWN, { adx1h: 19.99 })).toBe('UNCERTAIN');
  });

  it('trend: an efficiency of 0.30 counts, just below does not', () => {
    expect(regimeOf(UP, { efficiency1h: 0.3 })).toBe('TREND_UP');
    expect(regimeOf(UP, { efficiency1h: 0.299 })).toBe('UNCERTAIN');
    expect(regimeOf(DOWN, { efficiency1h: 0.3 })).toBe('TREND_DOWN');
    expect(regimeOf(DOWN, { efficiency1h: 0.299 })).toBe('UNCERTAIN');
  });

  it('trend: the averages must be strictly in order, all three', () => {
    expect(regimeOf(UP, { emaFast: 4010 })).toBe('UNCERTAIN');
    expect(regimeOf(UP, { emaMid: 4000 })).toBe('UNCERTAIN');
    expect(regimeOf(UP, { emaFast: 4005, emaMid: 4010 })).toBe('UNCERTAIN');
    expect(regimeOf(UP, { emaMid: 3995 })).toBe('UNCERTAIN');
    expect(regimeOf(DOWN, { emaFast: 3990 })).toBe('UNCERTAIN');
    expect(regimeOf(DOWN, { emaMid: 4000 })).toBe('UNCERTAIN');
    expect(regimeOf(DOWN, { emaFast: 3995, emaMid: 3990 })).toBe('UNCERTAIN');
    expect(regimeOf(DOWN, { emaMid: 4005 })).toBe('UNCERTAIN');
  });

  it('range: ADX below 18 counts, 18 does not', () => {
    expect(regimeOf(RANGE, { adx1h: 17.99 })).toBe('RANGE');
    expect(regimeOf(RANGE, { adx1h: 18 })).toBe('UNCERTAIN');
  });

  it('range: a width of exactly 3 ATR counts, a little more does not', () => {
    expect(regimeOf(RANGE, { rangeWidth15m: 6 })).toBe('RANGE');
    expect(regimeOf(RANGE, { rangeWidth15m: 6.001 })).toBe('UNCERTAIN');
    expect(regimeOf(RANGE, { atr15m: 3, rangeWidth15m: 9 })).toBe('RANGE');
    expect(regimeOf(RANGE, { atr15m: 3, rangeWidth15m: 9.001 })).toBe('UNCERTAIN');
  });

  it('squeeze: 8 candles count, 7 do not', () => {
    expect(regimeOf({ squeezeDuration: 8 })).toBe('SQUEEZE');
    expect(regimeOf({ squeezeDuration: 7 })).toBe('UNCERTAIN');
    expect(regimeOf({ squeezeDuration: 0 })).toBe('UNCERTAIN');
    expect(regimeOf({ squeezeDuration: 200 })).toBe('SQUEEZE');
  });

  it('breakout: a release 5 candles ago counts (the sixth candle back), 6 candles ago does not', () => {
    const at = (released: number) =>
      regimeOf({
        releasedBarsAgo: released,
        displacementBarsAgo: released,
        displacementDirection: 'UP',
      });
    expect(at(0)).toBe('BREAKOUT');
    expect(at(5)).toBe('BREAKOUT');
    expect(at(6)).toBe('UNCERTAIN');
    expect(at(40)).toBe('UNCERTAIN');
  });

  it('breakout: the displacement must come with the release or after it, not before it', () => {
    const released = { releasedBarsAgo: 3, displacementDirection: 'UP' as const };
    expect(regimeOf(released, { displacementBarsAgo: 3 })).toBe('BREAKOUT');
    expect(regimeOf(released, { displacementBarsAgo: 0 })).toBe('BREAKOUT');
    expect(regimeOf(released, { displacementBarsAgo: 4 })).toBe('UNCERTAIN');
    expect(regimeOf(released, { displacementBarsAgo: 30 })).toBe('UNCERTAIN');
  });

  it('breakout: needs both a release and a displacement', () => {
    expect(
      regimeOf({ releasedBarsAgo: 2, displacementBarsAgo: null, displacementDirection: null }),
    ).toBe('UNCERTAIN');
    expect(
      regimeOf({ releasedBarsAgo: null, displacementBarsAgo: 2, displacementDirection: 'UP' }),
    ).toBe('UNCERTAIN');
    // no release is not a release 0 candles ago, even for a displacement on the newest candle
    expect(
      regimeOf({ releasedBarsAgo: null, displacementBarsAgo: 0, displacementDirection: 'UP' }),
    ).toBe('UNCERTAIN');
  });

  it('high volatility: the 90th percentile counts, a little below does not', () => {
    expect(regimeOf({ atrPercentile15m: 90 })).toBe('HIGH_VOL');
    expect(regimeOf({ atrPercentile15m: 89.99 })).toBe('UNCERTAIN');
    expect(regimeOf({ atrPercentile15m: 100 })).toBe('HIGH_VOL');
    expect(regimeOf({ atrPercentile15m: 0 })).toBe('UNCERTAIN');
  });
});

describe('when several rules are met: the first of them in the order of precedence wins', () => {
  it('is BREAKOUT, SQUEEZE, HIGH_VOL, TREND, RANGE', () => {
    expect(REGIME_PRECEDENCE).toEqual([
      'BREAKOUT',
      'SQUEEZE',
      'HIGH_VOL',
      'TREND_UP',
      'TREND_DOWN',
      'RANGE',
    ]);
  });

  it('covers every regime of the system except UNCERTAIN', () => {
    expect([...REGIME_PRECEDENCE, 'UNCERTAIN'].sort()).toEqual([...REGIMES].sort());
  });

  it('lists all the rules that are met and takes the first', () => {
    const all = make(UP, SQUEEZED, BROKEN, WILD);
    expect(classifyRegime(all)).toEqual({
      regime: 'BREAKOUT',
      direction: 'UP',
      matched: ['BREAKOUT', 'SQUEEZE', 'HIGH_VOL', 'TREND_UP'],
    });
  });

  it('SQUEEZE beats HIGH_VOL and the trend', () => {
    expect(classifyRegime(make(UP, SQUEEZED, WILD))).toMatchObject({
      regime: 'SQUEEZE',
      direction: null,
      matched: ['SQUEEZE', 'HIGH_VOL', 'TREND_UP'],
    });
    expect(classifyRegime(make(DOWN, SQUEEZED))).toMatchObject({
      regime: 'SQUEEZE',
      matched: ['SQUEEZE', 'TREND_DOWN'],
    });
  });

  it('HIGH_VOL beats the trend and the range', () => {
    expect(classifyRegime(make(UP, WILD))).toMatchObject({
      regime: 'HIGH_VOL',
      direction: null,
      matched: ['HIGH_VOL', 'TREND_UP'],
    });
    expect(classifyRegime(make(DOWN, WILD))).toMatchObject({
      regime: 'HIGH_VOL',
      matched: ['HIGH_VOL', 'TREND_DOWN'],
    });
    expect(classifyRegime(make(RANGE, WILD))).toMatchObject({
      regime: 'HIGH_VOL',
      matched: ['HIGH_VOL', 'RANGE'],
    });
  });

  it('BREAKOUT beats HIGH_VOL: a breakout makes the ATR jump, and it must stay visible', () => {
    expect(classifyRegime(make(BROKEN, WILD)).regime).toBe('BREAKOUT');
  });

  it('the trend beats nothing but what is above it, and a range cannot be a trend', () => {
    expect(classifyRegime(make(RANGE, { adx1h: 17 })).matched).toEqual(['RANGE']);
    expect(classifyRegime(make(UP)).matched).toEqual(['TREND_UP']);
  });

  it('a displacement that came before the release does not make a breakout, so the squeeze rule decides', () => {
    expect(
      classifyRegime(
        make({
          squeezeDuration: 10,
          releasedBarsAgo: 20,
          displacementBarsAgo: 22,
          displacementDirection: 'UP',
        }),
      ).regime,
    ).toBe('SQUEEZE');
  });
});

describe('the thresholds come from the parameters', () => {
  const stricter: RegimeParams = {
    ...REGIME_DEFAULTS,
    trend: { adxMin: 30, efficiencyMin: 0.6 },
    range: { adxBelow: 10, lookback: 24, maxWidthAtr: 2 },
    squeeze: { minDuration: 4 },
    breakout: { withinCandles: 2 },
    highVol: { percentileFrom: 95, window: 480 },
  };

  it('moves the trend, range, squeeze, breakout and high-volatility limits', () => {
    expect(classifyRegime(make(UP), stricter).regime).toBe('UNCERTAIN');
    expect(classifyRegime(make(UP, { adx1h: 30, efficiency1h: 0.6 }), stricter).regime).toBe(
      'TREND_UP',
    );
    expect(classifyRegime(make(RANGE), stricter).regime).toBe('UNCERTAIN');
    expect(classifyRegime(make({ adx1h: 9, rangeWidth15m: 4 }), stricter).regime).toBe('RANGE');
    expect(classifyRegime(make({ squeezeDuration: 4 }), stricter).regime).toBe('SQUEEZE');
    expect(classifyRegime(make({ squeezeDuration: 4 })).regime).toBe('UNCERTAIN');
    expect(classifyRegime(make(BROKEN), stricter).regime).toBe('UNCERTAIN');
    expect(
      classifyRegime(
        make({ releasedBarsAgo: 1, displacementBarsAgo: 1, displacementDirection: 'DOWN' }),
        stricter,
      ),
    ).toMatchObject({ regime: 'BREAKOUT', direction: 'DOWN' });
    expect(classifyRegime(make({ atrPercentile15m: 94 }), stricter).regime).toBe('UNCERTAIN');
    expect(classifyRegime(make({ atrPercentile15m: 95 }), stricter).regime).toBe('HIGH_VOL');
  });
});

describe('the numbers of docs/02 section 5', () => {
  it('are the defaults', () => {
    expect(REGIME_DEFAULTS).toEqual({
      periods: { emaFast: 20, emaMid: 50, emaSlow: 200, adx: 14, efficiency: 20, atr: 14 },
      trend: { adxMin: 20, efficiencyMin: 0.3 },
      range: { adxBelow: 18, lookback: 24, maxWidthAtr: 3 },
      squeeze: { minDuration: 8 },
      breakout: { withinCandles: 6 },
      highVol: { percentileFrom: 90, window: 480 },
      volBucket: { lowBelow: 33, highFrom: 67 },
    });
  });
});

describe('bad inputs are refused, not guessed', () => {
  it.each([
    ['emaFast', { emaFast: Number.NaN }],
    ['emaMid', { emaMid: Number.POSITIVE_INFINITY }],
    ['emaSlow', { emaSlow: Number.NaN }],
    ['adx1h', { adx1h: Number.NaN }],
    ['efficiency1h', { efficiency1h: Number.NaN }],
    ['atr15m', { atr15m: Number.NaN }],
    ['rangeWidth15m', { rangeWidth15m: Number.NaN }],
    ['atrPercentile15m', { atrPercentile15m: Number.NaN }],
  ] as const)('a %s that is not a number', (_name, change) => {
    expect(() => classifyRegime(make(change))).toThrow(RangeError);
  });

  it('a percentile outside 0 to 100', () => {
    expect(() => classifyRegime(make({ atrPercentile15m: -0.1 }))).toThrow(RangeError);
    expect(() => classifyRegime(make({ atrPercentile15m: 100.1 }))).toThrow(RangeError);
    expect(() => classifyRegime(make({ atrPercentile15m: 0 }))).not.toThrow();
    expect(() => classifyRegime(make({ atrPercentile15m: 100 }))).not.toThrow();
  });

  it('a count that is negative or not whole', () => {
    expect(() => classifyRegime(make({ squeezeDuration: -1 }))).toThrow(RangeError);
    expect(() => classifyRegime(make({ squeezeDuration: 1.5 }))).toThrow(RangeError);
    expect(() => classifyRegime(make({ releasedBarsAgo: -1 }))).toThrow(RangeError);
    expect(() => classifyRegime(make({ releasedBarsAgo: 0.5 }))).toThrow(RangeError);
    expect(() =>
      classifyRegime(make({ displacementBarsAgo: -1, displacementDirection: 'UP' })),
    ).toThrow(RangeError);
    expect(() =>
      classifyRegime(make({ displacementBarsAgo: 1.5, displacementDirection: 'UP' })),
    ).toThrow(RangeError);
  });

  it('a displacement with an age but no direction, or a direction but no age', () => {
    expect(() => classifyRegime(make({ displacementBarsAgo: 2 }))).toThrow(RangeError);
    expect(() => classifyRegime(make({ displacementDirection: 'UP' }))).toThrow(RangeError);
  });
});

describe('volBucketOf', () => {
  it('LOW below the 33rd percentile, HIGH from the 67th, NORMAL in between', () => {
    expect(volBucketOf(0)).toBe('LOW');
    expect(volBucketOf(32.99)).toBe('LOW');
    expect(volBucketOf(33)).toBe('NORMAL');
    expect(volBucketOf(50)).toBe('NORMAL');
    expect(volBucketOf(66.99)).toBe('NORMAL');
    expect(volBucketOf(67)).toBe('HIGH');
    expect(volBucketOf(100)).toBe('HIGH');
  });

  it('takes its limits from the parameters', () => {
    expect(volBucketOf(40, { lowBelow: 50, highFrom: 80 })).toBe('LOW');
    expect(volBucketOf(60, { lowBelow: 50, highFrom: 80 })).toBe('NORMAL');
    expect(volBucketOf(80, { lowBelow: 50, highFrom: 80 })).toBe('HIGH');
  });

  it('refuses a percentile that is not a number', () => {
    expect(() => volBucketOf(Number.NaN)).toThrow(RangeError);
  });

  it('the HIGH_VOL regime always falls in the HIGH bucket', () => {
    expect(REGIME_DEFAULTS.volBucket.highFrom).toBeLessThanOrEqual(
      REGIME_DEFAULTS.highVol.percentileFrom,
    );
  });
});
