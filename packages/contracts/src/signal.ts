import {
  GATE_CODES,
  QUALITY_GROUPS,
  groupState,
  qualityGrade,
  type ExitProfile,
  type GateCode,
  type Side,
} from '@vmgs/core';
import { z } from 'zod';

import {
  autopsyStatusSchema,
  causeCodeSchema,
  exitProfileSchema,
  gateCodeSchema,
  groupStateSchema,
  advisoryFlagSchema,
  newsStateSchema,
  qualityGroupSchema,
  regimeSchema,
  resultSchema,
  sessionSchema,
  sideSchema,
  signalEventTypeSchema,
  signalModeSchema,
  signalStatusSchema,
  strategyKeySchema,
  timeframeSchema,
  volBucketSchema,
} from './enums';
import { explanationSchema, evidenceSchema, type Explanation } from './explanation';
import {
  addIssue,
  countSchema,
  epochMs,
  fractionSchema,
  jsonRecordSchema,
  priceSchema,
  r3Schema,
  scoreSchema,
  semverSchema,
  setupKeySchema,
  symbolSchema,
  timestampSchema,
  uuidSchema,
} from './primitives';

const PRICE_TOLERANCE = 1e-6;

export const chartObjectTypeSchema = z.enum(['trendline', 'channel', 'zone', 'pattern', 'fib']);

/** A drawable object (trendline, zone, pattern...) with its coordinates, so the UI can draw it and the review can explain it. */
export const chartObjectSchema = z.strictObject({
  id: z.string().min(1),
  type: chartObjectTypeSchema,
  tf: timeframeSchema,
  points: z.array(z.strictObject({ t: timestampSchema, price: priceSchema })).min(1),
  meta: jsonRecordSchema,
});
export type ChartObject = z.infer<typeof chartObjectSchema>;

export const groupScoreSchema = z
  .strictObject({
    key: qualityGroupSchema,
    state: groupStateSchema,
    strength: fractionSchema.nullable(),
  })
  .check((ctx) => {
    if (groupState(ctx.value.strength) !== ctx.value.state) {
      addIssue(ctx, `state does not match strength (${groupState(ctx.value.strength)} expected)`, [
        'state',
      ]);
    }
  });

export const gateResultSchema = z.strictObject({
  code: gateCodeSchema,
  passed: z.boolean(),
  value: z.number().optional(),
  limit: z.number().optional(),
});

interface SignalRuleFields {
  side: Side;
  entry: number;
  maxValidEntry: number;
  stopLoss: number;
  tp1: number;
  tp2: number | null;
  riskDistance: number;
  exitProfile: ExitProfile;
  generatedAt: string;
  entryValidUntil: string;
  timeStopAt: string;
  qualityScore: number;
  groupedScores: { key: string }[];
  hardGates: { code: GateCode; passed: boolean }[];
  explanation: Explanation;
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((code) => actual.includes(code));
}

/** The rules a signal must satisfy before it may exist: the trade maths works and nothing was skipped. */
function checkSignalRules(ctx: z.core.ParsePayload<SignalRuleFields>): void {
  const s = ctx.value;
  const buy = s.side === 'BUY';
  const above = (a: number, b: number) => (buy ? a > b : a < b);

  if (!above(s.entry, s.stopLoss))
    addIssue(ctx, 'stop must be on the losing side of entry', ['stopLoss']);
  if (!above(s.tp1, s.entry)) addIssue(ctx, 'tp1 must be on the winning side of entry', ['tp1']);
  if (s.maxValidEntry !== s.entry && !above(s.maxValidEntry, s.entry)) {
    addIssue(ctx, 'maxValidEntry must not be on the safe side of entry', ['maxValidEntry']);
  }
  if (s.tp2 !== null && !above(s.tp2, s.tp1)) addIssue(ctx, 'tp2 must lie beyond tp1', ['tp2']);
  if (Math.abs(s.riskDistance - Math.abs(s.entry - s.stopLoss)) > PRICE_TOLERANCE) {
    addIssue(ctx, 'riskDistance must equal |entry - stop|', ['riskDistance']);
  }

  const twoTargets = s.exitProfile === 'EP1_PARTIAL';
  if (twoTargets && s.tp2 === null) addIssue(ctx, 'EP1_PARTIAL needs tp2', ['tp2']);
  if (!twoTargets && s.tp2 !== null) addIssue(ctx, `${s.exitProfile} has a single target`, ['tp2']);

  if (epochMs(s.entryValidUntil) <= epochMs(s.generatedAt)) {
    addIssue(ctx, 'entryValidUntil must be after generatedAt', ['entryValidUntil']);
  }
  if (epochMs(s.timeStopAt) <= epochMs(s.generatedAt)) {
    addIssue(ctx, 'timeStopAt must be after generatedAt', ['timeStopAt']);
  }

  if (
    !sameSet(
      s.hardGates.map((g) => g.code),
      GATE_CODES,
    )
  ) {
    addIssue(ctx, 'every blocking gate must be recorded exactly once', ['hardGates']);
  }
  if (s.hardGates.some((g) => !g.passed)) {
    addIssue(ctx, 'a signal cannot exist while a blocking gate failed', ['hardGates']);
  }
  if (
    !sameSet(
      s.groupedScores.map((g) => g.key),
      QUALITY_GROUPS,
    )
  ) {
    addIssue(ctx, 'every quality group must be scored exactly once', ['groupedScores']);
  }

  const levels = s.explanation.levels;
  if (
    levels.entry !== s.entry ||
    levels.maxValidEntry !== s.maxValidEntry ||
    levels.stop !== s.stopLoss ||
    levels.tp1 !== s.tp1 ||
    levels.tp2 !== s.tp2 ||
    levels.riskUsd !== s.riskDistance
  ) {
    addIssue(ctx, 'explanation levels must equal the signal levels', ['explanation', 'levels']);
  }
  const grade = qualityGrade(s.qualityScore);
  if (grade === null) addIssue(ctx, 'quality score is below the lowest grade', ['qualityScore']);
  if (s.explanation.quality.score !== s.qualityScore || s.explanation.quality.grade !== grade) {
    addIssue(ctx, 'explanation quality must equal the signal quality', ['explanation', 'quality']);
  }
}

const signalShape = {
  symbol: symbolSchema,
  side: sideSchema,
  strategyKey: strategyKeySchema,
  strategyVersion: semverSchema,
  exitProfile: exitProfileSchema,
  mode: signalModeSchema,
  generatedAt: timestampSchema,
  sourceAt: timestampSchema,
  entry: priceSchema,
  maxValidEntry: priceSchema,
  entryValidUntil: timestampSchema,
  stopLoss: priceSchema,
  tp1: priceSchema,
  tp2: priceSchema.nullable(),
  riskDistance: priceSchema,
  atr5: priceSchema,
  timeStopAt: timestampSchema,
  regime: regimeSchema,
  session: sessionSchema,
  volBucket: volBucketSchema,
  newsState: newsStateSchema,
  setupKey: setupKeySchema,
  openSignalsAtEntry: countSchema,
  warnings: z.array(advisoryFlagSchema),
  chartObjects: z.array(chartObjectSchema),
  qualityScore: scoreSchema,
  groupedScores: z.array(groupScoreSchema),
  hardGates: z.array(gateResultSchema),
  explanation: explanationSchema,
  evidence: evidenceSchema,
  dataLatencyMs: countSchema.nullable(),
};

/** What the worker hands to the signal transaction. The database assigns id, seq and created_at. */
export const signalDraftSchema = z
  .strictObject({ ...signalShape, featureSnapshot: jsonRecordSchema })
  .check((ctx) => {
    checkSignalRules(ctx);
  });
export type SignalDraft = z.infer<typeof signalDraftSchema>;

/** A stored signal as the API returns it (the feature snapshot has its own endpoint). */
export const signalSchema = z
  .strictObject({
    id: uuidSchema,
    seq: z.int().positive(),
    ...signalShape,
    createdAt: timestampSchema,
  })
  .check((ctx) => {
    checkSignalRules(ctx);
  });
export type Signal = z.infer<typeof signalSchema>;

/** Mutable working state of an open signal. */
export const signalStateSchema = z
  .strictObject({
    signalId: uuidSchema,
    status: signalStatusSchema,
    stopLossCurrent: priceSchema,
    tp1HitAt: timestampSchema.nullable(),
    mfeR: r3Schema.pipe(z.number().nonnegative()),
    maeR: r3Schema.pipe(z.number().nonpositive()),
    updatedAt: timestampSchema,
  })
  .check((ctx) => {
    const { status, tp1HitAt } = ctx.value;
    if (status === 'ACTIVE' && tp1HitAt !== null)
      addIssue(ctx, 'ACTIVE has no TP1 time', ['tp1HitAt']);
    if (status === 'TP1_HIT' && tp1HitAt === null)
      addIssue(ctx, 'TP1_HIT needs a TP1 time', ['tp1HitAt']);
  });
export type SignalState = z.infer<typeof signalStateSchema>;

export const signalEventSchema = z.strictObject({
  id: z.int().positive(),
  signalId: uuidSchema,
  eventType: signalEventTypeSchema,
  eventAt: timestampSchema,
  price: priceSchema.nullable(),
  meta: jsonRecordSchema,
});
export type SignalEvent = z.infer<typeof signalEventSchema>;

const COUNTS_IN_STATS = new Set(['WIN', 'PARTIAL_WIN', 'LOSS', 'TIME_EXIT']);

export const outcomeSchema = z
  .strictObject({
    signalId: uuidSchema,
    result: resultSchema,
    countsInStats: z.boolean(),
    closedAt: timestampSchema,
    exitPrice: priceSchema.nullable(),
    exitReason: z.string().min(1),
    realizedRGross: r3Schema.nullable(),
    costR: r3Schema.pipe(z.number().nonnegative()),
    realizedRNet: r3Schema.nullable(),
    durationS: countSchema,
    mfeR: r3Schema.nullable(),
    maeR: r3Schema.nullable(),
    tp1Hit: z.boolean(),
    tp2Hit: z.boolean(),
    ambiguous: z.boolean(),
    isWin: z.boolean(),
    meta: jsonRecordSchema,
  })
  .check((ctx) => {
    const o = ctx.value;
    if (o.countsInStats !== COUNTS_IN_STATS.has(o.result)) {
      addIssue(
        ctx,
        `${o.result} ${COUNTS_IN_STATS.has(o.result) ? 'must' : 'must not'} count in statistics`,
        ['countsInStats'],
      );
    }
    if (o.countsInStats && o.realizedRNet === null) {
      addIssue(ctx, 'a counted outcome needs net R', ['realizedRNet']);
    }
    if (o.isWin !== (o.countsInStats && o.realizedRNet !== null && o.realizedRNet > 0)) {
      addIssue(ctx, 'isWin is true only for a counted outcome with net R above zero', ['isWin']);
    }
    if (o.tp2Hit && !o.tp1Hit) addIssue(ctx, 'TP2 cannot be hit before TP1', ['tp2Hit']);
  });
export type Outcome = z.infer<typeof outcomeSchema>;

export const causeSchema = z.strictObject({ code: causeCodeSchema, evidence: jsonRecordSchema });

export const autopsySchema = z
  .strictObject({
    signalId: uuidSchema,
    status: autopsyStatusSchema,
    primaryCause: causeCodeSchema,
    causes: z.array(causeSchema).min(1),
    weakGroupsAtEntry: z.array(
      z.strictObject({ group: qualityGroupSchema, state: z.enum(['WEAK', 'FAIL']) }),
    ),
    counterfactual: z
      .strictObject({
        reachedTp1: z.boolean(),
        candlesToTp1: countSchema.nullable(),
        reachedTp2: z.boolean().optional(),
        candlesToTp2: countSchema.nullable().optional(),
      })
      .nullable(),
    computedAt: timestampSchema,
    finalizedAt: timestampSchema.nullable(),
  })
  .check((ctx) => {
    const a = ctx.value;
    if (!a.causes.some((cause) => cause.code === a.primaryCause)) {
      addIssue(ctx, 'primaryCause must be listed in causes', ['primaryCause']);
    }
    if (a.status === 'FINAL' && a.finalizedAt === null) {
      addIssue(ctx, 'a FINAL review needs finalizedAt', ['finalizedAt']);
    }
    if (a.status === 'PRELIMINARY' && a.finalizedAt !== null) {
      addIssue(ctx, 'a PRELIMINARY review has no finalizedAt', ['finalizedAt']);
    }
  });
export type Autopsy = z.infer<typeof autopsySchema>;
