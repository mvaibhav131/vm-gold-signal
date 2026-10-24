import { z } from 'zod';

import {
  autopsyStatusSchema,
  causeCodeSchema,
  exitProfileSchema,
  gradeSchema,
  newsStateSchema,
  advisoryFlagSchema,
  regimeSchema,
  resultSchema,
  sessionSchema,
  sideSchema,
  signalModeSchema,
  signalStatusSchema,
  strategyKeySchema,
  strategyStatusSchema,
  volBucketSchema,
} from '../enums';
import {
  addIssue,
  countSchema,
  fractionSchema,
  jsonRecordSchema,
  priceSchema,
  r2Schema,
  r3Schema,
  scoreSchema,
  semverSchema,
  timestampSchema,
  uuidSchema,
} from '../primitives';
import {
  autopsySchema,
  outcomeSchema,
  signalEventSchema,
  signalSchema,
  signalStateSchema,
} from '../signal';
import { checkRange, pageQueryShape, pageSchema, rangeShape } from './common';
import { overviewResponseSchema } from './analytics';

export const openSignalLiveSchema = z.strictObject({
  status: z.enum(['ACTIVE', 'TP1_HIT']),
  currentPrice: priceSchema,
  unrealisedR: r2Schema,
  mfeR: r2Schema.pipe(z.number().nonnegative()),
  maeR: r2Schema.pipe(z.number().nonpositive()),
  stopLossCurrent: priceSchema,
  timeToTimeStopS: countSchema,
});

export const openSignalSchema = z.strictObject({
  signal: signalSchema,
  live: openSignalLiveSchema,
});
export type OpenSignal = z.infer<typeof openSignalSchema>;

/** GET /signals/open. There can be several open signals at once. */
export const openSignalsResponseSchema = z
  .strictObject({
    items: z.array(openSignalSchema),
    openCount: countSchema,
    openRiskR: r2Schema.pipe(z.number().nonnegative()),
  })
  .check((ctx) => {
    if (ctx.value.openCount !== ctx.value.items.length) {
      addIssue(ctx, 'openCount must equal the number of items', ['openCount']);
    }
  });
export type OpenSignalsResponse = z.infer<typeof openSignalsResponseSchema>;

/** One row of signal_history_v. Outcome columns are null while the signal is still open. */
export const signalHistoryRowSchema = z.strictObject({
  signalId: uuidSchema,
  seq: z.int().positive(),
  generatedAt: timestampSchema,
  side: sideSchema,
  mode: signalModeSchema,
  strategyKey: strategyKeySchema,
  strategyVersion: semverSchema,
  strategyStatus: strategyStatusSchema,
  exitProfile: exitProfileSchema,
  entry: priceSchema,
  stopLoss: priceSchema,
  tp1: priceSchema,
  tp2: priceSchema.nullable(),
  riskDistance: priceSchema,
  regime: regimeSchema,
  session: sessionSchema,
  volBucket: volBucketSchema,
  newsState: newsStateSchema,
  qualityScore: scoreSchema,
  openSignalsAtEntry: countSchema,
  warnings: z.array(advisoryFlagSchema),
  evidenceWinRate: fractionSchema.nullable(),
  evidenceN: countSchema.nullable(),
  state: signalStatusSchema,
  result: resultSchema.nullable(),
  countsInStats: z.boolean().nullable(),
  isWin: z.boolean().nullable(),
  closedAt: timestampSchema.nullable(),
  exitPrice: priceSchema.nullable(),
  exitReason: z.string().nullable(),
  realizedRNet: r3Schema.nullable(),
  mfeR: r3Schema.nullable(),
  maeR: r3Schema.nullable(),
  durationS: countSchema.nullable(),
  tp1Hit: z.boolean().nullable(),
  tp2Hit: z.boolean().nullable(),
  ambiguous: z.boolean().nullable(),
  primaryCause: causeCodeSchema.nullable(),
  autopsyStatus: autopsyStatusSchema.nullable(),
});
export type SignalHistoryRow = z.infer<typeof signalHistoryRowSchema>;

/**
 * One page of the history plus the summary of the WHOLE filtered list (not only this page): the same
 * counters as `GET /analytics/overview`, so the strip above the table does not depend on how many
 * pages were loaded. A win rate and its interval are null below 30 resolved signals (rule C6).
 */
export const signalHistoryPageSchema = pageSchema(signalHistoryRowSchema).extend({
  summary: overviewResponseSchema,
});
export type SignalHistoryPage = z.infer<typeof signalHistoryPageSchema>;

/** Columns the list can be sorted by. Rows without a value (open signals) come last in both directions. */
export const SIGNAL_SORTS = ['generatedAt', 'qualityScore', 'realizedRNet', 'durationS'] as const;
export const signalSortSchema = z.enum(SIGNAL_SORTS);
export type SignalSort = z.infer<typeof signalSortSchema>;
export const sortOrderSchema = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof sortOrderSchema>;

export const signalHistoryQuerySchema = z
  .strictObject({
    ...rangeShape,
    result: resultSchema.optional(),
    strategy: strategyKeySchema.optional(),
    side: sideSchema.optional(),
    session: sessionSchema.optional(),
    regime: regimeSchema.optional(),
    cause: causeCodeSchema.optional(),
    grade: gradeSchema.optional(),
    /** Newest first (`generatedAt`, `desc`) when absent. A cursor is only valid with the sort it was made for. */
    sort: signalSortSchema.optional(),
    order: sortOrderSchema.optional(),
    ...pageQueryShape,
  })
  .check((ctx) => {
    checkRange(ctx);
  });
export type SignalHistoryQuery = z.input<typeof signalHistoryQuerySchema>;

/** GET /signals/:id. An open signal has state and no outcome; a closed one has an outcome and no state. */
export const signalDetailSchema = z
  .strictObject({
    signal: signalSchema,
    state: signalStateSchema.nullable(),
    events: z.array(signalEventSchema),
    outcome: outcomeSchema.nullable(),
    autopsy: autopsySchema.nullable(),
    snapshotAvailable: z.boolean(),
  })
  .check((ctx) => {
    const { signal, state, events, outcome, autopsy } = ctx.value;
    if ((state === null) === (outcome === null)) {
      addIssue(ctx, 'exactly one of state and outcome is present', ['state']);
    }
    if (autopsy !== null && outcome === null) {
      addIssue(ctx, 'a review exists only after the outcome', ['autopsy']);
    }
    if (events.some((event) => event.signalId !== signal.id)) {
      addIssue(ctx, 'events must belong to the signal', ['events']);
    }
  });
export type SignalDetail = z.infer<typeof signalDetailSchema>;

/** GET /signals/:id/snapshot. After the retention window the API answers 404 `snapshot_pruned` instead. */
export const featureSnapshotResponseSchema = z.strictObject({
  signalId: uuidSchema,
  features: jsonRecordSchema,
});
export type FeatureSnapshotResponse = z.infer<typeof featureSnapshotResponseSchema>;
