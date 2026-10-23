import { TIMEFRAME_MS } from '@vmgs/core';
import { z } from 'zod';

import { candleSourceSchema, timeframeSchema } from './enums';
import {
  addIssue,
  countSchema,
  epochMs,
  feedSymbolSchema,
  priceSchema,
  spreadSchema,
  timestampSchema,
} from './primitives';

/** A normalised tick as it enters the recorder and the candle builder (prices already rounded to 3 decimals). */
export const tickSchema = z
  .strictObject({
    ts: timestampSchema,
    rxAt: timestampSchema,
    symbol: feedSymbolSchema,
    bid: priceSchema,
    ask: priceSchema,
  })
  .check((ctx) => {
    if (ctx.value.ask < ctx.value.bid) addIssue(ctx, 'ask must be >= bid', ['ask']);
  });
export type Tick = z.infer<typeof tickSchema>;

const ALIGNED_TIMEFRAMES: readonly string[] = ['1m', '5m', '15m', '1h', '4h'];

/** A candle of mid prices. Gaps are never filled with invented candles. */
export const candleSchema = z
  .strictObject({
    symbol: feedSymbolSchema,
    tf: timeframeSchema,
    openTime: timestampSchema,
    o: priceSchema,
    h: priceSchema,
    l: priceSchema,
    c: priceSchema,
    spreadAvg: spreadSchema.nullable(),
    spreadMax: spreadSchema.nullable(),
    tickCount: countSchema,
    complete: z.boolean(),
    source: candleSourceSchema,
  })
  .check((ctx) => {
    const { o, h, l, c, spreadAvg, spreadMax, tf, openTime } = ctx.value;
    if (h < Math.max(o, c, l)) addIssue(ctx, 'high must be the highest price', ['h']);
    if (l > Math.min(o, c, h)) addIssue(ctx, 'low must be the lowest price', ['l']);
    if (spreadAvg !== null && spreadMax !== null && spreadMax < spreadAvg) {
      addIssue(ctx, 'spreadMax must be >= spreadAvg', ['spreadMax']);
    }
    // The 1d candle follows the New York trading day, so only 1m to 4h are aligned to UTC.
    if (ALIGNED_TIMEFRAMES.includes(tf) && epochMs(openTime) % TIMEFRAME_MS[tf] !== 0) {
      addIssue(ctx, `openTime is not aligned to a ${tf} boundary`, ['openTime']);
    }
  });
export type Candle = z.infer<typeof candleSchema>;

/** Candle as sent to the chart: time and mid OHLC only. */
export const chartCandleSchema = z
  .strictObject({
    t: timestampSchema,
    o: priceSchema,
    h: priceSchema,
    l: priceSchema,
    c: priceSchema,
  })
  .check((ctx) => {
    const { o, h, l, c } = ctx.value;
    if (h < Math.max(o, c, l) || l > Math.min(o, c, h)) addIssue(ctx, 'inconsistent OHLC');
  });
export type ChartCandle = z.infer<typeof chartCandleSchema>;
