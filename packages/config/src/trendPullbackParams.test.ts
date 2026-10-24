import { STRATEGY_KEYS, TREND_PULLBACK_DEFAULTS } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { defaultStrategyConfig } from './strategy';
import { trendPullbackParamsOf } from './trendPullbackParams';

describe('the params of Trend Pullback in a strategy config', () => {
  it('the default config gives exactly the defaults of core', () => {
    expect(trendPullbackParamsOf(defaultStrategyConfig('trend_pullback'))).toEqual(
      TREND_PULLBACK_DEFAULTS,
    );
  });

  it('follows the config: each of the six params is a changed rule', () => {
    const config = defaultStrategyConfig('trend_pullback');
    if (config.strategyKey !== 'trend_pullback') throw new Error('expected trend_pullback');
    const changed = {
      ...config,
      params: {
        emaSlopeHours: 4,
        rsiPullbackMax: 40,
        rsiLookbackCandles: 10,
        rsiRiseLookbackCandles: 2,
        macdRisingCandles: 3,
        stopBufferAtr: 0.5,
      },
    };
    expect(trendPullbackParamsOf(changed)).toEqual({
      ...TREND_PULLBACK_DEFAULTS,
      ...changed.params,
    });
  });

  it('keeps the periods and the leg lookback of the strategy', () => {
    const params = trendPullbackParamsOf(defaultStrategyConfig('trend_pullback'));
    expect(params.periods).toBe(TREND_PULLBACK_DEFAULTS.periods);
    expect(params.legLookbackCandles).toBe(36);
  });

  it.each(STRATEGY_KEYS.filter((key) => key !== 'trend_pullback'))(
    'refuses the config of %s',
    (key) => {
      expect(() => trendPullbackParamsOf(defaultStrategyConfig(key))).toThrow(TypeError);
    },
  );
});
