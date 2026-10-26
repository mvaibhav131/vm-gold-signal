import { z } from 'zod';

import { evidenceSchema } from '../explanation';
import { strategyKeySchema, strategyStatusSchema } from '../enums';
import { addIssue, semverSchema, timestampSchema } from '../primitives';
import { listSchema } from './common';

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

/** GET /strategies: one entry per strategy that has a version, in the order of the strategies of `02`. */
export const strategiesResponseSchema = listSchema(strategyInfoSchema);
export type StrategiesResponse = z.infer<typeof strategiesResponseSchema>;

/**
 * The owner's `enabled` switches, stored in `app_settings` under this key. A strategy without an entry is enabled.
 * A disabled strategy makes no new signal and no rejection; the signals it already has go on to their end.
 */
export const STRATEGY_ENABLED_KEY = 'strategyEnabled';
export const strategyEnabledSchema = z.partialRecord(strategyKeySchema, z.boolean());
export type StrategyEnabled = z.infer<typeof strategyEnabledSchema>;

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
