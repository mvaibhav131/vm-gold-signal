import { isDeepStrictEqual } from 'node:util';

import { defaultSettings } from '@vmgs/config';
import { settingsSchema, type Settings, type SettingsPatch } from '@vmgs/contracts';

export type SettingKey = keyof Settings;

/**
 * The `app_settings` keys that are settings. The table also holds the engine state, the Telegram link and the days of
 * ticks kept: none of them is ever read or written through the settings routes.
 */
export const SETTING_KEYS = Object.keys(settingsSchema.shape) as readonly SettingKey[];

const isSettingKey = (key: string): key is SettingKey => SETTING_KEYS.some((each) => each === key);

/** The one that is sent wins; a key that is not there (or `undefined`) leaves what was. */
function overlay<T extends object>(
  base: T,
  part: { [K in keyof T]?: T[K] | undefined } | undefined,
): T {
  if (part === undefined) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(part)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/**
 * What a `PATCH /settings` does (`apps/web/src/data/settingsPatch.ts` is the same rule): a value that is sent replaces
 * the stored one, the rest stays. The objects are merged one level at a time, so one switch of a strategy or of a topic
 * can change alone; a list (the alert kinds) is replaced as a whole.
 */
export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  const merged: Settings = {
    displayTz: patch.displayTz ?? current.displayTz,
    locale: patch.locale ?? current.locale,
    alerts: {
      telegram: overlay(current.alerts.telegram, patch.alerts?.telegram),
      webpush: overlay(current.alerts.webpush, patch.alerts?.webpush),
    },
    advisoryGates: overlay(current.advisoryGates, patch.advisoryGates),
    strategyAlerts: overlay(current.strategyAlerts, patch.strategyAlerts),
    newsAlerts: {
      minImpact: patch.newsAlerts?.minImpact ?? current.newsAlerts.minImpact,
      topics: overlay(current.newsAlerts.topics, patch.newsAlerts?.topics),
      marketMoves: patch.newsAlerts?.marketMoves ?? current.newsAlerts.marketMoves,
    },
  };
  return settingsSchema.parse(merged);
}

/** The keys whose value is not the same before and after: the only ones a change writes. */
export function changedKeys(before: Settings, after: Settings): SettingKey[] {
  return SETTING_KEYS.filter((key) => !isDeepStrictEqual(before[key], after[key]));
}

/** A stored value that no longer fits the settings is an error of the data, never a reason to guess. */
export class StoredSettingsError extends Error {
  constructor(keys: readonly string[]) {
    super(`the stored settings are not valid (${keys.join(', ')})`);
    this.name = 'StoredSettingsError';
  }
}

/**
 * The settings as they stand: the stored row of each key, and the default for a key that has no row (the way the
 * worker reads them). Rows of other keys are ignored.
 */
export function assembleSettings(rows: readonly { key: string; value: unknown }[]): Settings {
  const stored: Record<string, unknown> = { ...defaultSettings() };
  for (const row of rows) {
    if (isSettingKey(row.key)) stored[row.key] = row.value;
  }
  const parsed = settingsSchema.safeParse(stored);
  if (!parsed.success) {
    throw new StoredSettingsError([...new Set(parsed.error.issues.map((i) => String(i.path[0])))]);
  }
  return parsed.data;
}
