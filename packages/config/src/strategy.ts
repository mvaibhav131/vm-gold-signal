import { GRADE_THRESHOLDS, QUALITY_GROUPS, type QualityGroup, type StrategyKey } from '@vmgs/core';
import { exitProfileSchema, regimeSchema, semverSchema } from '@vmgs/contracts';
import { z } from 'zod';

import { canonicalJson, sha256Hex } from './canonical';

// Parameters of strategy-config v0.1.0 (02_Signal_Engine). They are hypotheses: they may be tuned only
// on the training and validation splits, and every change creates a new immutable strategy version.
// This phase holds the sections of the document that are decisions of a strategy: gates, risk and exit,
// quality weights and the rules of strategies A to E. The numeric definitions of indicators and
// primitives (swing pivots, displacement, trendline tolerances, ...) are added with the phase that
// implements them, as new optional sections with their own defaults.

const positive = z.number().positive();
const atrMultiple = z.number().positive().max(20);
const fraction = z.number().gt(0).max(1);
const candleCount = z.int().positive().max(1000);

/** Blocking gates (02_Signal_Engine section 6). */
export const gatesConfigSchema = z
  .strictObject({
    dataFreshSec: positive,
    clockSkewSec: positive,
    maxSpreadUsd: positive,
    maxSpreadStopFraction: fraction,
    gapRecoveryCandles: candleCount,
    stopAtrMin: atrMultiple,
    stopAtrMax: atrMultiple,
    tp1AtrMax: atrMultiple,
    // Grades start at 65, so a lower threshold would let through a setup that has no grade.
    minQuality: z.number().min(GRADE_THRESHOLDS.moderate).max(100),
  })
  .refine((gates) => gates.stopAtrMin < gates.stopAtrMax, 'stopAtrMin must be below stopAtrMax');
export type GatesConfig = z.infer<typeof gatesConfigSchema>;

/** Entry, fill and exit model (section 9). The live engine only chooses among fixed exit profiles. */
export const riskConfigSchema = z.strictObject({
  exitProfile: exitProfileSchema,
  simSlippageUsd: z.number().nonnegative(),
  commissionUsdPerOz: z.number().nonnegative(),
  maxValidEntryAtr: atrMultiple,
  maxValidEntryRiskFraction: fraction,
  entryValidSec: z.int().positive(),
  timeStopMin: z.int().positive(),
});
export type RiskConfig = z.infer<typeof riskConfigSchema>;

const groupWeights = Object.fromEntries(QUALITY_GROUPS.map((group) => [group, fraction])) as Record<
  QualityGroup,
  typeof fraction
>;

/** Quality score weights (section 8). They must add up to 1. */
export const qualityConfigSchema = z.strictObject({
  weights: z
    .strictObject(groupWeights)
    .refine(
      (weights) => Math.abs(Object.values(weights).reduce((sum, w) => sum + w, 0) - 1) < 1e-9,
      'weights must add up to 1',
    ),
  // If less weight than this is available (groups with data), the signal is blocked.
  minAvailableWeight: fraction,
});
export type QualityConfig = z.infer<typeof qualityConfigSchema>;

const acceptedRegimes = z
  .array(regimeSchema)
  .min(1)
  .refine((regimes) => new Set(regimes).size === regimes.length, 'duplicate regime');

const stopBufferAtr = atrMultiple;

const commonShape = {
  version: semverSchema,
  acceptedRegimes,
  gates: gatesConfigSchema,
  risk: riskConfigSchema,
  quality: qualityConfigSchema,
};

const trendPullbackSchema = z.strictObject({
  strategyKey: z.literal('trend_pullback'),
  ...commonShape,
  params: z.strictObject({
    emaSlopeHours: z.int().positive(),
    rsiPullbackMax: z.number().min(0).max(100),
    rsiLookbackCandles: candleCount,
    rsiRiseLookbackCandles: candleCount,
    macdRisingCandles: candleCount,
    stopBufferAtr,
  }),
});

const sweepReversalSchema = z.strictObject({
  strategyKey: z.literal('sweep_reversal'),
  ...commonShape,
  params: z.strictObject({
    triggerWithinCandles: candleCount,
    // In a trend, a reversal is accepted only together with a 15m CHoCH in the reversal direction.
    requireChochInTrend: z.boolean(),
    stopBufferAtr,
  }),
});

const squeezeRetestSchema = z.strictObject({
  strategyKey: z.literal('squeeze_retest'),
  ...commonShape,
  params: z.strictObject({
    squeezeMinCandles15m: candleCount,
    donchianPeriod: candleCount,
    breakoutMinAtr: atrMultiple,
    retestWithinCandles: candleCount,
    retestMaxDistanceAtr: atrMultiple,
    stopBufferAtr,
  }),
});

const trendlineRetestSchema = z.strictObject({
  strategyKey: z.literal('trendline_retest'),
  ...commonShape,
  params: z.strictObject({
    minTouches: z.int().min(2).max(20),
    maxAdx1hAgainst: z.number().positive().max(100),
    breakMinAtr: atrMultiple,
    breakMinBodyFraction: fraction,
    retestWithinCandles: candleCount,
    retestMaxDistanceAtr: atrMultiple,
    retestMinWickFraction: fraction,
    retestMinRsi: z.number().min(0).max(100),
    stopBufferAtr,
  }),
});

const patternBreakoutSchema = z.strictObject({
  strategyKey: z.literal('pattern_breakout'),
  ...commonShape,
  params: z.strictObject({
    retestWithinCandles: candleCount,
    stopBufferAtr,
    // Below this measured-move multiple of the risk the setup produces no signal.
    minMeasuredMoveR: positive,
  }),
});

/** The immutable config of one strategy version, stored as strategy_versions.config. */
export const strategyConfigSchema = z.discriminatedUnion('strategyKey', [
  trendPullbackSchema,
  sweepReversalSchema,
  squeezeRetestSchema,
  trendlineRetestSchema,
  patternBreakoutSchema,
]);
export type StrategyConfig = z.infer<typeof strategyConfigSchema>;

export const STRATEGY_CONFIG_VERSION = '0.1.0';

function defaultGates(): GatesConfig {
  return {
    dataFreshSec: 10,
    clockSkewSec: 5,
    maxSpreadUsd: 0.6,
    maxSpreadStopFraction: 0.12,
    gapRecoveryCandles: 12,
    stopAtrMin: 0.8,
    stopAtrMax: 2.0,
    tp1AtrMax: 2.5,
    minQuality: 65,
  };
}

function defaultRisk(exitProfile: RiskConfig['exitProfile']): RiskConfig {
  return {
    exitProfile,
    simSlippageUsd: 0.05,
    commissionUsdPerOz: 0,
    maxValidEntryAtr: 0.15,
    maxValidEntryRiskFraction: 0.25,
    entryValidSec: 180,
    timeStopMin: 120,
  };
}

function defaultQuality(): QualityConfig {
  return {
    weights: {
      trend: 0.22,
      structure: 0.22,
      trigger: 0.14,
      volatility: 0.1,
      execution: 0.12,
      sessionMacro: 0.12,
      reward: 0.08,
    },
    minAvailableWeight: 0.7,
  };
}

/** A fresh copy of the v0.1.0 config of a strategy (the starting point of the research phases). */
export function defaultStrategyConfig(key: StrategyKey): StrategyConfig {
  const common = {
    version: STRATEGY_CONFIG_VERSION,
    gates: defaultGates(),
    quality: defaultQuality(),
  };
  switch (key) {
    case 'trend_pullback':
      return {
        strategyKey: key,
        ...common,
        acceptedRegimes: ['TREND_UP', 'TREND_DOWN'],
        risk: defaultRisk('EP1_PARTIAL'),
        params: {
          emaSlopeHours: 6,
          rsiPullbackMax: 45,
          rsiLookbackCandles: 12,
          rsiRiseLookbackCandles: 3,
          macdRisingCandles: 2,
          stopBufferAtr: 0.25,
        },
      };
    case 'sweep_reversal':
      return {
        strategyKey: key,
        ...common,
        acceptedRegimes: ['RANGE', 'TREND_UP', 'TREND_DOWN', 'BREAKOUT'],
        risk: defaultRisk('EP1_PARTIAL'),
        params: { triggerWithinCandles: 6, requireChochInTrend: true, stopBufferAtr: 0.2 },
      };
    case 'squeeze_retest':
      return {
        strategyKey: key,
        ...common,
        acceptedRegimes: ['SQUEEZE', 'BREAKOUT'],
        risk: defaultRisk('EP1_PARTIAL'),
        params: {
          squeezeMinCandles15m: 8,
          donchianPeriod: 20,
          breakoutMinAtr: 0.1,
          retestWithinCandles: 8,
          retestMaxDistanceAtr: 0.25,
          stopBufferAtr: 0.2,
        },
      };
    case 'trendline_retest':
      return {
        strategyKey: key,
        ...common,
        acceptedRegimes: ['TREND_UP', 'TREND_DOWN', 'RANGE', 'BREAKOUT'],
        risk: defaultRisk('EP1_PARTIAL'),
        params: {
          minTouches: 3,
          maxAdx1hAgainst: 30,
          breakMinAtr: 0.1,
          breakMinBodyFraction: 0.5,
          retestWithinCandles: 8,
          retestMaxDistanceAtr: 0.3,
          retestMinWickFraction: 0.3,
          retestMinRsi: 45,
          stopBufferAtr: 0.25,
        },
      };
    case 'pattern_breakout':
      return {
        strategyKey: key,
        ...common,
        acceptedRegimes: ['TREND_UP', 'TREND_DOWN', 'RANGE', 'SQUEEZE', 'BREAKOUT', 'UNCERTAIN'],
        risk: defaultRisk('EP3_STRUCTURE'),
        params: { retestWithinCandles: 8, stopBufferAtr: 0.25, minMeasuredMoveR: 1.5 },
      };
  }
}

/** The hash stored in strategy_versions.config_hash: SHA-256 of the canonical JSON of the validated config. */
export function strategyConfigHash(config: unknown): string {
  return sha256Hex(canonicalJson(strategyConfigSchema.parse(config)));
}
