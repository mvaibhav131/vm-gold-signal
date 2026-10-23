import { z } from 'zod';

import {
  engineStatusSchema,
  feedStateSchema,
  newsStateSchema,
  regimeSchema,
  sessionSchema,
  signalStatusSchema,
} from '../enums';
import { countSchema, priceSchema, r2Schema, spreadSchema, uuidSchema } from '../primitives';
import { waitReasonSchema } from './market';
import { headlineSchema, macroEventSchema } from './news';

/** Event ids are `<bootId>:<n>`. Quotes carry no id because they are never replayed. */
export const sseEventIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}:\d+$/, '<bootId>:<n>');

export const SSE_HEARTBEAT_COMMENT = ': hb';
export const SSE_HEARTBEAT_SECONDS = 15;
export const SSE_REPLAY_BUFFER = 200;

export const quoteEventSchema = z.strictObject({
  event: z.literal('quote'),
  data: z.strictObject({
    bid: priceSchema,
    ask: priceSchema,
    spread: spreadSchema,
    ageMs: countSchema,
    feedState: feedStateSchema,
  }),
});
export type QuoteData = z.infer<typeof quoteEventSchema>['data'];

/** Only the id: the client fetches the canonical row. */
export const signalEventPayloadSchema = z.strictObject({
  event: z.literal('signal'),
  data: z.strictObject({ id: uuidSchema }),
});

export const signalUpdateEventSchema = z.strictObject({
  event: z.literal('signal_update'),
  data: z.strictObject({
    id: uuidSchema,
    status: signalStatusSchema,
    unrealisedR: r2Schema,
    stop: priceSchema,
  }),
});

export const engineEventSchema = z.strictObject({
  event: z.literal('engine'),
  data: z.strictObject({
    status: engineStatusSchema,
    waitReasons: z.array(waitReasonSchema),
    regime: regimeSchema,
    session: sessionSchema,
  }),
});

export const newsEventSchema = z.strictObject({
  event: z.literal('news'),
  data: z.strictObject({
    state: newsStateSchema,
    next: macroEventSchema.nullable(),
    headline: headlineSchema.optional(),
  }),
});

export const healthEventSchema = z.strictObject({
  event: z.literal('health'),
  data: z.record(z.string().min(1), z.enum(['OK', 'DEGRADED', 'DOWN', 'UNKNOWN'])),
});

/** Sent when Last-Event-ID is unknown or too old: the client reloads its state over REST. */
export const resyncEventSchema = z.strictObject({
  event: z.literal('resync'),
  data: z.strictObject({}),
});

export const sseEventSchema = z.discriminatedUnion('event', [
  quoteEventSchema,
  signalEventPayloadSchema,
  signalUpdateEventSchema,
  engineEventSchema,
  newsEventSchema,
  healthEventSchema,
  resyncEventSchema,
]);
export type SseEvent = z.infer<typeof sseEventSchema>;
