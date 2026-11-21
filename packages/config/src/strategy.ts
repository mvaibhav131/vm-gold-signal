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
  /** The owner places the order this long after the signal (seconds); 0 is the confirming tick. */
  execDelaySec: z.number().nonnegative(),
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

// Strategy F: it decides once an hour from the 1h trend and has no rule of its own beyond the averages and the stop.
const hourlyTrendSchema = z.strictObject({
  strategyKey: z.literal('hourly_trend'),
  ...commonShape,
  params: z
    .strictObject({
      emaFast: candleCount,
      emaMid: candleCount,
      emaSlow: candleCount,
      atrPeriod: candleCount,
      // The stop, in ATR(1h) from the price.
      stopAtr1h: atrMultiple,
      // How often it decides, in minutes (a multiple of 5 that divides an hour).
      everyMin: z.int().min(5).max(60),
    })
    .refine(
      (p) => p.emaFast < p.emaMid && p.emaMid < p.emaSlow,
      'the averages must grow from fast to middle to slow',
    )
    .refine((p) => p.everyMin % 5 === 0 && 60 % p.everyMin === 0, 'everyMin must divide an hour'),
});

// Strategy G: nine votes on the close of a 5m candle, a stop beyond the swing and as far as the first target. It speaks in the session only.
const confluenceSchema = z.strictObject({
  strategyKey: z.literal('confluence'),
  ...commonShape,
  params: z
    .strictObject({
      emaFast: candleCount,
      emaMid: candleCount,
      emaSlow: candleCount,
      rsiPeriod: candleCount,
      atrPeriod: candleCount,
      adxPeriod: candleCount,
      // How many of the nine votes must agree.
      minVotes: z.int().min(1).max(9),
      minBodyAtr: atrMultiple,
      // ATR(5m) over its average of the last day, at least.
      atrFloor: z.number().min(0).max(5),
      swingCandles: candleCount,
      stopBufferAtr,
      minStopAtr: atrMultiple,
      maxStopAtr: atrMultiple,
      maxStopUsd: positive,
      // At most one setup for each side in a slot of this many minutes.
      slotMin: z.int().min(5).max(1440),
      // The session in which it speaks, in minutes of the UTC day.
      sessionFromMin: minutes,
      sessionToMin: minutes,
    })
    .refine(
      (p) => p.emaFast < p.emaMid && p.emaMid < p.emaSlow,
      'the averages must grow from fast to middle to slow',
    )
    .refine((p) => p.minStopAtr < p.maxStopAtr, 'minStopAtr must be below maxStopAtr')
    .refine(
      (p) => p.slotMin % 5 === 0 && 1440 % p.slotMin === 0,
      'slotMin must be a multiple of 5 that divides a day',
    )
    .refine((p) => p.sessionFromMin < p.sessionToMin, 'the session must end after it starts'),
});

/** The immutable config of one strategy version, stored as strategy_versions.config. */
export const strategyConfigSchema = z.discriminatedUnion('strategyKey', [
  trendPullbackSchema,
  sweepReversalSchema,
  squeezeRetestSchema,
  trendlineRetestSchema,
  patternBreakoutSchema,
  hourlyTrendSchema,
  confluenceSchema,
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
      execDelaySec: 0,
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
    case 'hourly_trend': {
      const common = defaultCommon('EP1_PARTIAL');
      return strategyConfigSchema.parse({
        strategyKey: key,
        ...common,
        // A trend in any regime: the strategy reads the 1h chart, not the 5m regime.
        acceptedRegimes: [
          'TREND_UP',
          'TREND_DOWN',
          'RANGE',
          'SQUEEZE',
          'BREAKOUT',
          'HIGH_VOL',
          'UNCERTAIN',
        ],
        // The stop is in ATR(1h), so in ATR(5m) it is about three and a half times wider than for the 5m strategies.
        gates: { ...common.gates, stopAtr: [3, 16], tp1MaxAtr: 20 },
        // The stop and the target are scored in ATR(5m) bands made for the 5m strategies, and there is no pullback or trigger candle:
        // so the quality of an hourly setup rests on the trend, the session and news, and the volatility.
        quality: {
          ...common.quality,
          weights: {
            trend: 0.5,
            structure: 0.05,
            trigger: 0.02,
            volatility: 0.12,
            execution: 0.01,
            sessionMacro: 0.29,
            reward: 0.01,
          },
        },
        // The decision is every half hour: the entry stays valid a little longer, and a trade runs four hours at most.
        risk: { ...common.risk, entryValidSec: 300, maxChaseAtr: 0.3, timeStopMin: 240 },
        params: {
          emaFast: 20,
          emaMid: 50,
          emaSlow: 200,
          atrPeriod: 14,
          stopAtr1h: 2.5,
          everyMin: 30,
        },
      });
    }
    case 'confluence': {
      const common = defaultCommon('EP1_PARTIAL');
      return strategyConfigSchema.parse({
        strategyKey: key,
        ...common,
        // The nine votes include the trend and the ADX, so the regime of the engine is not a second filter.
        acceptedRegimes: [
          'TREND_UP',
          'TREND_DOWN',
          'RANGE',
          'SQUEEZE',
          'BREAKOUT',
          'HIGH_VOL',
          'UNCERTAIN',
        ],
        // The stop is 3 to 4.2 ATR(5m) and the first target as far as the stop (1R): wider than the 5m strategies', far inside the hourly one.
        gates: { ...common.gates, stopAtr: [2.5, 5], tp1MaxAtr: 5 },
        // The bands of the execution and reward groups are made for stops of 0.8 to 2 ATR, so they would fail a 3 to 4 ATR stop for a
        // reason that is not a weakness: the quality of a setup rests on the trend, the trigger, the volatility and the session.
        quality: {
          ...common.quality,
          weights: {
            trend: 0.3,
            structure: 0.1,
            trigger: 0.2,
            volatility: 0.15,
            execution: 0.02,
            sessionMacro: 0.21,
            reward: 0.02,
          },
        },
        // The first target is 10 to 16 USD away: it takes up to two hours.
        risk: { ...common.risk, timeStopMin: 120 },
        params: {
          emaFast: 20,
          emaMid: 50,
          emaSlow: 200,
          rsiPeriod: 14,
          atrPeriod: 14,
          adxPeriod: 14,
          minVotes: 7,
          minBodyAtr: 0.4,
          atrFloor: 0.8,
          swingCandles: 10,
          stopBufferAtr: 0.5,
          minStopAtr: 3,
          maxStopAtr: 4.2,
          maxStopUsd: 16,
          slotMin: 30,
          sessionFromMin: 420,
          sessionToMin: 1230,
        },
      });
    }
  }
}

/** The hash stored in strategy_versions.config_hash: SHA-256 of the canonical JSON of the validated config. */
export function strategyConfigHash(config: unknown): string {
  return sha256Hex(canonicalJson(strategyConfigSchema.parse(config)));
}
