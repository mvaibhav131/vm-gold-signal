import { EVIDENCE_MIN_SAMPLE, sampleLabel } from '@vmgs/core';
import { z } from 'zod';

import {
  causeCategorySchema,
  causeCodeSchema,
  groupStateSchema,
  newsImpactSchema,
  newsTopicSchema,
  qualityGroupSchema,
  statsScopeSchema,
  strategyKeySchema,
} from '../enums';
import {
  addIssue,
  ci95Schema,
  countSchema,
  fractionSchema,
  r2Schema,
  timestampSchema,
} from '../primitives';
import { checkRange, listSchema, rangeShape } from './common';

const nullableRate = fractionSchema.nullable();
const nullableR = z.number().nullable();
const nullableFactor = z.number().nonnegative().nullable();

/**
 * Rule C6 (05_UI_Spec section 6.2, scenario E10): a percentage is shown only when n >= 30.
 * Below that the API sends the counts and the percentages are null; from 30 on they are present.
 */
function checkPercentagesShown(
  ctx: z.core.ParsePayload,
  n: number,
  percentages: Record<string, unknown>,
) {
  const hidden = n < EVIDENCE_MIN_SAMPLE;
  for (const [name, value] of Object.entries(percentages)) {
    if (hidden && value !== null) {
      addIssue(ctx, `${name} must be null below ${String(EVIDENCE_MIN_SAMPLE)} trades`, [name]);
    }
    if (!hidden && value === null) {
      addIssue(ctx, `${name} is required from ${String(EVIDENCE_MIN_SAMPLE)} trades`, [name]);
    }
  }
}

/** A shown win rate lies inside its own interval. */
function checkRateInsideInterval(
  ctx: z.core.ParsePayload,
  rate: number | null,
  ci: [number, number] | null,
  path: string,
) {
  if (rate !== null && ci !== null && (rate < ci[0] || rate > ci[1])) {
    addIssue(ctx, `${path} must lie inside its interval`, [path]);
  }
}

/** The low-sample marker is true below 100 trades. */
function checkLowSampleFlag(ctx: z.core.ParsePayload, n: number, lowSample: boolean) {
  if (lowSample !== (sampleLabel(n) !== 'NORMAL')) {
    addIssue(ctx, 'lowSample must be true exactly below 100 trades', ['lowSample']);
  }
}

const resultCountsShape = {
  generated: countSchema,
  resolvedValid: countSchema,
  wins: countSchema,
  partials: countSchema,
  losses: countSchema,
  timeExits: countSchema,
  cancelled: countSchema,
  dataInvalid: countSchema,
};

/** "Properly tracked" means resolvedValid: cancelled and data-invalid signals are always counted apart. */
function checkResultCounts(
  ctx: z.core.ParsePayload<{
    resolvedValid: number;
    wins: number;
    partials: number;
    losses: number;
    timeExits: number;
  }>,
) {
  const v = ctx.value;
  if (v.resolvedValid !== v.wins + v.partials + v.losses + v.timeExits) {
    addIssue(ctx, 'resolvedValid must equal wins + partials + losses + timeExits', [
      'resolvedValid',
    ]);
  }
}

export const overviewQuerySchema = z
  .strictObject({
    ...rangeShape,
    strategy: strategyKeySchema.optional(),
    scope: statsScopeSchema.default('FORWARD'),
  })
  .check((ctx) => {
    checkRange(ctx);
  });

export const overviewResponseSchema = z
  .strictObject({
    ...resultCountsShape,
    winRate: nullableRate,
    ci95: ci95Schema.nullable(),
    netR: r2Schema,
    expectancyR: nullableR,
    profitFactor: nullableFactor,
    maxDrawdownR: r2Schema.pipe(z.number().nonnegative()),
    avgDurationS: z.number().nonnegative().nullable(),
    tp1Rate: nullableRate,
    tp2Rate: nullableRate,
    currentStreak: z
      .strictObject({ type: z.enum(['WIN', 'LOSS']), length: z.int().positive() })
      .nullable(),
  })
  .check((ctx) => {
    const v = ctx.value;
    checkResultCounts(ctx);
    checkPercentagesShown(ctx, v.resolvedValid, {
      winRate: v.winRate,
      ci95: v.ci95,
      tp1Rate: v.tp1Rate,
      tp2Rate: v.tp2Rate,
    });
    checkRateInsideInterval(ctx, v.winRate, v.ci95, 'winRate');
  });
export type OverviewResponse = z.infer<typeof overviewResponseSchema>;
export type OverviewQuery = z.input<typeof overviewQuerySchema>;
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM');

export const monthlyQuerySchema = z.strictObject({
  months: z.coerce.number().pipe(z.int().min(1).max(120)).default(12),
  strategy: strategyKeySchema.optional(),
  scope: statsScopeSchema.default('FORWARD'),
});

export const monthlyRowSchema = z
  .strictObject({
    month: monthSchema,
    ...resultCountsShape,
    winRate: nullableRate,
    netR: r2Schema,
    profitFactor: nullableFactor,
  })
  .check((ctx) => {
    checkResultCounts(ctx);
    checkPercentagesShown(ctx, ctx.value.resolvedValid, { winRate: ctx.value.winRate });
  });

export const BREAKDOWN_DIMENSIONS = [
  'strategy',
  'side',
  'session',
  'regime',
  'volatility',
  'news',
  'grade',
] as const;

export const breakdownQuerySchema = z.strictObject({
  by: z.enum(BREAKDOWN_DIMENSIONS),
  ...rangeShape,
  strategy: strategyKeySchema.optional(),
  scope: statsScopeSchema.default('FORWARD'),
});

export const breakdownRowSchema = z
  .strictObject({
    key: z.string().min(1),
    n: countSchema,
    wins: countSchema,
    winRate: nullableRate,
    ci95: ci95Schema.nullable(),
    expectancyR: nullableR,
    profitFactor: nullableFactor,
    lowSample: z.boolean(),
  })
  .check((ctx) => {
    const v = ctx.value;
    if (v.wins > v.n) addIssue(ctx, 'wins cannot exceed n', ['wins']);
    checkPercentagesShown(ctx, v.n, { winRate: v.winRate, ci95: v.ci95 });
    checkRateInsideInterval(ctx, v.winRate, v.ci95, 'winRate');
    checkLowSampleFlag(ctx, v.n, v.lowSample);
  });

export const failuresQuerySchema = z
  .strictObject({ ...rangeShape, scope: statsScopeSchema.default('FORWARD') })
  .check((ctx) => {
    checkRange(ctx);
  });

export const failuresResponseSchema = z.strictObject({
  causes: z.array(
    z.strictObject({
      code: causeCodeSchema,
      category: causeCategorySchema,
      n: countSchema,
      share: fractionSchema,
      sumR: r2Schema,
    }),
  ),
  weakGroups: z.array(
    z.strictObject({ group: qualityGroupSchema, n: countSchema, share: fractionSchema }),
  ),
});

export const groupEffectivenessQuerySchema = z.strictObject({
  strategy: strategyKeySchema.optional(),
  scope: statsScopeSchema.default('FORWARD'),
});

export const groupEffectivenessRowSchema = z
  .strictObject({
    strategy: strategyKeySchema,
    group: qualityGroupSchema,
    state: groupStateSchema,
    n: countSchema,
    wins: countSchema,
    winRate: nullableRate,
    ci95: ci95Schema.nullable(),
    expectancyR: nullableR,
  })
  .check((ctx) => {
    const v = ctx.value;
    if (v.wins > v.n) addIssue(ctx, 'wins cannot exceed n', ['wins']);
    checkPercentagesShown(ctx, v.n, { winRate: v.winRate, ci95: v.ci95 });
    checkRateInsideInterval(ctx, v.winRate, v.ci95, 'winRate');
  });

export const calibrationQuerySchema = z.strictObject({
  scope: statsScopeSchema.default('FORWARD'),
});

export const calibrationRowSchema = z
  .strictObject({
    bandFrom: z.int().min(0).max(100),
    bandTo: z.int().min(0).max(100),
    n: countSchema,
    wins: countSchema,
    winRate: nullableRate,
    ci95: ci95Schema.nullable(),
  })
  .check((ctx) => {
    const v = ctx.value;
    if (v.bandFrom > v.bandTo) addIssue(ctx, 'bandFrom must be <= bandTo', ['bandFrom']);
    if (v.wins > v.n) addIssue(ctx, 'wins cannot exceed n', ['wins']);
    checkPercentagesShown(ctx, v.n, { winRate: v.winRate, ci95: v.ci95 });
    checkRateInsideInterval(ctx, v.winRate, v.ci95, 'winRate');
  });

export const equityQuerySchema = z
  .strictObject({ ...rangeShape, scope: statsScopeSchema.default('FORWARD') })
  .check((ctx) => {
    checkRange(ctx);
  });

export const equityPointSchema = z.strictObject({ t: timestampSchema, netR: r2Schema });

export const DRIFT_STATUSES = [
  'INSUFFICIENT_DATA',
  'WITHIN_RANGE',
  'BELOW_RANGE',
  'ABOVE_RANGE',
] as const;

/** Rolling win rate of the last trades against the strategy's own evidence interval. */
export const driftRowSchema = z
  .strictObject({
    strategy: strategyKeySchema,
    window: z.int().positive(),
    n: countSchema,
    rollingWinRate: nullableRate,
    evidenceCi95: ci95Schema.nullable(),
    status: z.enum(DRIFT_STATUSES),
  })
  .check((ctx) => {
    const v = ctx.value;
    if (v.n > v.window) addIssue(ctx, 'n cannot exceed the window', ['n']);
    checkPercentagesShown(ctx, v.n, { rollingWinRate: v.rollingWinRate });
    if ((v.status === 'INSUFFICIENT_DATA') !== v.n < EVIDENCE_MIN_SAMPLE) {
      addIssue(
        ctx,
        `INSUFFICIENT_DATA applies exactly below ${String(EVIDENCE_MIN_SAMPLE)} trades`,
        ['status'],
      );
    }
  });

export const newsImpactRowSchema = z
  .strictObject({
    topic: newsTopicSchema,
    impact: newsImpactSchema,
    n: countSchema,
    /** Headlines after which gold moved 1 ATR or more within 10 minutes. */
    moved: countSchema,
    /** Share of those headlines; null below 30 samples ("not enough data yet"). */
    movedShare: nullableRate,
    movedCi95: ci95Schema.nullable(),
    avgAbsMoveAtr: z.number().nonnegative().nullable(),
    baselineShare: nullableRate,
    lift: z.number().nullable(),
    lowSample: z.boolean(),
  })
  .check((ctx) => {
    const v = ctx.value;
    if (v.moved > v.n) addIssue(ctx, 'moved cannot exceed n', ['moved']);
    checkPercentagesShown(ctx, v.n, { movedShare: v.movedShare, movedCi95: v.movedCi95 });
    checkRateInsideInterval(ctx, v.movedShare, v.movedCi95, 'movedShare');
    checkLowSampleFlag(ctx, v.n, v.lowSample);
  });

export const monthlyResponseSchema = listSchema(monthlyRowSchema);
export const breakdownResponseSchema = z.strictObject({
  by: z.enum(BREAKDOWN_DIMENSIONS),
  items: z.array(breakdownRowSchema),
});
export const groupEffectivenessResponseSchema = listSchema(groupEffectivenessRowSchema);
export const calibrationResponseSchema = listSchema(calibrationRowSchema);
export const equityResponseSchema = listSchema(equityPointSchema);
export const driftResponseSchema = listSchema(driftRowSchema);
export const newsImpactResponseSchema = listSchema(newsImpactRowSchema);

export type MonthlyQuery = z.input<typeof monthlyQuerySchema>;
export type MonthlyRow = z.infer<typeof monthlyRowSchema>;
export type MonthlyResponse = z.infer<typeof monthlyResponseSchema>;
export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];
export type BreakdownQuery = z.input<typeof breakdownQuerySchema>;
export type BreakdownRow = z.infer<typeof breakdownRowSchema>;
export type BreakdownResponse = z.infer<typeof breakdownResponseSchema>;
export type FailuresQuery = z.input<typeof failuresQuerySchema>;
export type FailuresResponse = z.infer<typeof failuresResponseSchema>;
export type GroupEffectivenessQuery = z.input<typeof groupEffectivenessQuerySchema>;
export type GroupEffectivenessRow = z.infer<typeof groupEffectivenessRowSchema>;
export type GroupEffectivenessResponse = z.infer<typeof groupEffectivenessResponseSchema>;
export type CalibrationQuery = z.input<typeof calibrationQuerySchema>;
export type CalibrationRow = z.infer<typeof calibrationRowSchema>;
export type CalibrationResponse = z.infer<typeof calibrationResponseSchema>;
export type EquityQuery = z.input<typeof equityQuerySchema>;
export type EquityPoint = z.infer<typeof equityPointSchema>;
export type EquityResponse = z.infer<typeof equityResponseSchema>;
export type DriftStatus = (typeof DRIFT_STATUSES)[number];
export type DriftRow = z.infer<typeof driftRowSchema>;
export type DriftResponse = z.infer<typeof driftResponseSchema>;
export type NewsImpactRow = z.infer<typeof newsImpactRowSchema>;
export type NewsImpactResponse = z.infer<typeof newsImpactResponseSchema>;
