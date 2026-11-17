import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';

import { defaultSettings } from '@vmgs/config';
import { settingsSchema, type Settings, type SettingsPatch } from '@vmgs/contracts';
import { NOTIFICATION_KINDS } from '@vmgs/core';

import { startPgApi, type PgApi } from '../testing/pgApi';
import { T0 } from '../testing/harness';
import { SETTING_KEYS } from './merge';
import { PostgresSettingsStore, SettingsConflictError } from './store';

const OLD = Date.UTC(2020, 0, 1);
let api: PgApi;

beforeAll(async () => {
  api = await startPgApi();
});

afterAll(async () => {
  await api.close();
});

beforeEach(async () => {
  api.clock.now = T0;
  await api.admin.query('DELETE FROM app_settings');
});

interface Stored {
  readonly value: unknown;
  readonly updatedAt: number;
}

async function stored(): Promise<Map<string, Stored>> {
  const { rows } = await api.admin.query<{ key: string; value: unknown; updated_at: Date }>(
    'SELECT key, value, updated_at FROM app_settings',
  );
  return new Map(
    rows.map((row) => [row.key, { value: row.value, updatedAt: row.updated_at.getTime() }]),
  );
}

/** Every settings key as a row with the default value and an old `updated_at`: a write shows as a new time. */
async function seedAll(overrides: Partial<Settings> = {}): Promise<Settings> {
  const settings: Settings = { ...defaultSettings(), ...overrides };
  for (const key of SETTING_KEYS) {
    await api.admin.query(
      'INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, $3)',
      [key, JSON.stringify(settings[key]), new Date(OLD)],
    );
  }
  return settings;
}

async function getSettings(): Promise<Settings> {
  const reply = await api.send({ url: '/api/v1/settings' });
  expect(reply.status, reply.body).toBe(200);
  return settingsSchema.parse(reply.json());
}

async function patch(body: unknown) {
  return api.send({ method: 'PATCH', url: '/api/v1/settings', body });
}

describe('GET /settings on Postgres', () => {
  it('answers the defaults when there is no row at all', async () => {
    expect(await getSettings()).toEqual(defaultSettings());
  });

  it('answers the stored row of a key and the default of a key without one', async () => {
    await api.admin.query(
      `INSERT INTO app_settings (key, value) VALUES ('locale', '"hinglish"'::jsonb)`,
    );
    await api.admin.query(
      `INSERT INTO app_settings (key, value) VALUES ('displayTz', '"America/New_York"'::jsonb)`,
    );
    expect(await getSettings()).toEqual({
      ...defaultSettings(),
      locale: 'hinglish',
      displayTz: 'America/New_York',
    });
  });

  it('never shows a key that is not a setting', async () => {
    for (const key of [
      'engine',
      'telegramLink',
      'telegramChat',
      'tickRetentionDays',
      'engineState',
    ]) {
      await api.admin.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, '{"secret":"x"}'::jsonb)`,
        [key],
      );
    }
    const reply = await api.send({ url: '/api/v1/settings' });
    expect(Object.keys(reply.json() as object).sort()).toEqual([...SETTING_KEYS].sort());
    expect(reply.body).not.toContain('secret');
  });

  it('is refused without a session', async () => {
    expect((await api.anonymous('/api/v1/settings')).status).toBe(401);
  });

  it('is an error, and not a guess, when a stored row is not valid', async () => {
    await api.admin.query(
      `INSERT INTO app_settings (key, value) VALUES ('alerts', '{"oops": 1}'::jsonb)`,
    );
    const reply = await api.send({ url: '/api/v1/settings' });
    expect(reply.status).toBe(500);
    expect(reply.body).not.toContain('oops');
    expect(reply.json()).toMatchObject({ code: 'server_error' });
  });
});

describe('PATCH /settings on Postgres', () => {
  it('merges one level at a time, replaces a list as a whole, and answers with the whole settings', async () => {
    await seedAll();
    const reply = await patch({
      alerts: {
        telegram: { minGrade: 'Strong', kinds: ['SIGNAL_NEW', 'TEST'] },
        webpush: { enabled: true },
      },
      advisoryGates: { rollover: 'block' },
      strategyAlerts: { trend_pullback: 'off' },
      newsAlerts: { minImpact: 'MEDIUM', topics: { FED_RATES: 'off' } },
    });
    expect(reply.status, reply.body).toBe(200);
    const expected = defaultSettings();
    expected.alerts.telegram = { enabled: true, minGrade: 'Strong', kinds: ['SIGNAL_NEW', 'TEST'] };
    expected.alerts.webpush = { enabled: true, minGrade: 'Moderate' };
    expected.advisoryGates.rollover = 'block';
    expected.strategyAlerts.trend_pullback = 'off';
    expected.newsAlerts.minImpact = 'MEDIUM';
    expected.newsAlerts.topics.FED_RATES = 'off';
    expect(settingsSchema.parse(reply.json())).toEqual(expected);
    expect(await getSettings()).toEqual(expected);
  });

  it('stores whole, valid values: what the worker reads, one row for each key', async () => {
    await seedAll();
    expect((await patch({ strategyAlerts: { sweep_reversal: 'off' } })).status).toBe(200);
    const rows = await stored();
    for (const key of SETTING_KEYS) {
      expect(() => settingsSchema.shape[key].parse(rows.get(key)?.value), key).not.toThrow();
    }
    const strategyAlerts = rows.get('strategyAlerts')?.value as Record<string, string>;
    expect(Object.keys(strategyAlerts).sort()).toEqual(
      Object.keys(defaultSettings().strategyAlerts).sort(),
    );
    expect(strategyAlerts.sweep_reversal).toBe('off');
  });

  it('writes only the keys that changed, with the time of the change', async () => {
    await seedAll();
    const reply = await patch({
      locale: 'hinglish',
      displayTz: 'Asia/Kolkata',
      advisoryGates: { rollover: 'warn' },
    });
    expect(reply.status).toBe(200);
    const rows = await stored();
    expect(rows.get('locale')?.value).toBe('hinglish');
    expect(rows.get('locale')?.updatedAt).toBe(T0);
    // sent, but equal to what was stored: not written
    for (const key of ['displayTz', 'advisoryGates', 'alerts', 'strategyAlerts', 'newsAlerts']) {
      expect(rows.get(key)?.updatedAt, key).toBe(OLD);
    }
  });

  it('writes nothing for a patch that changes nothing, and creates no row for a key it does not change', async () => {
    expect((await patch({ locale: 'en', alerts: {} })).status).toBe(200);
    expect((await stored()).size).toBe(0);
    expect((await patch({ displayTz: 'Europe/London' })).status).toBe(200);
    expect([...(await stored()).keys()]).toEqual(['displayTz']);
  });

  it('never reads or changes a key that is not a setting', async () => {
    const others: [string, unknown][] = [
      ['engine', { status: 'PAUSED' }],
      ['telegramLink', { hash: 'h', expiresAt: 1, attempts: 0 }],
      ['telegramChat', { id: 1 }],
      ['tickRetentionDays', 7],
    ];
    for (const [key, value] of others) {
      await api.admin.query(
        'INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, $3)',
        [key, JSON.stringify(value), new Date(OLD)],
      );
    }
    expect(
      (await patch({ locale: 'hinglish', strategyAlerts: { trend_pullback: 'off' } })).status,
    ).toBe(200);
    const rows = await stored();
    for (const [key, value] of others) {
      expect(rows.get(key), key).toEqual({ value, updatedAt: OLD });
    }
  });

  it('refuses a body that does not fit and writes nothing', async () => {
    const before = await seedAll();
    const bad: unknown[] = [
      {},
      { engine: { status: 'PAUSED' } },
      { locale: 'fr' },
      { displayTz: '+05:30' },
      { displayTz: 'Not/AZone' },
      { alerts: { telegram: { kinds: ['TEST', 'TEST'] } } },
      { alerts: { telegram: { kinds: ['NOPE'] } } },
      { alerts: { telegram: { minGrade: 'Great' } } },
      { alerts: { sms: { enabled: true } } },
      { strategyAlerts: { bogus: 'on' } },
      { strategyAlerts: { trend_pullback: 'maybe' } },
      { newsAlerts: { topics: { NOPE: 'on' } } },
      { advisoryGates: { rollover: 'ignore' } },
      // a good change next to a bad one: none of the two is written
      { locale: 'hinglish', advisoryGates: { rollover: 'ignore' } },
      null,
      [],
    ];
    for (const body of bad) {
      const reply = await patch(body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(reply.json(), JSON.stringify(body)).toMatchObject({ code: 'invalid_request' });
    }
    const rows = await stored();
    for (const key of SETTING_KEYS) {
      expect(rows.get(key), key).toEqual({ value: before[key], updatedAt: OLD });
    }
  });

  it('is atomic: a write that fails takes back the writes before it', async () => {
    await seedAll();
    let writes = 0;
    const failing = new PostgresSettingsStore(
      proxied(api.pool, (sql) => {
        if (isWrite(sql)) {
          writes += 1;
          if (writes === 2) throw new Error('the disk is full');
        }
      }),
    );
    const patchOf: SettingsPatch = {
      displayTz: 'Europe/London',
      locale: 'hinglish',
      advisoryGates: { rollover: 'block' },
    };
    await expect(failing.patch(patchOf, T0)).rejects.toThrow('the disk is full');
    expect(writes).toBe(2);
    const rows = await stored();
    for (const key of SETTING_KEYS) expect(rows.get(key)?.updatedAt, key).toBe(OLD);
    expect(rows.get('displayTz')?.value).toBe('Asia/Kolkata');
    // and the store is still usable afterwards: the connection was released and the lock let go
    writes = 10;
    await failing.patch(patchOf, T0);
    expect((await stored()).get('locale')?.value).toBe('hinglish');
  });

  it('is atomic for keys that have no row yet, too', async () => {
    let writes = 0;
    const failing = new PostgresSettingsStore(
      proxied(api.pool, (sql) => {
        if (isWrite(sql)) {
          writes += 1;
          if (writes === 3) throw new Error('the disk is full');
        }
      }),
    );
    await expect(
      failing.patch(
        { displayTz: 'Europe/London', locale: 'hinglish', advisoryGates: { rollover: 'block' } },
        T0,
      ),
    ).rejects.toThrow('the disk is full');
    expect((await stored()).size).toBe(0);
  });

  it('does not lose either of two changes that arrive together, for rows that exist', async () => {
    await seedAll();
    const store = new PostgresSettingsStore(proxied(api.pool, slowWrite(150)));
    await Promise.all([
      store.patch({ alerts: { telegram: { minGrade: 'Strong' } } }, T0),
      store.patch({ alerts: { telegram: { enabled: false } } }, T0),
      store.patch({ alerts: { webpush: { enabled: true } } }, T0),
    ]);
    const after = await getSettings();
    expect(after.alerts.telegram).toMatchObject({ minGrade: 'Strong', enabled: false });
    expect(after.alerts.webpush.enabled).toBe(true);
  });

  it('does not lose either of two changes that arrive together, for rows that do not exist yet', async () => {
    const store = new PostgresSettingsStore(proxied(api.pool, slowWrite(150)));
    await Promise.all([
      store.patch({ strategyAlerts: { trend_pullback: 'off' } }, T0),
      store.patch({ strategyAlerts: { sweep_reversal: 'off' } }, T0),
      store.patch({ newsAlerts: { topics: { FED_RATES: 'off' } } }, T0),
      store.patch({ newsAlerts: { marketMoves: 'off' } }, T0),
    ]);
    const after = await getSettings();
    expect(after.strategyAlerts.trend_pullback).toBe('off');
    expect(after.strategyAlerts.sweep_reversal).toBe('off');
    expect(after.newsAlerts.topics.FED_RATES).toBe('off');
    expect(after.newsAlerts.marketMoves).toBe('off');
  });

  it('makes changes that arrive together wait for each other instead of trying again', async () => {
    let rollbacks = 0;
    const store = new PostgresSettingsStore(
      proxied(api.pool, async (sql) => {
        if (sql === 'ROLLBACK') rollbacks += 1;
        if (isWrite(sql)) await new Promise((resolve) => setTimeout(resolve, 60));
      }),
    );
    const results = await Promise.all(
      [
        'trend_pullback',
        'sweep_reversal',
        'squeeze_retest',
        'trendline_retest',
        'pattern_breakout',
        'hourly_trend',
      ].map((key) => store.patch({ strategyAlerts: { [key]: 'off' } }, T0)),
    );
    expect(results).toHaveLength(6);
    expect(rollbacks).toBe(0);
    expect(Object.values((await getSettings()).strategyAlerts)).toEqual(
      Array.from({ length: 6 }, () => 'off'),
    );
  });

  /** What `PATCH /strategies/:key` does to the same row: one statement that merges into the object that is stored. */
  const STRATEGY_MERGE = `UPDATE app_settings SET value = value || '{"trend_pullback":"off"}'::jsonb WHERE key = 'strategyAlerts'`;

  it('does not lose a change of another writer that does not know the lock, for a row that exists', async () => {
    await seedAll();
    const others: Promise<unknown>[] = [];
    const store = new PostgresSettingsStore(
      proxied(api.pool, async (sql) => {
        if (sql.startsWith('UPDATE app_settings') && others.length === 0) {
          // the other writer comes after this change has read the row and before it has written: it has to wait for it
          others.push(api.admin.query(STRATEGY_MERGE));
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }),
    );
    await store.patch({ strategyAlerts: { sweep_reversal: 'off' } }, T0);
    await Promise.all(others);
    const after = await getSettings();
    expect(after.strategyAlerts).toMatchObject({ trend_pullback: 'off', sweep_reversal: 'off' });
  });

  it('does not overwrite a row that another writer added after the read, but merges onto it', async () => {
    let added = false;
    const store = new PostgresSettingsStore(
      proxied(api.pool, async (sql) => {
        if (sql.startsWith('INSERT INTO app_settings') && !added) {
          added = true;
          const theirs = { ...defaultSettings().strategyAlerts, trend_pullback: 'off' };
          await api.admin.query(
            `INSERT INTO app_settings (key, value) VALUES ('strategyAlerts', $1::jsonb)`,
            [JSON.stringify(theirs)],
          );
        }
      }),
    );
    const after = await store.patch({ strategyAlerts: { sweep_reversal: 'off' } }, T0);
    expect(after.strategyAlerts).toMatchObject({ trend_pullback: 'off', sweep_reversal: 'off' });
    expect((await getSettings()).strategyAlerts).toMatchObject({
      trend_pullback: 'off',
      sweep_reversal: 'off',
    });
  });

  it('gives up with a conflict, and writes nothing, when the row keeps being taken from under it', async () => {
    const store = new PostgresSettingsStore(
      proxied(api.pool, async (sql) => {
        if (sql.startsWith('INSERT INTO app_settings')) {
          await api.admin.query(
            `INSERT INTO app_settings (key, value) VALUES ('strategyAlerts', $1::jsonb) ON CONFLICT DO NOTHING`,
            [JSON.stringify(defaultSettings().strategyAlerts)],
          );
        }
        if (sql === 'ROLLBACK')
          await api.admin.query(`DELETE FROM app_settings WHERE key = 'strategyAlerts'`);
      }),
    );
    await expect(
      store.patch({ strategyAlerts: { sweep_reversal: 'off' } }, T0),
    ).rejects.toBeInstanceOf(SettingsConflictError);
    expect((await getSettings()).strategyAlerts.sweep_reversal).toBe('on');
    expect((await stored()).size).toBe(0);
  });

  it('keeps every change of a crowd of parallel requests', async () => {
    const changes: SettingsPatch[] = [
      { alerts: { telegram: { minGrade: 'Very strong' } } },
      { alerts: { telegram: { enabled: false } } },
      { alerts: { telegram: { kinds: [...NOTIFICATION_KINDS].slice(0, 3) } } },
      { alerts: { webpush: { minGrade: 'Strong' } } },
      { alerts: { webpush: { enabled: true } } },
      { advisoryGates: { newsWindow: 'block' } },
      { advisoryGates: { offHours: 'block' } },
      { strategyAlerts: { trend_pullback: 'off' } },
      { strategyAlerts: { squeeze_retest: 'off' } },
      { newsAlerts: { topics: { FED_RATES: 'off' } } },
      { newsAlerts: { topics: { GEOPOLITICS_WAR: 'off' } } },
      { locale: 'hinglish' },
    ];
    const replies = await Promise.all(changes.map((body) => patch(body)));
    expect(replies.map((reply) => reply.status)).toEqual(changes.map(() => 200));
    const after = await getSettings();
    expect(after.alerts.telegram).toEqual({
      enabled: false,
      minGrade: 'Very strong',
      kinds: [...NOTIFICATION_KINDS].slice(0, 3),
    });
    expect(after.alerts.webpush).toEqual({ enabled: true, minGrade: 'Strong' });
    expect(after.advisoryGates).toMatchObject({ newsWindow: 'block', offHours: 'block' });
    expect(after.strategyAlerts).toMatchObject({ trend_pullback: 'off', squeeze_retest: 'off' });
    expect(after.newsAlerts.topics).toMatchObject({ FED_RATES: 'off', GEOPOLITICS_WAR: 'off' });
    expect(after.locale).toBe('hinglish');
  });

  it('is an error and writes nothing when a stored row is not valid', async () => {
    await seedAll();
    await api.admin.query(
      `UPDATE app_settings SET value = '{"oops": 1}'::jsonb WHERE key = 'alerts'`,
    );
    const reply = await patch({ locale: 'hinglish' });
    expect(reply.status).toBe(500);
    expect(reply.body).not.toContain('oops');
    expect((await stored()).get('locale')?.updatedAt).toBe(OLD);
  });

  it('uses nothing the role of the API may not do: no permission is denied', async () => {
    const reply = await patch({
      displayTz: 'Europe/Paris',
      strategyAlerts: { trend_pullback: 'off' },
    });
    expect(reply.status, reply.body).toBe(200);
  });
});

type Hook = (sql: string) => Promise<void> | void;

/** A pool whose connections run `before` ahead of every statement: it can slow or fail a step on purpose. */
function proxied(pool: Pool, before: Hook): Pick<Pool, 'query' | 'connect'> {
  const connect = async (): Promise<PoolClient> => {
    const client = await pool.connect();
    return new Proxy(client, {
      get(target, property) {
        if (property === 'query') {
          return async (text: unknown, values?: unknown): Promise<unknown> => {
            if (typeof text === 'string') await before(text);
            return (target.query as (...args: unknown[]) => Promise<unknown>)(text, values);
          };
        }
        const member: unknown = Reflect.get(target, property);
        if (typeof member !== 'function') return member;
        const method = member as (...args: unknown[]) => unknown;
        return (...args: unknown[]): unknown => method.apply(target, args);
      },
    });
  };
  return { query: pool.query.bind(pool), connect: connect as Pool['connect'] };
}

const isWrite = (sql: string): boolean =>
  sql.startsWith('INSERT INTO app_settings') || sql.startsWith('UPDATE app_settings');

/** Waits before every write of a setting: a change that read the old state has time to be overtaken by another. */
function slowWrite(ms: number): Hook {
  return async (sql) => {
    if (isWrite(sql)) await new Promise((resolve) => setTimeout(resolve, ms));
  };
}
