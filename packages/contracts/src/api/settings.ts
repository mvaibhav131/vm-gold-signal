import { z } from 'zod';

import {
  gateModeSchema,
  gradeSchema,
  localeSchema,
  newsImpactSchema,
  newsTopicSchema,
  notificationKindSchema,
  strategyKeySchema,
} from '../enums';
import { addIssue } from '../primitives';

function isIanaTimeZone(value: string): boolean {
  // Intl also accepts fixed offsets such as "+05:30"; settings only take named zones.
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const ianaTimeZoneSchema = z
  .string()
  .refine(isIanaTimeZone, 'IANA time zone, e.g. Asia/Kolkata');

export const onOffSchema = z.enum(['on', 'off']);

const telegramAlertsSchema = z.strictObject({
  enabled: z.boolean(),
  minGrade: gradeSchema,
  kinds: z
    .array(notificationKindSchema)
    .refine((kinds) => new Set(kinds).size === kinds.length, 'kinds must be unique'),
});

const webPushAlertsSchema = z.strictObject({ enabled: z.boolean(), minGrade: gradeSchema });

const advisoryGatesSchema = z.strictObject({
  newsWindow: gateModeSchema,
  rollover: gateModeSchema,
  offHours: gateModeSchema,
  nearLevel: gateModeSchema,
});

/** GET /settings. Strategy parameters are not settings: they live in immutable strategy versions. */
export const settingsSchema = z.strictObject({
  displayTz: ianaTimeZoneSchema,
  locale: localeSchema,
  alerts: z.strictObject({ telegram: telegramAlertsSchema, webpush: webPushAlertsSchema }),
  advisoryGates: advisoryGatesSchema,
  strategyAlerts: z.record(strategyKeySchema, onOffSchema),
  newsAlerts: z.strictObject({
    minImpact: newsImpactSchema,
    topics: z.record(newsTopicSchema, onOffSchema),
    marketMoves: onOffSchema,
  }),
});
export type Settings = z.infer<typeof settingsSchema>;

/** PATCH /settings. Any subset of the settings; at least one value must be sent. */
export const settingsPatchSchema = z
  .strictObject({
    displayTz: ianaTimeZoneSchema.optional(),
    locale: localeSchema.optional(),
    alerts: z
      .strictObject({
        telegram: telegramAlertsSchema.partial().optional(),
        webpush: webPushAlertsSchema.partial().optional(),
      })
      .optional(),
    advisoryGates: advisoryGatesSchema.partial().optional(),
    strategyAlerts: z.partialRecord(strategyKeySchema, onOffSchema).optional(),
    newsAlerts: z
      .strictObject({
        minImpact: newsImpactSchema.optional(),
        topics: z.partialRecord(newsTopicSchema, onOffSchema).optional(),
        marketMoves: onOffSchema.optional(),
      })
      .optional(),
  })
  .check((ctx) => {
    if (Object.keys(ctx.value).length === 0) addIssue(ctx, 'send at least one setting');
  });
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
