import { z } from 'zod';

import {
  engineStatusSchema,
  feedStateSchema,
  regimeSchema,
  sessionSchema,
  signalModeSchema,
  timeframeSchema,
} from '../enums';
import { chartCandleSchema } from '../market';
import {
  addIssue,
  countSchema,
  priceSchema,
  r2Schema,
  spreadSchema,
  symbolSchema,
  timestampSchema,
} from '../primitives';
import { chartObjectSchema } from '../signal';
import { csvEnum } from './common';

export const OVERLAYS = ['ema20', 'ema50', 'ema200', 'supertrend'] as const;
export const OBJECT_KINDS = ['trendlines', 'zones', 'patterns', 'fib'] as const;

export const waitReasonSchema = z.strictObject({
  code: z.string().min(1),
  label: z.string().min(1),
});
export type WaitReason = z.infer<typeof waitReasonSchema>;

export const engineSnapshotSchema = z
  .strictObject({
    status: engineStatusSchema,
    pausedSince: timestampSchema.optional(),
    openCount: countSchema,
    openRiskR: r2Schema.pipe(z.number().nonnegative()),
    // While warming up, the timeframes that still lack candles (05_UI_Spec section 4, WARMING_UP).
    warmup: z.strictObject({
      ready: z.boolean(),
      progressPct: z.number().min(0).max(100),
      missingTimeframes: z.array(timeframeSchema),
    }),
    waitReasons: z.array(waitReasonSchema),
    evaluatedAt: timestampSchema,
  })
  .check((ctx) => {
    const { status, pausedSince, warmup } = ctx.value;
    if (status === 'PAUSED' && pausedSince === undefined) {
      addIssue(ctx, 'PAUSED needs pausedSince', ['pausedSince']);
    }
    if (status === 'RUNNING' && pausedSince !== undefined) {
      addIssue(ctx, 'RUNNING has no pausedSince', ['pausedSince']);
    }
    if (warmup.ready && warmup.missingTimeframes.length > 0) {
      addIssue(ctx, 'a warmed-up engine misses no timeframe', ['warmup', 'missingTimeframes']);
    }
  });
export type EngineSnapshot = z.infer<typeof engineSnapshotSchema>;

/** GET /market/snapshot. mid is rounded to 3 decimals, so it may differ from (bid+ask)/2 by up to 0.0005. */
export const marketSnapshotSchema = z
  .strictObject({
    symbol: symbolSchema,
    bid: priceSchema,
    ask: priceSchema,
    mid: priceSchema,
    spread: spreadSchema,
    sourceAt: timestampSchema,
    receivedAt: timestampSchema,
    ageMs: countSchema,
    feedState: feedStateSchema,
    session: sessionSchema,
    regime: regimeSchema,
    mode: signalModeSchema,
    engine: engineSnapshotSchema,
  })
  .check((ctx) => {
    const { bid, ask, mid, spread } = ctx.value;
    if (ask < bid) addIssue(ctx, 'ask must be >= bid', ['ask']);
    if (Math.abs(spread - (ask - bid)) > 1e-6) {
      addIssue(ctx, 'spread must equal ask - bid', ['spread']);
    }
    if (Math.abs(mid - (bid + ask) / 2) > 0.0005 + 1e-9) {
      addIssue(ctx, 'mid must be (bid + ask) / 2 rounded to 3 decimals', ['mid']);
    }
  });
export type MarketSnapshot = z.infer<typeof marketSnapshotSchema>;

export const candlesQuerySchema = z.strictObject({
  tf: timeframeSchema.default('5m'),
  limit: z.coerce.number().pipe(z.int().min(1).max(2000)).default(500),
  before: timestampSchema.optional(),
  overlays: csvEnum(OVERLAYS).default([]),
  objects: csvEnum(OBJECT_KINDS).default([]),
});

export const levelSchema = z.strictObject({
  key: z.string().min(1),
  label: z.string().min(1),
  price: priceSchema,
});
export type Level = z.infer<typeof levelSchema>;

export const candlesResponseSchema = z.strictObject({
  candles: z.array(chartCandleSchema),
  overlays: z.partialRecord(z.enum(OVERLAYS), z.array(z.number().nullable())),
  levels: z.array(levelSchema),
  objects: z.array(chartObjectSchema),
});
export type CandlesResponse = z.infer<typeof candlesResponseSchema>;
export type CandlesQuery = z.input<typeof candlesQuerySchema>;

export const pauseRequestSchema = z.strictObject({
  minutes: z.int().min(1).max(10_080).optional(),
});

/** The owner's pause state, stored in app_settings under the key `engine`. */
export const engineStateSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('RUNNING') }),
  z.strictObject({
    status: z.literal('PAUSED'),
    pausedSince: timestampSchema,
    /** Null until the owner resumes. */
    pausedUntil: timestampSchema.nullable(),
  }),
]);
export type EngineState = z.infer<typeof engineStateSchema>;
