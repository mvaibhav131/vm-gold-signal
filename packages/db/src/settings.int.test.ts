import { engineStateSchema, settingsSchema } from '@vmgs/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, createPool } from './pool';
import { defaultSettingRows, seedDefaultSettings } from './settings';
import { query, type TestDatabase } from '../test/database';
import { migratedDatabase } from '../test/setup';

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
});

afterAll(async () => {
  await database.drop();
});

async function withDb<T>(run: (db: ReturnType<typeof createDb>) => Promise<T>): Promise<T> {
  const pool = createPool(database.url, { max: 2 });
  const db = createDb(pool);
  try {
    return await run(db);
  } finally {
    await db.destroy();
  }
}

describe('seedDefaultSettings', () => {
  it('writes every default key into a fresh database', async () => {
    const inserted = await withDb((db) => seedDefaultSettings(db));
    expect(inserted).toEqual(
      defaultSettingRows()
        .map((r) => r.key)
        .sort(),
    );
  });

  it('stores values that the shared schemas accept', async () => {
    const rows = await query<{ key: string; value: unknown }>(
      database.url,
      'SELECT key, value FROM app_settings',
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const { engine, ...settings } = byKey;
    expect(settingsSchema.safeParse(settings).success).toBe(true);
    expect(engineStateSchema.safeParse(engine).success).toBe(true);
  });

  it('is a no-op the second time', async () => {
    expect(await withDb((db) => seedDefaultSettings(db))).toEqual([]);
    expect(await query(database.url, 'SELECT key FROM app_settings')).toHaveLength(7);
  });

  it('never overwrites a value the owner changed', async () => {
    await query(
      database.url,
      `UPDATE app_settings SET value = '"UTC"'::jsonb WHERE key = 'displayTz'`,
    );
    await withDb((db) => seedDefaultSettings(db));
    const rows = await query<{ value: unknown }>(
      database.url,
      "SELECT value FROM app_settings WHERE key = 'displayTz'",
    );
    expect(rows[0]?.value).toBe('UTC');
  });

  it('fills in a key that was removed and leaves the others alone', async () => {
    await query(database.url, "DELETE FROM app_settings WHERE key = 'locale'");
    expect(await withDb((db) => seedDefaultSettings(db))).toEqual(['locale']);
    const rows = await query<{ value: unknown }>(
      database.url,
      "SELECT value FROM app_settings WHERE key = 'displayTz'",
    );
    expect(rows[0]?.value).toBe('UTC');
  });
});
