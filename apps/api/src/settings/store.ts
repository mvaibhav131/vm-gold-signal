import type { Pool, PoolClient } from 'pg';

import type { Settings, SettingsPatch } from '@vmgs/contracts';

import { assembleSettings, changedKeys, mergeSettings, SETTING_KEYS } from './merge';

export interface SettingsStore {
  read(): Promise<Settings>;
  /** Applies the patch in one transaction and returns the whole settings as they are after it. */
  patch(patch: SettingsPatch, now: number): Promise<Settings>;
}

/** Everything that changes a settings row takes this lock first, so that two changes never both start from the same state. */
export const SETTINGS_LOCK = 'vmgs:app-settings';

/** A change that lost to another writer of the same row more often than it is worth trying again: nothing was written. */
export class SettingsConflictError extends Error {
  constructor() {
    super('the settings were changed by someone else while this change was being worked out');
    this.name = 'SettingsConflictError';
  }
}

const ATTEMPTS = 3;

interface Row {
  readonly key: string;
  readonly value: unknown;
}

export class PostgresSettingsStore implements SettingsStore {
  constructor(private readonly pool: Pick<Pool, 'query' | 'connect'>) {}

  async read(): Promise<Settings> {
    const { rows } = await this.pool.query<Row>(
      'SELECT key, value FROM app_settings WHERE key = ANY($1::text[])',
      [SETTING_KEYS],
    );
    return assembleSettings(rows);
  }

  async patch(patch: SettingsPatch, now: number): Promise<Settings> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const result = await this.tryPatch(patch, now);
      if (result !== null) return result;
    }
    throw new SettingsConflictError();
  }

  /** One transaction; null when a row that was not there has been written by another writer in the meantime. */
  private async tryPatch(patch: SettingsPatch, now: number): Promise<Settings | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // A key without a row cannot be locked as a row, so the change waits on this lock: the second of two changes
      // reads what the first has written, whether the rows exist yet or not.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [SETTINGS_LOCK]);
      const rows = await this.readLocked(client);
      const before = assembleSettings(rows);
      const after = mergeSettings(before, patch);
      const existing = new Set(rows.map((row) => row.key));
      for (const key of changedKeys(before, after)) {
        const value = JSON.stringify(after[key]);
        const written = existing.has(key)
          ? await client.query(
              'UPDATE app_settings SET value = $2::jsonb, updated_at = $3 WHERE key = $1',
              [key, value, new Date(now)],
            )
          : // a writer that does not know the lock may have added the row since the read: it must not be overwritten
            await client.query(
              `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
               ON CONFLICT (key) DO NOTHING`,
              [key, value, new Date(now)],
            );
        if (written.rowCount !== 1) {
          await client.query('ROLLBACK');
          return null;
        }
      }
      await client.query('COMMIT');
      return after;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** The rows are also locked as rows, for a writer that does not know the advisory lock. */
  private async readLocked(client: PoolClient): Promise<Row[]> {
    const { rows } = await client.query<Row>(
      'SELECT key, value FROM app_settings WHERE key = ANY($1::text[]) FOR UPDATE',
      [SETTING_KEYS],
    );
    return rows;
  }
}
