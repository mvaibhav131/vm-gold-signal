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

/** A win rate is always shown with its interval, or not at all (rule C6). */
function checkRateWithInterval(
  ctx: z.core.ParsePayload<{ winRate: number | null; ci95: [number, number] | null }>,
) {
  const { winRate, ci95 } = ctx.value;
  if ((winRate === null) !== (ci95 === null)) {
    addIssue(ctx, 'winRate and ci95 are both present or both null', ['ci95']);
  } else if (winRate !== null && ci95 !== null && (winRate < ci95[0] || winRate > ci95[1])) {
    addIssue(ctx, 'winRate must lie inside ci95', ['winRate']);
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
    checkResultCounts(ctx);
    checkRateWithInterval(ctx);
    if (ctx.value.resolvedValid === 0 && ctx.value.winRate !== null) {
      addIssue(ctx, 'no win rate without resolved signals', ['winRate']);
    }
  });

/** month is the first day of the month in UTC, as YYYY-MM. */
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM');

export const monthlyQuerySchema = z.strictObject({
  months: z.coerce.number().pipe(z.int().min(1).max(120)).default(12),
  strategy: strategyKeySchema.optional(),
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
    winRate: nullableRate,
    ci95: ci95Schema.nullable(),
    expectancyR: nullableR,
    profitFactor: nullableFactor,
    lowSample: z.boolean(),
  })
  .check((ctx) => {
    checkRateWithInterval(ctx);
  });

export const failuresQuerySchema = z.strictObject({ ...rangeShape }).check((ctx) => {
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
    checkRateWithInterval(ctx);
    if (ctx.value.wins > ctx.value.n) addIssue(ctx, 'wins cannot exceed n', ['wins']);
  });

export const calibrationRowSchema = z
  .strictObject({
    bandFrom: z.int().min(0).max(100),
    bandTo: z.int().min(0).max(100),
    n: countSchema,
    winRate: nullableRate,
    ci95: ci95Schema.nullable(),
  })
  .check((ctx) => {
    checkRateWithInterval(ctx);
    if (ctx.value.bandFrom > ctx.value.bandTo)
      addIssue(ctx, 'bandFrom must be <= bandTo', ['bandFrom']);
  });

export const equityQuerySchema = z.strictObject({ ...rangeShape }).check((ctx) => {
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
export const driftRowSchema = z.strictObject({
  strategy: strategyKeySchema,
  window: z.int().positive(),
  n: countSchema,
  rollingWinRate: nullableRate,
  evidenceCi95: ci95Schema.nullable(),
  status: z.enum(DRIFT_STATUSES),
});

export const newsImpactRowSchema = z
  .strictObject({
    topic: newsTopicSchema,
    impact: newsImpactSchema,
    n: countSchema,
    /** Share of headlines after which gold moved 1 ATR or more within 10 minutes. */
    movedShare: nullableRate,
    movedCi95: ci95Schema.nullable(),
    avgAbsMoveAtr: z.number().nonnegative().nullable(),
    baselineShare: nullableRate,
    lift: z.number().nullable(),
    lowSample: z.boolean(),
  })
  .check((ctx) => {
    if ((ctx.value.movedShare === null) !== (ctx.value.movedCi95 === null)) {
      addIssue(ctx, 'movedShare and movedCi95 are both present or both null', ['movedCi95']);
    }
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
