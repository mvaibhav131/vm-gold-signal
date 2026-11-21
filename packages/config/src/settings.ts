import {
  NEWS_TOPICS,
  NOTIFICATION_KINDS,
  STRATEGY_KEYS,
  type NewsTopic,
  type StrategyKey,
} from '@vmgs/core';
import {
  engineStateSchema,
  settingsSchema,
  type EngineState,
  type Settings,
} from '@vmgs/contracts';

/** Strategies A, B and C alert by default; D and E run in shadow mode until their backtest report, and the retired F does not alert. */
const ALERTS_ON: readonly StrategyKey[] = ['trend_pullback', 'sweep_reversal', 'squeeze_retest'];

function switches<K extends string>(
  keys: readonly K[],
  isOn: (key: K) => boolean,
): Record<K, 'on' | 'off'> {
  return Object.fromEntries(keys.map((key) => [key, isOn(key) ? 'on' : 'off'])) as Record<
    K,
    'on' | 'off'
  >;
}

/**
 * The runtime settings a fresh database starts with (app_settings). They are the documented
 * defaults: IST display, English messages, alerts from Moderate (65+), every advisory flag only
 * warns, strategy alerts on for A, B and C, news alerts from HIGH impact on every topic.
 * Web Push stays off until a device subscribes.
 */
export function defaultSettings(): Settings {
  return settingsSchema.parse({
    displayTz: 'Asia/Kolkata',
    locale: 'en',
    alerts: {
      telegram: { enabled: true, minGrade: 'Moderate', kinds: [...NOTIFICATION_KINDS] },
      webpush: { enabled: false, minGrade: 'Moderate' },
    },
    advisoryGates: { newsWindow: 'warn', rollover: 'warn', offHours: 'warn', nearLevel: 'warn' },
    strategyAlerts: switches(STRATEGY_KEYS, (key) => ALERTS_ON.includes(key)),
    newsAlerts: {
      minImpact: 'HIGH',
      topics: switches<NewsTopic>(NEWS_TOPICS, () => true),
      marketMoves: 'on',
    },
  });
}

/** A fresh system is running: the engine only pauses when the owner presses Pause. */
export function defaultEngineState(): EngineState {
  return engineStateSchema.parse({ status: 'RUNNING' });
}

/**
 * The settings as the readers see them: the stored row of each key over the documented defaults. A key without a
 * row takes its default, and so does a strategy added after the row was written (its switch is not in the row yet).
 */
export function settingsWithDefaults(
  rows: readonly { key: string; value: unknown }[],
): Record<string, unknown> {
  const defaults = defaultSettings();
  const stored: Record<string, unknown> = { ...defaults };
  for (const row of rows) stored[row.key] = row.value;
  const alerts = stored.strategyAlerts;
  if (typeof alerts === 'object' && alerts !== null && !Array.isArray(alerts)) {
    stored.strategyAlerts = { ...defaults.strategyAlerts, ...alerts };
  }
  return stored;
}
