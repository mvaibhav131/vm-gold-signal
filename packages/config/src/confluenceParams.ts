import type { ConfluenceParams } from '@vmgs/core';

import type { StrategyConfig } from './strategy';

/**
 * The numbers of the Confluence strategy of one strategy version, as the strategy reads them
 * (`ConfluenceParams` of core). Every `confluence` param comes from the config.
 */
export function confluenceParamsOf(config: StrategyConfig): ConfluenceParams {
  if (config.strategyKey !== 'confluence') {
    throw new TypeError(`expected a confluence config, got ${config.strategyKey}`);
  }
  const { params } = config;
  return {
    periods: {
      emaFast: params.emaFast,
      emaMid: params.emaMid,
      emaSlow: params.emaSlow,
      rsi: params.rsiPeriod,
      atr: params.atrPeriod,
      adx: params.adxPeriod,
    },
    minVotes: params.minVotes,
    minBodyAtr: params.minBodyAtr,
    atrFloor: params.atrFloor,
    swingCandles: params.swingCandles,
    stopBufferAtr: params.stopBufferAtr,
    minStopAtr: params.minStopAtr,
    maxStopAtr: params.maxStopAtr,
    maxStopUsd: params.maxStopUsd,
    slotMin: params.slotMin,
    sessionFromMin: params.sessionFromMin,
    sessionToMin: params.sessionToMin,
  };
}
