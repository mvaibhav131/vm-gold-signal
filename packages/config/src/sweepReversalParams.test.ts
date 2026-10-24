import { STRATEGY_KEYS, SWEEP_REVERSAL_DEFAULTS } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { defaultStrategyConfig } from './strategy';
import { sweepReversalParamsOf } from './sweepReversalParams';

describe('the params of Sweep Reversal in a strategy config', () => {
  it('the default config gives exactly the defaults of core', () => {
    expect(sweepReversalParamsOf(defaultStrategyConfig('sweep_reversal'))).toEqual(
      SWEEP_REVERSAL_DEFAULTS,
    );
  });

  it('follows the config: each of the three params is a changed rule', () => {
    const config = defaultStrategyConfig('sweep_reversal');
    if (config.strategyKey !== 'sweep_reversal') throw new Error('expected sweep_reversal');
    const changed = {
      ...config,
      params: { triggerWithinCandles: 4, requireChochInTrend: false, stopBufferAtr: 0.5 },
    };
    expect(sweepReversalParamsOf(changed)).toEqual({
      ...SWEEP_REVERSAL_DEFAULTS,
      ...changed.params,
    });
  });

  it('keeps the ATR period of the strategy', () => {
    expect(sweepReversalParamsOf(defaultStrategyConfig('sweep_reversal')).atrPeriod).toBe(14);
  });

  it('the regimes of the default config are the ones the strategy was written for', () => {
    expect(defaultStrategyConfig('sweep_reversal').acceptedRegimes).toEqual([
      'RANGE',
      'TREND_UP',
      'TREND_DOWN',
      'BREAKOUT',
    ]);
  });

  it.each(STRATEGY_KEYS.filter((key) => key !== 'sweep_reversal'))(
    'refuses the config of %s',
    (key) => {
      expect(() => sweepReversalParamsOf(defaultStrategyConfig(key))).toThrow(TypeError);
    },
  );
});
