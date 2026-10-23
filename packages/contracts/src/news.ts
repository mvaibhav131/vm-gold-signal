import { z } from 'zod';

import { newsImpactSchema, newsTopicSchema } from './enums';
import { addIssue, timestampSchema } from './primitives';

/** Only http(s) links are accepted, so a feed can never smuggle a `javascript:` link into the UI. */
export const httpUrlSchema = z.url({ protocol: /^https?$/ }).max(2048);

/**
 * A headline as frozen into a signal explanation or a market move, so it survives retention.
 * Unclassified items are kept for timing only and carry no impact or topics.
 */
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
export type FrozenHeadline = z.infer<typeof frozenHeadlineSchema>;
