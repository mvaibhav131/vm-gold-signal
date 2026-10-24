import { STRATEGY_KEYS, SQUEEZE_RETEST_DEFAULTS } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { defaultStrategyConfig } from './strategy';
import { squeezeRetestParamsOf } from './squeezeRetestParams';

describe('the params of Squeeze Retest in a strategy config', () => {
  it('the default config gives exactly the defaults of core', () => {
    expect(squeezeRetestParamsOf(defaultStrategyConfig('squeeze_retest'))).toEqual(
      SQUEEZE_RETEST_DEFAULTS,
    );
  });

  it('follows the config: each of the six params is a changed rule', () => {
    const config = defaultStrategyConfig('squeeze_retest');
    if (config.strategyKey !== 'squeeze_retest') throw new Error('expected squeeze_retest');
    const changed = {
      ...config,
      params: {
        squeezeMinCandles15m: 10,
        donchianPeriod: 30,
        breakoutMinAtr: 0.2,
        retestWithinCandles: 5,
        retestMaxDistanceAtr: 0.4,
        stopBufferAtr: 0.5,
      },
    };
    expect(squeezeRetestParamsOf(changed)).toEqual({
      ...SQUEEZE_RETEST_DEFAULTS,
      ...changed.params,
    });
  });

  it('keeps the periods, the release window and the wick of the strategy', () => {
    const params = squeezeRetestParamsOf(defaultStrategyConfig('squeeze_retest'));
    expect(params).toMatchObject({
      atrPeriod: 14,
      adxPeriod: 14,
      releaseWithinCandles15m: 6,
      rejectionWickRatio: 0.3,
    });
  });

  it('the regimes of the default config are the ones the strategy was written for', () => {
    expect(defaultStrategyConfig('squeeze_retest').acceptedRegimes).toEqual([
      'SQUEEZE',
      'BREAKOUT',
    ]);
  });

  it.each(STRATEGY_KEYS.filter((key) => key !== 'squeeze_retest'))(
    'refuses the config of %s',
    (key) => {
      expect(() => squeezeRetestParamsOf(defaultStrategyConfig(key))).toThrow(TypeError);
    },
  );
});
