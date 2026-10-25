import type { StrategySpec, StrategyStatus } from '@vmgs/core';

import { advisoryModesOf, gateParamsOf, requiredTimeframes } from './gateParams';
import { patternBreakoutParamsOf } from './patternBreakoutParams';
import { qualityWeightsOf, riskParamsOf } from './riskParams';
import { squeezeRetestParamsOf } from './squeezeRetestParams';
import type { StrategyConfig } from './strategy';
import { sweepReversalParamsOf } from './sweepReversalParams';
import { trendPullbackParamsOf } from './trendPullbackParams';
import { trendlineRetestParamsOf } from './trendlineRetestParams';

/**
 * Everything the decision engine reads of a strategy version, in the shapes the code uses: the gates, the
 * risk and exit model, the quality weights, the news window, the advisory modes and the rules of the strategy.
 * The status is not part of the config (it changes as the forward test goes on): it comes from the stored version.
 */
export function strategySpecOf(config: StrategyConfig, status: StrategyStatus): StrategySpec {
  const common = {
    version: config.version,
    status,
    acceptedRegimes: config.acceptedRegimes,
    gates: gateParamsOf(config),
    requiredTimeframes: requiredTimeframes(config),
    modes: advisoryModesOf(config),
    risk: riskParamsOf(config),
    weights: qualityWeightsOf(config),
    newsWindow: config.gates.newsWindow,
  };
  switch (config.strategyKey) {
    case 'trend_pullback':
      return { ...common, strategyKey: config.strategyKey, params: trendPullbackParamsOf(config) };
    case 'sweep_reversal':
      return { ...common, strategyKey: config.strategyKey, params: sweepReversalParamsOf(config) };
    case 'squeeze_retest':
      return { ...common, strategyKey: config.strategyKey, params: squeezeRetestParamsOf(config) };
    case 'trendline_retest':
      return {
        ...common,
        strategyKey: config.strategyKey,
        params: trendlineRetestParamsOf(config),
      };
    case 'pattern_breakout':
      return {
        ...common,
        strategyKey: config.strategyKey,
        params: patternBreakoutParamsOf(config),
      };
  }
}
