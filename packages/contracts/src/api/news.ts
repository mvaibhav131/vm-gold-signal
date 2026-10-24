import { z } from 'zod';

import {
  macroImportanceSchema,
  marketEventKindSchema,
  newsImpactSchema,
  newsStateSchema,
  newsTopicSchema,
} from '../enums';
import {
  addIssue,
  countSchema,
  priceSchema,
  spreadSchema,
  timestampSchema,
  uuidSchema,
} from '../primitives';
import { frozenHeadlineSchema, httpUrlSchema } from '../news';
import { checkRange, listSchema, pageQueryShape, rangeShape } from './common';

export const macroEventSchema = z.strictObject({
  id: uuidSchema,
  name: z.string().min(1),
  scheduledAt: timestampSchema,
  importance: macroImportanceSchema,
  currency: z.string().nullable(),
  unit: z.string().nullable(),
  actual: z.number().nullable(),
  forecast: z.number().nullable(),
  previous: z.number().nullable(),
  revisedPrevious: z.number().nullable(),
});
export type MacroEvent = z.infer<typeof macroEventSchema>;

/**
 * An event of the calendar list: the event and what was measured after it was released. Both
 * extra values are null until the release, and when the data needed is missing (a null is never a guess).
 */
export const calendarEventSchema = macroEventSchema
  .extend({
    /** (actual - forecast) in standard deviations of the past surprises of the same indicator. */
    surpriseSigma: z.number().nullable(),
    /** Gold's move in the 5 minutes after the scheduled time, from the recorded 1-minute candles. */
    goldMoveAfter: z.strictObject({ usd: z.number(), atr: z.number() }).nullable(),
  })
  .check((ctx) => {
    const { actual, surpriseSigma, goldMoveAfter } = ctx.value;
    if (actual === null && surpriseSigma !== null) {
      addIssue(ctx, 'an event that was not released has no surprise', ['surpriseSigma']);
    }
    if (actual === null && goldMoveAfter !== null) {
      addIssue(ctx, 'an event that was not released has no move after it', ['goldMoveAfter']);
    }
  });
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

export const newsStateResponseSchema = z.strictObject({
  state: newsStateSchema,
  next: macroEventSchema.nullable(),
  last: macroEventSchema.nullable(),
  sourceAgeS: countSchema.nullable(),
});
export type NewsStateResponse = z.infer<typeof newsStateResponseSchema>;

export const newsEventsQuerySchema = z
  .strictObject({ ...rangeShape, importance: macroImportanceSchema.optional() })
  .check((ctx) => {
    checkRange(ctx);
  });
export type NewsEventsQuery = z.input<typeof newsEventsQuerySchema>;

/** Oldest first. `sourceAgeS` is the age of the last successful calendar fetch (null if there was none). */
export const newsEventsResponseSchema = z.strictObject({
  items: z.array(calendarEventSchema),
  sourceAgeS: countSchema.nullable(),
});
export type NewsEventsResponse = z.infer<typeof newsEventsResponseSchema>;

export const headlineSourceSchema = z.strictObject({
  key: z.string().min(1),
  name: z.string().min(1),
});

/** A cluster of the same story from one or more outlets. Title and link only, never article text. */
export const headlineSchema = z.strictObject({
  id: uuidSchema,
  title: z.string().min(1).max(500),
  sources: z.array(headlineSourceSchema).min(1),
  publishedAt: timestampSchema.nullable(),
  firstSeenAt: timestampSchema,
  delayS: countSchema.nullable(),
  topics: z.array(newsTopicSchema).min(1),
  impact: newsImpactSchema,
  url: httpUrlSchema,
  goldMoveSincePublish: z.strictObject({ usd: z.number(), atr: z.number() }).nullable(),
});
export type Headline = z.infer<typeof headlineSchema>;

export const newsSourceHealthSchema = z.strictObject({
  key: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  lastOkAt: timestampSchema.nullable(),
  lastError: z.string().nullable(),
});

export const headlinesQuerySchema = z
  .strictObject({
    ...rangeShape,
    minImpact: newsImpactSchema.optional(),
    topic: newsTopicSchema.optional(),
    ...pageQueryShape,
  })
  .check((ctx) => {
    checkRange(ctx);
  });

export const headlinesResponseSchema = z.strictObject({
  items: z.array(headlineSchema),
  nextCursor: z.string().min(1).nullable(),
  sources: z.array(newsSourceHealthSchema),
});
export type HeadlinesResponse = z.infer<typeof headlinesResponseSchema>;
export type HeadlinesQuery = z.input<typeof headlinesQuerySchema>;

/** The frozen copy of a headline stored with a market move is defined in ../news. */
export const marketMoveSchema = z.strictObject({
  id: z.int().positive(),
  detectedAt: timestampSchema,
  kind: marketEventKindSchema,
  windowS: z.int().positive(),
  moveUsd: priceSchema,
  moveAtr: z.number().positive(),
  spread: spreadSchema.nullable(),
  headlines: z.array(frozenHeadlineSchema),
});

export const marketMovesQuerySchema = z.strictObject({ ...rangeShape }).check((ctx) => {
  checkRange(ctx);
});
export type MarketMove = z.infer<typeof marketMoveSchema>;
export type MarketMovesQuery = z.input<typeof marketMovesQuerySchema>;

/** Newest first. */
export const marketMovesResponseSchema = listSchema(marketMoveSchema);
export type MarketMovesResponse = z.infer<typeof marketMovesResponseSchema>;
