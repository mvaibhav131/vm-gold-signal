import {
  sessionsResponseSchema,
  settingsSchema,
  strategyKeySchema,
  type SessionsResponse,
  type Settings,
  type SettingsPatch,
} from '@vmgs/contracts';
import { NEWS_TOPICS, STRATEGY_KEYS, type StrategyKey } from '@vmgs/core';
import { z } from 'zod';

import { mergeSettingsPatch } from '../data/settingsPatch';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Strategies A, B and C alert by default; D and E stay in shadow mode until their backtest report. */
export const ALERTS_ON: readonly StrategyKey[] = [
  'trend_pullback',
  'sweep_reversal',
  'squeeze_retest',
];

export function defaultSettings(): Settings {
  return settingsSchema.parse({
    displayTz: 'Asia/Kolkata',
    locale: 'en',
    alerts: {
      telegram: {
        enabled: true,
        minGrade: 'Moderate',
        kinds: ['SIGNAL_NEW', 'SIGNAL_TP1', 'SIGNAL_CLOSED', 'SIGNAL_CANCELLED', 'SYSTEM_DEGRADED'],
      },
      webpush: { enabled: false, minGrade: 'Strong' },
    },
    advisoryGates: { newsWindow: 'warn', rollover: 'warn', offHours: 'warn', nearLevel: 'warn' },
    strategyAlerts: Object.fromEntries(
      STRATEGY_KEYS.map((key) => [key, ALERTS_ON.includes(key) ? 'on' : 'off']),
    ),
    newsAlerts: {
      minImpact: 'HIGH',
      topics: Object.fromEntries(NEWS_TOPICS.map((topic) => [topic, 'on'])),
      marketMoves: 'on',
    },
  });
}

/**
 * What a `PATCH /settings` does: the values that are sent replace the ones that are stored, the
 * rest stays (the screen uses the same merge to show a change at once). The result is checked
 * against the settings contract.
 */
export function applySettingsPatch(settings: Settings, patch: SettingsPatch): Settings {
  return settingsSchema.parse(mergeSettingsPatch(settings, patch));
}

/** What the preview remembers between page loads: the owner's choices on the System screen. */
const preferencesSchema = z.strictObject({
  settings: settingsSchema,
  enabled: z.record(strategyKeySchema, z.boolean()),
  password: z.string().min(1),
  totpEnabled: z.boolean(),
  revokedSessions: z.array(z.string()),
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const PREFERENCES_KEY = 'vmgs-mock-preferences';

export function defaultPreferences(password: string): Preferences {
  return {
    settings: defaultSettings(),
    enabled: Object.fromEntries(STRATEGY_KEYS.map((key) => [key, true])) as Record<
      StrategyKey,
      boolean
    >,
    password,
    totpEnabled: false,
    revokedSessions: [],
  };
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** The saved choices, or the defaults when there is nothing saved or what is saved is not valid. */
export function loadPreferences(storage: Store, password: string): Preferences {
  const raw = storage.getItem(PREFERENCES_KEY);
  if (raw === null) return defaultPreferences(password);
  try {
    return preferencesSchema.parse(JSON.parse(raw));
  } catch {
    return defaultPreferences(password);
  }
}

export function savePreferences(storage: Store, preferences: Preferences): void {
  storage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
}

export const CURRENT_SESSION_ID = 'sess-current';

/**
 * The sessions of the owner: this one first, then two other devices. A session that was revoked is gone.
 * The real API shows no device name (it stores only hashes), so neither does the preview.
 */
export function sessionsAt(
  nowMs: number,
  currentExpiresAt: string,
  revoked: readonly string[],
): SessionsResponse {
  const iso = (ms: number) => new Date(ms).toISOString();
  const all = [
    {
      id: CURRENT_SESSION_ID,
      createdAt: iso(Date.parse(currentExpiresAt) - 12 * HOUR_MS),
      lastSeenAt: iso(nowMs),
      expiresAt: currentExpiresAt,
      current: true,
    },
    {
      id: 'sess-phone',
      createdAt: iso(nowMs - 2 * DAY_MS),
      lastSeenAt: iso(nowMs - 5 * HOUR_MS),
      expiresAt: iso(nowMs + 7 * HOUR_MS),
      current: false,
    },
    {
      id: 'sess-laptop',
      createdAt: iso(nowMs - 6 * DAY_MS),
      lastSeenAt: iso(nowMs - DAY_MS),
      expiresAt: iso(nowMs + 30 * HOUR_MS),
      current: false,
    },
  ];
  return sessionsResponseSchema.parse({
    items: all.filter((session) => !revoked.includes(session.id)),
  });
}
