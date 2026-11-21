import { CONFLUENCE_DEFAULTS, STRATEGY_KEYS } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { confluenceParamsOf } from './confluenceParams';
import { defaultStrategyConfig, strategyConfigSchema } from './strategy';

describe('the params of Confluence in a strategy config', () => {
  it('the default config gives exactly the defaults of the strategy', () => {
    expect(confluenceParamsOf(defaultStrategyConfig('confluence'))).toEqual(CONFLUENCE_DEFAULTS);
  });

  it('follows the config: each param is a changed rule', () => {
    const config = defaultStrategyConfig('confluence');
    if (config.strategyKey !== 'confluence') throw new Error('expected confluence');
    const changed = {
      ...config,
      params: {
        emaFast: 10,
        emaMid: 30,
        emaSlow: 100,
        rsiPeriod: 9,
        atrPeriod: 10,
        adxPeriod: 12,
        minVotes: 8,
        minBodyAtr: 0.5,
        atrFloor: 1,
        swingCandles: 8,
        stopBufferAtr: 0.3,
        minStopAtr: 2.5,
        maxStopAtr: 4,
        maxStopUsd: 14,
        slotMin: 60,
        sessionFromMin: 480,
        sessionToMin: 1200,
      },
    };
    expect(confluenceParamsOf(changed)).toEqual({
      periods: { emaFast: 10, emaMid: 30, emaSlow: 100, rsi: 9, atr: 10, adx: 12 },
      minVotes: 8,
      minBodyAtr: 0.5,
      atrFloor: 1,
      swingCandles: 8,
      stopBufferAtr: 0.3,
      minStopAtr: 2.5,
      maxStopAtr: 4,
      maxStopUsd: 14,
      slotMin: 60,
      sessionFromMin: 480,
      sessionToMin: 1200,
    });
  });

  it('wants a stop of 3 to 4.2 ATR(5m), a gate that lets it through, and a first target at the stop', () => {
    const config = defaultStrategyConfig('confluence');
    expect(config.gates).toMatchObject({ stopAtr: [2.5, 5], tp1MaxAtr: 5 });
    expect(config.risk).toMatchObject({ exitProfile: 'EP1_PARTIAL', timeStopMin: 120 });
    expect(config.quality.weights.trend + config.quality.weights.trigger).toBeGreaterThan(0.4);
  });

  it('refuses averages that do not grow, a stop band that is upside down, a slot that does not divide a day, a session that ends before it starts and a vote count of 0 or 10', () => {
    const config = defaultStrategyConfig('confluence');
    if (config.strategyKey !== 'confluence') throw new Error('expected confluence');
    for (const params of [
      { ...config.params, emaFast: 50 },
      { ...config.params, emaSlow: 20 },
      { ...config.params, minStopAtr: 4.2 },
      { ...config.params, minStopAtr: 5 },
      { ...config.params, slotMin: 7 },
      { ...config.params, slotMin: 25 },
      { ...config.params, sessionFromMin: 1230 },
      { ...config.params, minVotes: 0 },
      { ...config.params, minVotes: 10 },
    ]) {
      expect(strategyConfigSchema.safeParse({ ...config, params }).success).toBe(false);
    }
  });

  it.each(STRATEGY_KEYS.filter((key) => key !== 'confluence'))(
    'refuses the config of %s',
    (key) => {
      expect(() => confluenceParamsOf(defaultStrategyConfig(key))).toThrow(TypeError);
    },
  );
});
