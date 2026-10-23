import {
  EVIDENCE_MIN_SAMPLE,
  EVIDENCE_NORMAL_SAMPLE,
  GRADE_THRESHOLDS,
  QUALITY_GROUPS,
  TIMEFRAME_MS,
  type QualityGroup,
  type StrategyKey,
} from '@vmgs/core';
import {
  exitProfileSchema,
  gateModeSchema,
  macroImportanceSchema,
  regimeSchema,
  semverSchema,
  timeframeSchema,
} from '@vmgs/contracts';
import { z } from 'zod';

import { canonicalJson, sha256Hex } from './canonical';

// Config of a strategy version, `v0.1.0` (02_Signal_Engine section 17 gives the excerpt this follows,
// key for key). The numbers are hypotheses: they may be tuned only on the training and validation
// splits, and every change creates a new immutable strategy version.
// This phase holds the decisions of a strategy: timeframes, gates, quality weights, policy, advisory
// defaults, risk and exit, and the rules of strategies A to E. The numeric definitions of indicators
// and primitives (swing pivots, displacement, trendline tolerances, ...) are added with the phase that
// implements them, as new sections with their own defaults.

const positive = z.number().positive();
const atrMultiple = z.number().positive().max(20);
const fraction = z.number().gt(0).max(1);
const candleCount = z.int().positive().max(1000);
const minutes = z.int().nonnegative().max(1440);

const timeframesSchema = z
  .strictObject({ entry: timeframeSchema, context: timeframeSchema, bias: timeframeSchema })
  .refine(
    (t) =>
      TIMEFRAME_MS[t.entry] < TIMEFRAME_MS[t.context] &&
      TIMEFRAME_MS[t.context] < TIMEFRAME_MS[t.bias],
    'timeframes must grow from entry to context to bias',
  );

/** Blocking gates (section 6) and the news window of the NEWS_WINDOW flag. */
export const gatesConfigSchema = z.strictObject({
  maxTickAgeSec: positive,
  maxClockSkewSec: positive,
  maxSpreadUsd: positive,
  /** Largest spread as a share of the stop distance. */
  maxSpreadToStop: fraction,
  gapRecoveryCandles: candleCount,
  /** Allowed stop distance as [min, max] multiples of ATR(5m). */
  stopAtr: z
    .tuple([atrMultiple, atrMultiple])
    .refine(([min, max]) => min < max, 'stopAtr must be [min, max] with min below max'),
  tp1MaxAtr: atrMultiple,
  newsWindow: z.strictObject({
    before: minutes,
    after: minutes,
    impact: z.array(macroImportanceSchema).min(1),
    currency: z.array(z.string().regex(/^[A-Z]{3}$/, 'ISO currency code')).min(1),
  }),
});
export type GatesConfig = z.infer<typeof gatesConfigSchema>;

const groupWeights = Object.fromEntries(QUALITY_GROUPS.map((group) => [group, fraction])) as Record<
  QualityGroup,
  typeof fraction
>;

/** Quality score (section 8): the threshold, the data coverage needed and the group weights (sum 1). */
export const qualityConfigSchema = z.strictObject({
  // Grades start at 65, so a lower threshold would let through a setup that has no grade.
  min: z.number().min(GRADE_THRESHOLDS.moderate).max(100),
  minCoverage: fraction,
  weights: z
    .strictObject(groupWeights)
    .refine(
      (weights) => Math.abs(Object.values(weights).reduce((sum, w) => sum + w, 0) - 1) < 1e-9,
      'weights must add up to 1',
    ),
});
export type QualityConfig = z.infer<typeof qualityConfigSchema>;

/** Rule C10 as data: signals are never throttled, and a setup produces at most one signal. */
export const policyConfigSchema = z.strictObject({
  throttles: z.literal('none'),
  dedupe: z.literal('per_setup_instance'),
});

/** Default owner mode of each advisory flag. By default every flag only warns. */
export const advisoryConfigSchema = z.strictObject({
  newsWindow: gateModeSchema,
  rollover: gateModeSchema,
  offHours: gateModeSchema,
  nearLevel: gateModeSchema,
});

/** Entry, fill and exit model (section 9). The live engine only chooses among fixed exit profiles. */
export const riskConfigSchema = z.strictObject({
  exitProfile: exitProfileSchema,
  simSlippageUsd: z.number().nonnegative(),
  commissionUsdPerOz: z.number().nonnegative(),
  entryValidSec: z.int().positive(),
  /** maxValidEntry = entry + min(maxChaseAtr x ATR(5m), maxChaseRiskFraction x risk distance). */
  maxChaseAtr: atrMultiple,
  maxChaseRiskFraction: fraction,
  timeStopMin: z.int().positive(),
});
export type RiskConfig = z.infer<typeof riskConfigSchema>;

/** Rule C6: no win rate below 30 resolved trades, a "low sample" label below 100. Fixed, kept for the record. */
export const statsConfigSchema = z.strictObject({
  minN: z.literal(EVIDENCE_MIN_SAMPLE),
  lowSampleBelow: z.literal(EVIDENCE_NORMAL_SAMPLE),
});

const acceptedRegimes = z
  .array(regimeSchema)
  .min(1)
  .refine((regimes) => new Set(regimes).size === regimes.length, 'duplicate regime');

const stopBufferAtr = atrMultiple;

const commonShape = {
  version: semverSchema,
  acceptedRegimes,
  timeframes: timeframesSchema,
  gates: gatesConfigSchema,
  quality: qualityConfigSchema,
  policy: policyConfigSchema,
  advisory: advisoryConfigSchema,
  risk: riskConfigSchema,
  stats: statsConfigSchema,
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

function defaultCommon(exitProfile: RiskConfig['exitProfile']) {
  return {
    version: STRATEGY_CONFIG_VERSION,
    timeframes: { entry: '5m', context: '15m', bias: '1h' },
    gates: {
      maxTickAgeSec: 10,
      maxClockSkewSec: 5,
      maxSpreadUsd: 0.6,
      maxSpreadToStop: 0.12,
      gapRecoveryCandles: 12,
      stopAtr: [0.8, 2.0],
      tp1MaxAtr: 2.5,
      newsWindow: { before: 45, after: 20, impact: ['high'], currency: ['USD'] },
    },
    quality: {
      min: 65,
      minCoverage: 0.7,
      weights: {
        trend: 0.22,
        structure: 0.22,
        trigger: 0.14,
        volatility: 0.1,
        execution: 0.12,
        sessionMacro: 0.12,
        reward: 0.08,
      },
    },
    policy: { throttles: 'none', dedupe: 'per_setup_instance' },
    advisory: { newsWindow: 'warn', rollover: 'warn', offHours: 'warn', nearLevel: 'warn' },
    risk: {
      exitProfile,
      simSlippageUsd: 0.05,
      commissionUsdPerOz: 0,
      entryValidSec: 180,
      maxChaseAtr: 0.15,
      maxChaseRiskFraction: 0.25,
      timeStopMin: 120,
    },
    stats: { minN: EVIDENCE_MIN_SAMPLE, lowSampleBelow: EVIDENCE_NORMAL_SAMPLE },
  };
}

/**
 * A fresh copy of the v0.1.0 config of a strategy (the starting point of the research phases).
 * It is parsed on every call, so a default can never drift out of the schema unnoticed.
 */
export function defaultStrategyConfig(key: StrategyKey): StrategyConfig {
  switch (key) {
    case 'trend_pullback':
      return strategyConfigSchema.parse({
        strategyKey: key,
        ...defaultCommon('EP1_PARTIAL'),
        acceptedRegimes: ['TREND_UP', 'TREND_DOWN'],
        params: {
          emaSlopeHours: 6,
          rsiPullbackMax: 45,
          rsiLookbackCandles: 12,
          rsiRiseLookbackCandles: 3,
          macdRisingCandles: 2,
          stopBufferAtr: 0.25,
        },
      });
    case 'sweep_reversal':
      return strategyConfigSchema.parse({
        strategyKey: key,
        ...defaultCommon('EP1_PARTIAL'),
        acceptedRegimes: ['RANGE', 'TREND_UP', 'TREND_DOWN', 'BREAKOUT'],
        params: { triggerWithinCandles: 6, requireChochInTrend: true, stopBufferAtr: 0.2 },
      });
    case 'squeeze_retest':
      return strategyConfigSchema.parse({
        strategyKey: key,
        ...defaultCommon('EP1_PARTIAL'),
        acceptedRegimes: ['SQUEEZE', 'BREAKOUT'],
        params: {
          squeezeMinCandles15m: 8,
          donchianPeriod: 20,
          breakoutMinAtr: 0.1,
          retestWithinCandles: 8,
          retestMaxDistanceAtr: 0.25,
          stopBufferAtr: 0.2,
        },
      });
    case 'trendline_retest':
      return strategyConfigSchema.parse({
        strategyKey: key,
        ...defaultCommon('EP1_PARTIAL'),
        acceptedRegimes: ['TREND_UP', 'TREND_DOWN', 'RANGE', 'BREAKOUT'],
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
      });
    case 'pattern_breakout':
      return strategyConfigSchema.parse({
        strategyKey: key,
        ...defaultCommon('EP3_STRUCTURE'),
        // Any regime except HIGH_VOL.
        acceptedRegimes: ['TREND_UP', 'TREND_DOWN', 'RANGE', 'SQUEEZE', 'BREAKOUT', 'UNCERTAIN'],
        params: { retestWithinCandles: 8, stopBufferAtr: 0.25, minMeasuredMoveR: 1.5 },
      });
  }
}

/** The hash stored in strategy_versions.config_hash: SHA-256 of the canonical JSON of the validated config. */
export function strategyConfigHash(config: unknown): string {
  return sha256Hex(canonicalJson(strategyConfigSchema.parse(config)));
}
