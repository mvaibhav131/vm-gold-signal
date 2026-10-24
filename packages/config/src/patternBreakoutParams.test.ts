import { PATTERN_BREAKOUT_DEFAULTS, STRATEGY_KEYS } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { patternBreakoutParamsOf } from './patternBreakoutParams';
import { defaultStrategyConfig } from './strategy';

describe('the params of Pattern Breakout in a strategy config', () => {
  it('the default config gives exactly the defaults of core', () => {
    expect(patternBreakoutParamsOf(defaultStrategyConfig('pattern_breakout'))).toEqual(
      PATTERN_BREAKOUT_DEFAULTS,
    );
  });

  it('follows the config: each of the three params is a changed rule', () => {
    const config = defaultStrategyConfig('pattern_breakout');
    if (config.strategyKey !== 'pattern_breakout') throw new Error('expected pattern_breakout');
    const changed = {
      ...config,
      params: { retestWithinCandles: 5, stopBufferAtr: 0.5, minMeasuredMoveR: 2 },
    };
    expect(patternBreakoutParamsOf(changed)).toEqual({
      ...PATTERN_BREAKOUT_DEFAULTS,
      ...changed.params,
    });
  });

  it('keeps the ATR period and the retest of strategy C', () => {
    const params = patternBreakoutParamsOf(defaultStrategyConfig('pattern_breakout'));
    expect(params).toMatchObject({
      atrPeriod: 14,
      retestMaxDistanceAtr: 0.25,
      retestMinWickFraction: 0.3,
    });
  });

  it('the regimes of the default config are all but HIGH_VOL, as the strategy was written for', () => {
    expect(defaultStrategyConfig('pattern_breakout').acceptedRegimes).toEqual([
      'TREND_UP',
      'TREND_DOWN',
      'RANGE',
      'SQUEEZE',
      'BREAKOUT',
      'UNCERTAIN',
    ]);
  });

  it.each(STRATEGY_KEYS.filter((key) => key !== 'pattern_breakout'))(
    'refuses the config of %s',
    (key) => {
      expect(() => patternBreakoutParamsOf(defaultStrategyConfig(key))).toThrow(TypeError);
    },
  );
});
