import { PATTERN_BREAKOUT_DEFAULTS, type PatternBreakoutParams } from '@vmgs/core';

import type { StrategyConfig } from './strategy';

/**
 * The numbers of Pattern Breakout of one strategy version, as the strategy reads them
 * (`PatternBreakoutParams` of core). The three `pattern_breakout` params come from the config. The
 * ATR period and the two numbers of the retest ("the same rule as strategy C") come with the
 * strategy (docs/02 section 7.5), so they come from the core defaults.
 */
export function patternBreakoutParamsOf(config: StrategyConfig): PatternBreakoutParams {
  if (config.strategyKey !== 'pattern_breakout') {
    throw new TypeError(`expected a pattern_breakout config, got ${config.strategyKey}`);
  }
  const { params } = config;
  return {
    ...PATTERN_BREAKOUT_DEFAULTS,
    retestWithinCandles: params.retestWithinCandles,
    stopBufferAtr: params.stopBufferAtr,
    minMeasuredMoveR: params.minMeasuredMoveR,
  };
}
