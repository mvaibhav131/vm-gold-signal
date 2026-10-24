import { TRENDLINE_RETEST_DEFAULTS, type TrendlineRetestParams } from '@vmgs/core';

import type { StrategyConfig } from './strategy';

/**
 * The numbers of Trendline Retest of one strategy version, as the strategy reads them
 * (`TrendlineRetestParams` of core). The nine `trendline_retest` params come from the config. The
 * indicator periods come with the strategy (docs/02 section 7.4), so they come from the core
 * defaults.
 */
export function trendlineRetestParamsOf(config: StrategyConfig): TrendlineRetestParams {
  if (config.strategyKey !== 'trendline_retest') {
    throw new TypeError(`expected a trendline_retest config, got ${config.strategyKey}`);
  }
  const { params } = config;
  return {
    ...TRENDLINE_RETEST_DEFAULTS,
    minTouches: params.minTouches,
    maxAdx1hAgainst: params.maxAdx1hAgainst,
    breakMinAtr: params.breakMinAtr,
    breakMinBodyFraction: params.breakMinBodyFraction,
    retestWithinCandles: params.retestWithinCandles,
    retestMaxDistanceAtr: params.retestMaxDistanceAtr,
    retestMinWickFraction: params.retestMinWickFraction,
    retestMinRsi: params.retestMinRsi,
    stopBufferAtr: params.stopBufferAtr,
  };
}
