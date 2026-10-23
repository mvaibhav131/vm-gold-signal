import { defaultEngineState, defaultSettings } from '@vmgs/config';
import type { Kysely } from 'kysely';

import type { DB } from './types.generated';

/** The app_settings rows of a fresh database, one per key (03_Data_Model: app_settings). */
export function defaultSettingRows(): { key: string; value: string }[] {
  const { displayTz, locale, alerts, advisoryGates, strategyAlerts, newsAlerts } =
    defaultSettings();
  return Object.entries({
    displayTz,
    locale,
    alerts,
    advisoryGates,
    strategyAlerts,
    newsAlerts,
    engine: defaultEngineState(),
  }).map(([key, value]) => ({ key, value: JSON.stringify(value) }));
}

/**
 * Inserts the default settings that are missing and never touches a key that exists, so a value
 * the owner changed survives every restart. Returns the keys it inserted.
 */
export async function seedDefaultSettings(db: Kysely<DB>): Promise<string[]> {
  const inserted = await db
    .insertInto('app_settings')
    .values(defaultSettingRows())
    .onConflict((oc) => oc.column('key').doNothing())
    .returning('key')
    .execute();
  return inserted.map((row) => row.key).sort();
}
