import { GATE_DEFAULTS, type AdvisoryModes, type GateParams, type Timeframe } from '@vmgs/core';

import type { StrategyConfig } from './strategy';

/**
 * The numbers of the blocking gates of one strategy version, as the engine reads them (`GateParams`
 * of core). The warm-up sizes are not part of the strategy config: they follow from the windows the
 * engine itself uses (docs/02 section 6.1), so they come from the core defaults.
 */
export function gateParamsOf(config: StrategyConfig): GateParams {
  const { gates, quality } = config;
  return {
    maxTickAgeSec: gates.maxTickAgeSec,
    maxClockSkewSec: gates.maxClockSkewSec,
    maxSpreadUsd: gates.maxSpreadUsd,
    maxSpreadToStop: gates.maxSpreadToStop,
    gapRecoveryCandles: gates.gapRecoveryCandles,
    stopAtr: gates.stopAtr,
    tp1MaxAtr: gates.tp1MaxAtr,
    quality: { min: quality.min, minCoverage: quality.minCoverage },
    warmupCandles: GATE_DEFAULTS.warmupCandles,
  };
}

/** The timeframes that the strategy needs warmed up: entry, context and bias, each once. */
export function requiredTimeframes(config: StrategyConfig): Timeframe[] {
  const { entry, context, bias } = config.timeframes;
  return [...new Set([entry, context, bias])];
}

/** The advisory modes that the strategy config starts from; the owner's settings override them. */
export function advisoryModesOf(config: StrategyConfig): AdvisoryModes {
  const { newsWindow, rollover, offHours, nearLevel } = config.advisory;
  return { newsWindow, rollover, offHours, nearLevel };
}
