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

export const signalHistoryPageSchema = pageSchema(signalHistoryRowSchema);
export type SignalHistoryPage = z.infer<typeof signalHistoryPageSchema>;

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
