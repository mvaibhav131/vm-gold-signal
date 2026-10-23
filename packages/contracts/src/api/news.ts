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
import { checkRange, pageQueryShape, rangeShape } from './common';

/** Only http(s) links are accepted, so a feed can never smuggle a `javascript:` link into the UI. */
export const httpUrlSchema = z.url({ protocol: /^https?$/ }).max(2048);

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

export const newsStateResponseSchema = z.strictObject({
  state: newsStateSchema,
  next: macroEventSchema.nullable(),
  last: macroEventSchema.nullable(),
  sourceAgeS: countSchema.nullable(),
});

export const newsEventsQuerySchema = z
  .strictObject({ ...rangeShape, importance: macroImportanceSchema.optional() })
  .check((ctx) => {
    checkRange(ctx);
  });

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

/** The frozen copy of a headline stored with a market move. Unclassified items are labelled "timing only". */
export const frozenHeadlineSchema = z
  .strictObject({
    title: z.string().min(1).max(500),
    sources: z.array(z.string().min(1)).min(1),
    publishedAt: timestampSchema.nullable(),
    impact: newsImpactSchema.nullable(),
    topics: z.array(newsTopicSchema),
    url: httpUrlSchema,
    classified: z.boolean(),
  })
  .check((ctx) => {
    const { classified, impact, topics } = ctx.value;
    if (!classified && (impact !== null || topics.length > 0)) {
      addIssue(ctx, 'an unclassified headline has no impact or topics', ['classified']);
    }
    if (classified && impact === null)
      addIssue(ctx, 'a classified headline has an impact', ['impact']);
  });

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
