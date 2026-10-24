import { SQUEEZE_RETEST_DEFAULTS, type SqueezeRetestParams } from '@vmgs/core';

import type { StrategyConfig } from './strategy';

/**
 * The numbers of Squeeze Retest of one strategy version, as the strategy reads them
 * (`SqueezeRetestParams` of core). The six `squeeze_retest` params come from the config. The
 * indicator periods, the release window and the rejection wick come with the strategy (docs/02
 * section 7.3), so they come from the core defaults.
 */
export function squeezeRetestParamsOf(config: StrategyConfig): SqueezeRetestParams {
  if (config.strategyKey !== 'squeeze_retest') {
    throw new TypeError(`expected a squeeze_retest config, got ${config.strategyKey}`);
  }
  const { params } = config;
  return {
    ...SQUEEZE_RETEST_DEFAULTS,
    squeezeMinCandles15m: params.squeezeMinCandles15m,
    donchianPeriod: params.donchianPeriod,
    breakoutMinAtr: params.breakoutMinAtr,
    retestWithinCandles: params.retestWithinCandles,
    retestMaxDistanceAtr: params.retestMaxDistanceAtr,
    stopBufferAtr: params.stopBufferAtr,
  };
}
