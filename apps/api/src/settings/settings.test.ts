import { describe, expect, it } from 'vitest';

import { defaultSettings } from '@vmgs/config';
import { settingsSchema, type Settings, type SettingsPatch } from '@vmgs/contracts';

import { makeHarness, type Clock } from '../testing/harness';
import {
  assembleSettings,
  changedKeys,
  mergeSettings,
  SETTING_KEYS,
  StoredSettingsError,
} from './merge';
import { registerSettingsRoutes } from './routes';
import { SettingsConflictError, type SettingsStore } from './store';

const SETTINGS = '/api/v1/settings';

describe('mergeSettings', () => {
  const base = (): Settings => defaultSettings();

  it('replaces a value that is sent and keeps the rest', () => {
    const merged = mergeSettings(base(), { displayTz: 'Europe/London', locale: 'hinglish' });
    expect(merged).toEqual({ ...base(), displayTz: 'Europe/London', locale: 'hinglish' });
  });

  it('merges the objects one level at a time', () => {
    const merged = mergeSettings(base(), {
      alerts: { telegram: { minGrade: 'Strong' }, webpush: { enabled: true } },
      advisoryGates: { nearLevel: 'block' },
      strategyAlerts: { trend_pullback: 'off' },
      newsAlerts: { minImpact: 'LOW', topics: { RISK_OFF: 'off' }, marketMoves: 'off' },
    });
    const expected = base();
    expected.alerts.telegram.minGrade = 'Strong';
    expected.alerts.webpush.enabled = true;
    expected.advisoryGates.nearLevel = 'block';
    expected.strategyAlerts.trend_pullback = 'off';
    expected.newsAlerts = {
      minImpact: 'LOW',
      topics: { ...expected.newsAlerts.topics, RISK_OFF: 'off' },
      marketMoves: 'off',
    };
    expect(merged).toEqual(expected);
  });

  it('replaces the list of alert kinds as a whole, not by adding to it', () => {
    const merged = mergeSettings(base(), { alerts: { telegram: { kinds: ['SIGNAL_NEW'] } } });
    expect(merged.alerts.telegram.kinds).toEqual(['SIGNAL_NEW']);
    const empty = mergeSettings(base(), { alerts: { telegram: { kinds: [] } } });
    expect(empty.alerts.telegram.kinds).toEqual([]);
  });

  it('does not touch what it was given', () => {
    const current = base();
    const copy = structuredClone(current);
    const patch: SettingsPatch = {
      alerts: { telegram: { kinds: ['TEST'] } },
      strategyAlerts: { sweep_reversal: 'off' },
    };
    const patchCopy = structuredClone(patch);
    mergeSettings(current, patch);
    expect(current).toEqual(copy);
    expect(patch).toEqual(patchCopy);
  });

  it('gives the same settings for a patch of empty parts', () => {
    expect(
      mergeSettings(base(), { alerts: {}, newsAlerts: { topics: {} }, strategyAlerts: {} }),
    ).toEqual(base());
  });

  it('leaves a value alone that is sent as undefined', () => {
    const patch = { alerts: { telegram: { enabled: undefined } } } as SettingsPatch;
    expect(mergeSettings(base(), patch)).toEqual(base());
  });
});

describe('changedKeys', () => {
  it('names the keys whose value is not the same, and only those', () => {
    const before = defaultSettings();
    const after = mergeSettings(before, {
      alerts: { webpush: { enabled: true } },
      locale: 'hinglish',
    });
    expect(changedKeys(before, after)).toEqual(['locale', 'alerts']);
    expect(changedKeys(before, structuredClone(before))).toEqual([]);
  });

  it('sees a list in another order as a change, and an object with its keys in another order as none', () => {
    const before = defaultSettings();
    const reordered = structuredClone(before);
    reordered.alerts.telegram.kinds = [...reordered.alerts.telegram.kinds].reverse();
    expect(changedKeys(before, reordered)).toEqual(['alerts']);
    const shuffled = {
      ...before,
      strategyAlerts: Object.fromEntries(Object.entries(before.strategyAlerts).reverse()),
    };
    expect(changedKeys(before, shuffled as Settings)).toEqual([]);
  });
});

describe('assembleSettings', () => {
  it('uses the default of a key that has no row, and ignores rows that are not settings', () => {
    const settings = assembleSettings([
      { key: 'locale', value: 'hinglish' },
      { key: 'engine', value: { status: 'PAUSED' } },
      { key: 'telegramLink', value: { hash: 'x' } },
    ]);
    expect(settings).toEqual({ ...defaultSettings(), locale: 'hinglish' });
    expect(assembleSettings([])).toEqual(defaultSettings());
  });

  it('lists the six keys, in the order of the contract', () => {
    expect(SETTING_KEYS).toEqual(Object.keys(settingsSchema.shape));
    expect(SETTING_KEYS).toHaveLength(6);
  });

  it('fails, naming the key and never the value, when a row is not valid', () => {
    expect.assertions(3);
    try {
      assembleSettings([{ key: 'alerts', value: { hidden: 'value-that-must-not-leak' } }]);
    } catch (error) {
      expect(error).toBeInstanceOf(StoredSettingsError);
      expect((error as Error).message).toContain('alerts');
      expect((error as Error).message).not.toContain('value-that-must-not-leak');
    }
  });
});

class FakeStore implements SettingsStore {
  current: Settings = defaultSettings();
  patches: { patch: SettingsPatch; now: number }[] = [];
  failure: Error | null = null;

  read(): Promise<Settings> {
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(this.current);
  }

  patch(patch: SettingsPatch, now: number): Promise<Settings> {
    this.patches.push({ patch, now });
    if (this.failure !== null) return Promise.reject(this.failure);
    this.current = mergeSettings(this.current, patch);
    return Promise.resolve(this.current);
  }
}

async function harness(store: FakeStore) {
  let clock: Clock | null = null;
  const h = await makeHarness({
    routes: (app, c) => {
      clock = c;
      registerSettingsRoutes(app, { store, now: () => c.now });
    },
  });
  return { h, cookie: await h.login(), clock: clock as unknown as Clock };
}

describe('the settings routes', () => {
  it('answer the whole settings, as the contract says', async () => {
    const store = new FakeStore();
    const { h, cookie } = await harness(store);
    const reply = await h.send({ url: SETTINGS, cookie });
    expect(reply.status).toBe(200);
    expect(settingsSchema.parse(reply.json())).toEqual(defaultSettings());
    expect(reply.res.headers['cache-control']).toBe('no-store');
  });

  it('apply a patch with the time of the clock and answer the whole settings after it', async () => {
    const store = new FakeStore();
    const { h, cookie, clock } = await harness(store);
    const reply = await h.send({
      method: 'PATCH',
      url: SETTINGS,
      cookie,
      body: {
        alerts: { telegram: { minGrade: 'Strong' } },
        strategyAlerts: { trend_pullback: 'off' },
      },
    });
    expect(reply.status).toBe(200);
    const expected = defaultSettings();
    expected.alerts.telegram.minGrade = 'Strong';
    expected.strategyAlerts.trend_pullback = 'off';
    expect(settingsSchema.parse(reply.json())).toEqual(expected);
    expect(store.patches).toEqual([
      {
        patch: {
          alerts: { telegram: { minGrade: 'Strong' } },
          strategyAlerts: { trend_pullback: 'off' },
        },
        now: clock.now,
      },
    ]);
  });

  it('refuse a body that does not fit before the store sees it, and name fields, not values', async () => {
    const store = new FakeStore();
    const { h, cookie } = await harness(store);
    const bad: unknown[] = [
      {},
      { locale: 'fr-secret-value' },
      { engine: { status: 'PAUSED' } },
      { alerts: { telegram: { kinds: ['TEST', 'TEST'] } } },
      { strategyAlerts: { nope: 'on' } },
    ];
    for (const body of bad) {
      const reply = await h.send({ method: 'PATCH', url: SETTINGS, cookie, body });
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(reply.json()).toMatchObject({ code: 'invalid_request' });
      expect(reply.res.body).not.toContain('fr-secret-value');
    }
    expect(store.patches).toEqual([]);
  });

  it('need a session and, for a change, the Origin and the header of the site', async () => {
    const store = new FakeStore();
    const { h, cookie } = await harness(store);
    expect((await h.send({ url: SETTINGS })).status).toBe(401);
    expect((await h.send({ method: 'PATCH', url: SETTINGS, body: { locale: 'en' } })).status).toBe(
      401,
    );
    const crossSite = await h.send({
      method: 'PATCH',
      url: SETTINGS,
      cookie,
      body: { locale: 'hinglish' },
      sameSite: false,
    });
    expect(crossSite.status).toBe(403);
    expect(store.patches).toEqual([]);
  });

  it('answer 409 conflict, and say that nothing was saved, for a change that lost a race', async () => {
    const store = new FakeStore();
    store.failure = new SettingsConflictError();
    const { h, cookie } = await harness(store);
    const reply = await h.send({
      method: 'PATCH',
      url: SETTINGS,
      cookie,
      body: { locale: 'hinglish' },
    });
    expect(reply.status).toBe(409);
    expect(reply.json()).toMatchObject({ code: 'conflict' });
    expect(reply.res.body).toContain('nothing was saved');
  });

  it('answer a failure of the store as a plain 500 that says nothing of it', async () => {
    const store = new FakeStore();
    store.failure = new StoredSettingsError(['alerts']);
    const { h, cookie } = await harness(store);
    for (const reply of [
      await h.send({ url: SETTINGS, cookie }),
      await h.send({ method: 'PATCH', url: SETTINGS, cookie, body: { locale: 'en' } }),
    ]) {
      expect(reply.status).toBe(500);
      expect(reply.json()).toMatchObject({ code: 'server_error' });
      expect(reply.res.body).not.toContain('alerts');
    }
  });
});
