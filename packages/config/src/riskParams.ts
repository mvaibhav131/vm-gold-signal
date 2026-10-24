import type { QualityWeights, RiskParams } from '@vmgs/core';

import type { StrategyConfig } from './strategy';

/**
 * The entry, fill and exit numbers of one strategy version, as the trade model reads them
 * (`RiskParams` of core; docs/02 section 9.1).
 */
export function riskParamsOf(config: StrategyConfig): RiskParams {
  const { risk } = config;
  return {
    exitProfile: risk.exitProfile,
    simSlippageUsd: risk.simSlippageUsd,
    execDelaySec: risk.execDelaySec,
    commissionUsdPerOz: risk.commissionUsdPerOz,
    entryValidSec: risk.entryValidSec,
    maxChaseAtr: risk.maxChaseAtr,
    maxChaseRiskFraction: risk.maxChaseRiskFraction,
    timeStopMin: risk.timeStopMin,
  };
}

/** The weight of each quality group of one strategy version, for `scoreQuality` of core. */
export function qualityWeightsOf(config: StrategyConfig): QualityWeights {
  return { ...config.quality.weights };
}
