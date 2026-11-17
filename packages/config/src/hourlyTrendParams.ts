import type { HourlyTrendParams } from '@vmgs/core';

import type { StrategyConfig } from './strategy';

/**
 * The numbers of the Hourly Trend strategy of one strategy version, as the strategy reads them
 * (`HourlyTrendParams` of core). All six `hourly_trend` params come from the config.
 */
export function hourlyTrendParamsOf(config: StrategyConfig): HourlyTrendParams {
  if (config.strategyKey !== 'hourly_trend') {
    throw new TypeError(`expected a hourly_trend config, got ${config.strategyKey}`);
  }
  const { params } = config;
  return {
    periods: {
      emaFast: params.emaFast,
      emaMid: params.emaMid,
      emaSlow: params.emaSlow,
      atr: params.atrPeriod,
    },
    stopAtr1h: params.stopAtr1h,
    everyMin: params.everyMin,
  };
}
