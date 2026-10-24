import { TREND_PULLBACK_DEFAULTS, type TrendPullbackParams } from '@vmgs/core';

import type { StrategyConfig } from './strategy';

/**
 * The numbers of Trend Pullback of one strategy version, as the strategy reads them
 * (`TrendPullbackParams` of core). The six `trend_pullback` params come from the config. The
 * periods of the indicators and the lookback of the pullback leg are not part of the config (they
 * come with the strategy, docs/02 section 7.1), so they come from the core defaults.
 */
export function trendPullbackParamsOf(config: StrategyConfig): TrendPullbackParams {
  if (config.strategyKey !== 'trend_pullback') {
    throw new TypeError(`expected a trend_pullback config, got ${config.strategyKey}`);
  }
  const { params } = config;
  return {
    ...TREND_PULLBACK_DEFAULTS,
    emaSlopeHours: params.emaSlopeHours,
    rsiPullbackMax: params.rsiPullbackMax,
    rsiLookbackCandles: params.rsiLookbackCandles,
    rsiRiseLookbackCandles: params.rsiRiseLookbackCandles,
    macdRisingCandles: params.macdRisingCandles,
    stopBufferAtr: params.stopBufferAtr,
  };
}
