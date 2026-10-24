import { z } from 'zod';

import { evidenceSchema } from '../explanation';
import { strategyKeySchema, strategyStatusSchema } from '../enums';
import { addIssue, semverSchema, timestampSchema } from '../primitives';

/** One entry of GET /strategies. The strategy config itself is read-only and never sent here. */
export const strategyInfoSchema = z.strictObject({
  key: strategyKeySchema,
  version: semverSchema,
  status: strategyStatusSchema,
  enabled: z.boolean(),
  alerts: z.boolean(),
  lastSignalAt: timestampSchema.nullable(),
  evidence: evidenceSchema.nullable(),
});
export type StrategyInfo = z.infer<typeof strategyInfoSchema>;

/** GET /strategies/:key/config: the config of the version in use, for reading only (versions are immutable). */
export const strategyConfigResponseSchema = z.strictObject({
  key: strategyKeySchema,
  version: semverSchema,
  config: z.record(z.string(), z.json()),
});
export type StrategyConfigResponse = z.infer<typeof strategyConfigResponseSchema>;

/** PATCH /strategies/:key. Only the two owner switches can change; at least one must be sent. */
export const strategyPatchSchema = z
  .strictObject({ enabled: z.boolean().optional(), alerts: z.boolean().optional() })
  .check((ctx) => {
    if (ctx.value.enabled === undefined && ctx.value.alerts === undefined) {
      addIssue(ctx, 'send enabled, alerts or both');
    }
  });
export type StrategyPatch = z.infer<typeof strategyPatchSchema>;
