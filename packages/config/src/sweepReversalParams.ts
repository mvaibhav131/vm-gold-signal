import { SWEEP_REVERSAL_DEFAULTS, type SweepReversalParams } from '@vmgs/core';

import type { StrategyConfig } from './strategy';

/**
 * The numbers of Sweep Reversal of one strategy version, as the strategy reads them
 * (`SweepReversalParams` of core). The three `sweep_reversal` params come from the config. The ATR
 * period comes with the strategy (docs/02 section 7.2), so it comes from the core defaults.
 */
export function sweepReversalParamsOf(config: StrategyConfig): SweepReversalParams {
  if (config.strategyKey !== 'sweep_reversal') {
    throw new TypeError(`expected a sweep_reversal config, got ${config.strategyKey}`);
  }
  const { params } = config;
  return {
    ...SWEEP_REVERSAL_DEFAULTS,
    triggerWithinCandles: params.triggerWithinCandles,
    requireChochInTrend: params.requireChochInTrend,
    stopBufferAtr: params.stopBufferAtr,
  };
}
