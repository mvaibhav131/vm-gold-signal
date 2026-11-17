import { HOURLY_TREND_DEFAULTS, STRATEGY_KEYS } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { hourlyTrendParamsOf } from './hourlyTrendParams';
import { defaultStrategyConfig, strategyConfigSchema } from './strategy';

describe('the params of Hourly Trend in a strategy config', () => {
  it('the default config gives the averages, the stop and the half-hour cadence of the strategy', () => {
    expect(hourlyTrendParamsOf(defaultStrategyConfig('hourly_trend'))).toEqual({
      periods: { emaFast: 20, emaMid: 50, emaSlow: 200, atr: 14 },
      stopAtr1h: 2.5,
      everyMin: 30,
    });
    expect(hourlyTrendParamsOf(defaultStrategyConfig('hourly_trend'))).toEqual(
      HOURLY_TREND_DEFAULTS,
    );
  });

  it('follows the config: each param is a changed rule', () => {
    const config = defaultStrategyConfig('hourly_trend');
    if (config.strategyKey !== 'hourly_trend') throw new Error('expected hourly_trend');
    const changed = {
      ...config,
      params: { emaFast: 10, emaMid: 30, emaSlow: 100, atrPeriod: 10, stopAtr1h: 3, everyMin: 60 },
    };
    expect(hourlyTrendParamsOf(changed)).toEqual({
      periods: { emaFast: 10, emaMid: 30, emaSlow: 100, atr: 10 },
      stopAtr1h: 3,
      everyMin: 60,
    });
  });

  it('is wide enough for the stop of an hourly decision, in ATR(5m), and accepts every regime', () => {
    const config = defaultStrategyConfig('hourly_trend');
    expect(config.gates).toMatchObject({ stopAtr: [3, 16], tp1MaxAtr: 20 });
    expect(config.acceptedRegimes).toEqual([
      'TREND_UP',
      'TREND_DOWN',
      'RANGE',
      'SQUEEZE',
      'BREAKOUT',
      'HIGH_VOL',
      'UNCERTAIN',
    ]);
  });

  it('refuses averages that do not grow from fast to middle to slow, and a cadence that does not divide an hour', () => {
    const config = defaultStrategyConfig('hourly_trend');
    if (config.strategyKey !== 'hourly_trend') throw new Error('expected hourly_trend');
    for (const params of [
      { ...config.params, emaFast: 50 },
      { ...config.params, emaMid: 200 },
      { ...config.params, emaSlow: 20 },
      { ...config.params, everyMin: 7 },
      { ...config.params, everyMin: 45 },
      { ...config.params, everyMin: 0 },
    ]) {
      expect(strategyConfigSchema.safeParse({ ...config, params }).success).toBe(false);
    }
  });

  it.each(STRATEGY_KEYS.filter((key) => key !== 'hourly_trend'))(
    'refuses the config of %s',
    (key) => {
      expect(() => hourlyTrendParamsOf(defaultStrategyConfig(key))).toThrow(TypeError);
    },
  );
});
