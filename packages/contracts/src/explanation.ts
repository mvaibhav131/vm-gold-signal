import { sampleLabel } from '@vmgs/core';
import { z } from 'zod';

import {
  advisoryFlagSchema,
  gradeSchema,
  groupStateSchema,
  newsFeedStateSchema,
  newsStateSchema,
  qualityGroupSchema,
  sampleLabelSchema,
  statsScopeSchema,
} from './enums';
import { frozenHeadlineSchema } from './news';
import {
  addIssue,
  ci95Schema,
  countSchema,
  fractionSchema,
  priceSchema,
  r2Schema,
  scoreSchema,
  timestampSchema,
} from './primitives';

/**
 * Historical evidence for a setup type (02_Signal_Engine section 13). Below 30 resolved trades
 * no win rate is carried at all, only the counts, so a number without a sample cannot be shown.
 */
export const evidenceSchema = z
  .strictObject({
    scope: statsScopeSchema,
    /** 0 is the exact bucket, 4 is strategy and side only. */
    level: z.int().min(0).max(4),
    n: countSchema,
    wins: countSchema,
    sampleLabel: sampleLabelSchema,
    winRate: fractionSchema.nullable(),
    ci: ci95Schema.nullable(),
    expectancyR: z.number().nullable(),
    profitFactor: z.number().nonnegative().nullable(),
    tp1Rate: fractionSchema.nullable(),
    tp2Rate: fractionSchema.nullable(),
  })
  .check((ctx) => {
    const { n, wins, winRate, ci, expectancyR } = ctx.value;
    if (wins > n) addIssue(ctx, 'wins cannot exceed n', ['wins']);
    if (ctx.value.sampleLabel !== sampleLabel(n)) {
      addIssue(ctx, `sampleLabel must be ${sampleLabel(n)} for n=${String(n)}`, ['sampleLabel']);
    }
    if (ctx.value.sampleLabel === 'INSUFFICIENT') {
      if (winRate !== null) addIssue(ctx, 'no win rate below the minimum sample', ['winRate']);
      if (ci !== null) addIssue(ctx, 'no interval below the minimum sample', ['ci']);
      return;
    }
    if (winRate === null || ci === null) {
      addIssue(ctx, 'a shown win rate needs its interval', ['winRate']);
      return;
    }
    if (expectancyR === null) addIssue(ctx, 'expectancyR is required', ['expectancyR']);
    if (winRate < ci[0] || winRate > ci[1]) {
      addIssue(ctx, 'win rate must lie inside its interval', ['winRate']);
    }
  });
export type Evidence = z.infer<typeof evidenceSchema>;

export const factSchema = z.strictObject({
  label: z.string().min(1),
  value: z.union([z.string(), z.number()]),
});

export const explanationGroupSchema = z.strictObject({
  key: qualityGroupSchema,
  state: groupStateSchema,
  facts: z.array(factSchema),
});

export const explanationSchema = z.strictObject({
  headline: z.string().min(1),
  quality: z.strictObject({ score: scoreSchema, grade: gradeSchema }),
  levels: z.strictObject({
    entry: priceSchema,
    maxValidEntry: priceSchema,
    stop: priceSchema,
    tp1: priceSchema,
    tp2: priceSchema.nullable(),
    riskUsd: priceSchema,
  }),
  groups: z.array(explanationGroupSchema),
  weak: z.array(z.string().min(1)),
  researchOnly: z.array(factSchema),
  macro: z.strictObject({
    state: newsStateSchema,
    next: z.strictObject({ name: z.string().min(1), at: timestampSchema }).nullable(),
  }),
  // Up to 3 headlines of the last 60 minutes, frozen at signal time (02_Signal_Engine section 16).
  news: z
    .strictObject({
      feed: newsFeedStateSchema,
      headlines: z.array(frozenHeadlineSchema).max(3),
    })
    .check((ctx) => {
      if (ctx.value.feed === 'UNAVAILABLE' && ctx.value.headlines.length > 0) {
        addIssue(ctx, 'an unavailable headline feed has no headlines', ['headlines']);
      }
    }),
  warnings: z.array(z.strictObject({ code: advisoryFlagSchema, text: z.string().min(1) })),
  open: z.strictObject({ count: countSchema, riskR: r2Schema.pipe(z.number().nonnegative()) }),
  evidence: evidenceSchema,
});
export type Explanation = z.infer<typeof explanationSchema>;
