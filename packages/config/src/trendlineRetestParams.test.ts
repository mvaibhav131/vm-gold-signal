import { STRATEGY_KEYS, TRENDLINE_RETEST_DEFAULTS } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { defaultStrategyConfig } from './strategy';
import { trendlineRetestParamsOf } from './trendlineRetestParams';

describe('the params of Trendline Retest in a strategy config', () => {
  it('the default config gives exactly the defaults of core', () => {
    expect(trendlineRetestParamsOf(defaultStrategyConfig('trendline_retest'))).toEqual(
      TRENDLINE_RETEST_DEFAULTS,
    );
  });

  it('follows the config: each of the nine params is a changed rule', () => {
    const config = defaultStrategyConfig('trendline_retest');
    if (config.strategyKey !== 'trendline_retest') throw new Error('expected trendline_retest');
    const changed = {
      ...config,
      params: {
        minTouches: 4,
        maxAdx1hAgainst: 25,
        breakMinAtr: 0.2,
        breakMinBodyFraction: 0.6,
        retestWithinCandles: 5,
        retestMaxDistanceAtr: 0.4,
        retestMinWickFraction: 0.35,
        retestMinRsi: 50,
        stopBufferAtr: 0.5,
      },
    };
    expect(trendlineRetestParamsOf(changed)).toEqual({
      ...TRENDLINE_RETEST_DEFAULTS,
      ...changed.params,
    });
  });

  it('keeps the indicator periods of the strategy', () => {
    const params = trendlineRetestParamsOf(defaultStrategyConfig('trendline_retest'));
    expect(params).toMatchObject({ atrPeriod: 14, rsiPeriod: 14, adxPeriod: 14 });
  });

  it('the regimes of the default config are the ones the strategy was written for', () => {
    expect(defaultStrategyConfig('trendline_retest').acceptedRegimes).toEqual([
      'TREND_UP',
      'TREND_DOWN',
      'RANGE',
      'BREAKOUT',
    ]);
  });

  it.each(STRATEGY_KEYS.filter((key) => key !== 'trendline_retest'))(
    'refuses the config of %s',
    (key) => {
      expect(() => trendlineRetestParamsOf(defaultStrategyConfig(key))).toThrow(TypeError);
    },
  );
});
