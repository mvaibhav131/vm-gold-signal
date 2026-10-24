import { z } from 'zod';

import { feedIncidentKindSchema, notificationChannelSchema } from '../enums';
import { addIssue, countSchema, timestampSchema } from '../primitives';
import { listSchema } from './common';

export const healthLiveSchema = z.strictObject({ status: z.literal('ok') });

/** Public and deliberately minimal: ok or not_ready, no details. */
export const healthReadySchema = z.strictObject({ status: z.enum(['ok', 'not_ready']) });

/** GET /system/health (authenticated). Null means the value is not known yet, never a guess. */
export const systemHealthSchema = z.strictObject({
  feedAgeMs: countSchema.nullable(),
  ticksPerSecond: z.number().nonnegative().nullable(),
  workerHeartbeatAt: timestampSchema.nullable(),
  eventLoopLagMs: z.number().nonnegative().nullable(),
  dbReachable: z.boolean(),
  telegram: z.strictObject({
    lastSendAt: timestampSchema.nullable(),
    lastError: z.string().nullable(),
  }),
  clockSkewMs: z.number().nullable(),
  lastBackupAt: timestampSchema.nullable(),
  lastMaintenanceAt: timestampSchema.nullable(),
});
export type SystemHealth = z.infer<typeof systemHealthSchema>;

/** One entry of the feed incident list of the Health tab (table `feed_incidents`). `detail` is one readable line. */
export const feedIncidentSchema = z
  .strictObject({
    id: z.int().positive(),
    kind: feedIncidentKindSchema,
    startedAt: timestampSchema,
    endedAt: timestampSchema.nullable(),
    detail: z.string(),
  })
  .check((ctx) => {
    const { startedAt, endedAt } = ctx.value;
    if (endedAt !== null && Date.parse(endedAt) < Date.parse(startedAt)) {
      addIssue(ctx, 'an incident cannot end before it starts', ['endedAt']);
    }
  });
export type FeedIncident = z.infer<typeof feedIncidentSchema>;

/** The last 30 incidents, newest first. */
export const systemIncidentsResponseSchema = listSchema(feedIncidentSchema).check((ctx) => {
  if (ctx.value.items.length > 30) addIssue(ctx, 'at most 30 incidents', ['items']);
});
export type SystemIncidentsResponse = z.infer<typeof systemIncidentsResponseSchema>;

export const systemStorageSchema = z.strictObject({
  dbSizeBytes: countSchema,
  tables: z.array(z.strictObject({ name: z.string().min(1), sizeBytes: countSchema })),
  retention: z.array(z.strictObject({ item: z.string().min(1), rule: z.string().min(1) })),
  budgetPct: z.number().nonnegative(),
  lastMaintenanceRun: z
    .strictObject({
      job: z.string().min(1),
      finishedAt: timestampSchema.nullable(),
      rowsDeleted: countSchema,
    })
    .nullable(),
});
export type SystemStorage = z.infer<typeof systemStorageSchema>;

const latencyMetricSchema = z
  .strictObject({
    p50Ms: z.number().nonnegative().nullable(),
    p95Ms: z.number().nonnegative().nullable(),
    samples: countSchema,
  })
  .check((ctx) => {
    const { p50Ms, p95Ms } = ctx.value;
    if (p50Ms !== null && p95Ms !== null && p50Ms > p95Ms) {
      addIssue(ctx, 'p50 must not exceed p95', ['p50Ms']);
    }
  });

export const systemLatencySchema = z.strictObject({
  feedLag: latencyMetricSchema,
  candleToSignal: latencyMetricSchema,
  dbCommit: latencyMetricSchema,
  notifyDispatch: latencyMetricSchema,
});
export type SystemLatency = z.infer<typeof systemLatencySchema>;

export const notificationTestRequestSchema = z.strictObject({ channel: notificationChannelSchema });
export const notificationTestResponseSchema = z.strictObject({
  eventKey: z.string().regex(/^test:[0-9a-f-]{36}$/),
});
export type NotificationTestRequest = z.infer<typeof notificationTestRequestSchema>;
export type NotificationTestResponse = z.infer<typeof notificationTestResponseSchema>;

const base64UrlSchema = z
  .string()
  .min(16)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, 'base64url');

export const pushSubscribeRequestSchema = z.strictObject({
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
  keys: z.strictObject({ p256dh: base64UrlSchema, auth: base64UrlSchema }),
  userAgent: z.string().max(300).optional(),
});

export const pushUnsubscribeRequestSchema = z.strictObject({
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
});
