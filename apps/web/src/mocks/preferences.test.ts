import { NEWS_TOPICS, STRATEGY_KEYS } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import {
  CURRENT_SESSION_ID,
  PREFERENCES_KEY,
  applySettingsPatch,
  defaultPreferences,
  defaultSettings,
  loadPreferences,
  savePreferences,
  sessionsAt,
} from './preferences';

const HOUR = 3_600_000;
const DAY = 86_400_000;

function storage(initial?: string) {
  const items = new Map<string, string>(initial === undefined ? [] : [[PREFERENCES_KEY, initial]]);
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
}

describe('the default settings', () => {
  it('show times in IST in English, alert on A, B and C only, and warn instead of block', () => {
    const settings = defaultSettings();
    expect(settings.displayTz).toBe('Asia/Kolkata');
    expect(settings.locale).toBe('en');
    expect(STRATEGY_KEYS.filter((key) => settings.strategyAlerts[key] === 'on')).toEqual([
      'trend_pullback',
      'sweep_reversal',
      'squeeze_retest',
    ]);
    expect(Object.values(settings.advisoryGates)).toEqual(['warn', 'warn', 'warn', 'warn']);
    expect(settings.alerts.telegram.enabled).toBe(true);
    expect(settings.alerts.webpush.enabled).toBe(false);
    expect(settings.newsAlerts.minImpact).toBe('HIGH');
    expect(NEWS_TOPICS.every((topic) => settings.newsAlerts.topics[topic] === 'on')).toBe(true);
    expect(settings.newsAlerts.marketMoves).toBe('on');
  });
});

describe('a settings patch', () => {
  const base = defaultSettings();

  it('changes only what is sent', () => {
    const next = applySettingsPatch(base, { locale: 'hinglish' });
    expect(next).toEqual({ ...base, locale: 'hinglish' });
  });

  it('does not change the settings it was given', () => {
    const before = JSON.stringify(base);
    applySettingsPatch(base, {
      displayTz: 'UTC',
      alerts: { telegram: { enabled: false } },
      strategyAlerts: { trend_pullback: 'off' },
    });
    expect(JSON.stringify(base)).toBe(before);
  });

  it('changes one value inside Telegram and Web Push and leaves the others', () => {
    const next = applySettingsPatch(base, {
      alerts: { telegram: { minGrade: 'Strong' }, webpush: { enabled: true } },
    });
    expect(next.alerts.telegram).toEqual({ ...base.alerts.telegram, minGrade: 'Strong' });
    expect(next.alerts.webpush).toEqual({ enabled: true, minGrade: 'Strong' });
  });

  it('replaces the list of alert kinds as a whole', () => {
    const next = applySettingsPatch(base, { alerts: { telegram: { kinds: ['SIGNAL_NEW'] } } });
    expect(next.alerts.telegram.kinds).toEqual(['SIGNAL_NEW']);
    // a list that repeats a kind is not valid settings
    expect(() =>
      applySettingsPatch(base, { alerts: { telegram: { kinds: ['SIGNAL_NEW', 'SIGNAL_NEW'] } } }),
    ).toThrow();
  });

  it('changes one advisory flag, one strategy and one topic at a time', () => {
    const next = applySettingsPatch(base, {
      advisoryGates: { rollover: 'block' },
      strategyAlerts: { pattern_breakout: 'on' },
      newsAlerts: { topics: { RISK_OFF: 'off' } },
    });
    expect(next.advisoryGates).toEqual({ ...base.advisoryGates, rollover: 'block' });
    expect(next.strategyAlerts).toEqual({ ...base.strategyAlerts, pattern_breakout: 'on' });
    expect(next.newsAlerts.topics).toEqual({ ...base.newsAlerts.topics, RISK_OFF: 'off' });
    expect(next.newsAlerts.minImpact).toBe('HIGH');
  });

  it('changes the minimum impact and the market-move switch of the news alerts', () => {
    const next = applySettingsPatch(base, {
      newsAlerts: { minImpact: 'MEDIUM', marketMoves: 'off' },
    });
    expect(next.newsAlerts).toEqual({
      ...base.newsAlerts,
      minImpact: 'MEDIUM',
      marketMoves: 'off',
    });
  });

  it('refuses a time zone that is not a name', () => {
    expect(() => applySettingsPatch(base, { displayTz: '+05:30' })).toThrow();
    expect(applySettingsPatch(base, { displayTz: 'America/New_York' }).displayTz).toBe(
      'America/New_York',
    );
  });
});

describe('the saved preferences', () => {
  it('start with the default settings, every strategy enabled, the preview password and no second step', () => {
    const prefs = defaultPreferences('preview');
    expect(prefs.settings).toEqual(defaultSettings());
    expect(Object.values(prefs.enabled)).toEqual([true, true, true, true, true]);
    expect([prefs.password, prefs.totpEnabled, prefs.revokedSessions]).toEqual([
      'preview',
      false,
      [],
    ]);
  });

  it('are what was saved, when the page is loaded again', () => {
    const store = storage();
    const prefs = {
      ...defaultPreferences('preview'),
      password: 'a-new-password',
      totpEnabled: true,
      revokedSessions: ['sess-phone'],
    };
    savePreferences(store, prefs);
    expect(loadPreferences(store, 'preview')).toEqual(prefs);
  });

  it('are the defaults when nothing is saved, when what is saved is not JSON and when it is the wrong shape', () => {
    const defaults = defaultPreferences('preview');
    expect(loadPreferences(storage(), 'preview')).toEqual(defaults);
    expect(loadPreferences(storage('{not json'), 'preview')).toEqual(defaults);
    expect(loadPreferences(storage('{"settings":{}}'), 'preview')).toEqual(defaults);
    expect(loadPreferences(storage('null'), 'preview')).toEqual(defaults);
    // an unknown field is not accepted either: a saved value of an older version cannot slip in
    const extra = JSON.stringify({ ...defaults, admin: true });
    expect(loadPreferences(storage(extra), 'preview')).toEqual(defaults);
  });
});

describe('sessions', () => {
  const NOW = Date.parse('2026-10-23T12:00:00Z');
  const expires = new Date(NOW + 9 * HOUR).toISOString();

  it('are this one first, which began 12 hours before it ends, and two other devices', () => {
    const { items } = sessionsAt(NOW, expires, []);
    expect(items.map((s) => [s.id, s.current])).toEqual([
      [CURRENT_SESSION_ID, true],
      ['sess-phone', false],
      ['sess-laptop', false],
    ]);
    expect(items[0]).toMatchObject({
      createdAt: new Date(NOW - 3 * HOUR).toISOString(),
      lastSeenAt: new Date(NOW).toISOString(),
      expiresAt: expires,
    });
    // the other devices are still valid
    for (const session of items.slice(1))
      expect(Date.parse(session.expiresAt)).toBeGreaterThan(NOW);
    expect(Date.parse(items[2]?.createdAt ?? '')).toBe(NOW - 6 * DAY);
  });

  it('are gone once they are revoked', () => {
    expect(sessionsAt(NOW, expires, ['sess-phone']).items.map((s) => s.id)).toEqual([
      CURRENT_SESSION_ID,
      'sess-laptop',
    ]);
    expect(sessionsAt(NOW, expires, ['sess-phone', 'sess-laptop']).items).toHaveLength(1);
    expect(sessionsAt(NOW, expires, ['nobody']).items).toHaveLength(3);
  });
});
