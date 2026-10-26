import type { Pool, PoolClient } from 'pg';

import { defaultSettings } from '@vmgs/config';
import { engineStateSchema, settingsSchema } from '@vmgs/contracts';
import {
  displayOptionsOf,
  enginePausedMessage,
  engineEventKey,
  isPaused,
  pauseIdOf,
  pausedAt,
  systemChannels,
  systemOutboxRows,
  type AlertSettings,
  type StoredEngine,
} from '@vmgs/core';

export type PauseOutcome =
  | { readonly outcome: 'PAUSED'; readonly since: number; readonly until: number | null }
  | { readonly outcome: 'ALREADY_PAUSED'; readonly since: number };

export type ResumeOutcome = 'RESUMED' | 'NOT_PAUSED';

/** The owner's pause of the engine (`app_settings.engine`), the one the worker's decision loop and the Telegram bot read. */
export interface EngineControlStore {
  /** Pauses for `minutes` (null: until the owner resumes). The message of the pause is queued with the state, or not at all. */
  pause(minutes: number | null, at: number): Promise<PauseOutcome>;
  resume(at: number): Promise<ResumeOutcome>;
}

const ENGINE_KEY = 'engine';
const SETTING_KEYS = [
  'displayTz',
  'locale',
  'alerts',
  'advisoryGates',
  'strategyAlerts',
  'newsAlerts',
];

function storedEngineOf(value: unknown): StoredEngine {
  const state = engineStateSchema.parse(value);
  return state.status === 'RUNNING'
    ? { status: 'RUNNING' }
    : {
        status: 'PAUSED',
        since: Date.parse(state.pausedSince),
        until: state.pausedUntil === null ? null : Date.parse(state.pausedUntil),
      };
}

function documentOf(state: StoredEngine): unknown {
  return engineStateSchema.parse(
    state.status === 'RUNNING'
      ? { status: 'RUNNING' }
      : {
          status: 'PAUSED',
          pausedSince: new Date(state.since).toISOString(),
          pausedUntil: state.until === null ? null : new Date(state.until).toISOString(),
        },
  );
}

async function alertSettingsOf(client: PoolClient): Promise<AlertSettings> {
  const { rows } = await client.query<{ key: string; value: unknown }>(
    'SELECT key, value FROM app_settings WHERE key = ANY($1::text[])',
    [SETTING_KEYS],
  );
  const stored: Record<string, unknown> = { ...defaultSettings() };
  for (const row of rows) stored[row.key] = row.value;
  const settings = settingsSchema.parse(stored);
  return {
    displayTz: settings.displayTz,
    locale: settings.locale,
    alerts: settings.alerts,
    strategyAlerts: settings.strategyAlerts,
    newsAlerts: settings.newsAlerts,
  };
}

export class PostgresEngineControlStore implements EngineControlStore {
  constructor(private readonly pool: Pool) {}

  /** Locks the pause row (making it when the database has none yet) for the rest of the transaction. */
  private async lockedState(client: PoolClient, at: number): Promise<StoredEngine> {
    await client.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, '{"status":"RUNNING"}'::jsonb, $2)
       ON CONFLICT (key) DO NOTHING`,
      [ENGINE_KEY, new Date(at)],
    );
    const { rows } = await client.query<{ value: unknown }>(
      'SELECT value FROM app_settings WHERE key = $1 FOR UPDATE',
      [ENGINE_KEY],
    );
    return storedEngineOf(rows[0]?.value);
  }

  private async write(client: PoolClient, state: StoredEngine, at: number): Promise<void> {
    await client.query(
      'UPDATE app_settings SET value = $2::jsonb, updated_at = $3 WHERE key = $1',
      [ENGINE_KEY, JSON.stringify(documentOf(state)), new Date(at)],
    );
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  pause(minutes: number | null, at: number): Promise<PauseOutcome> {
    return this.transaction(async (client) => {
      const current = await this.lockedState(client, at);
      if (isPaused(current, at)) return { outcome: 'ALREADY_PAUSED', since: current.since };
      const next = pausedAt(at, minutes);
      await this.write(client, next, at);

      // the same message the Telegram command sends, to every channel that is on (nobody is looking at a chat reply here)
      const settings = await alertSettingsOf(client);
      const message = enginePausedMessage({ at, until: next.until }, displayOptionsOf(settings));
      const rows = systemOutboxRows(
        message,
        engineEventKey(pauseIdOf(at)),
        systemChannels(settings, 'ENGINE_PAUSED'),
        at,
      );
      for (const row of rows) {
        await client.query(
          `INSERT INTO notification_outbox (event_key, channel, kind, signal_id, payload, next_attempt_at, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $6)
           ON CONFLICT (event_key, channel) DO NOTHING`,
          [
            row.eventKey,
            row.channel,
            row.kind,
            row.signalId,
            JSON.stringify(row.payload),
            new Date(at),
            row.expiresAt === null ? null : new Date(row.expiresAt),
          ],
        );
      }
      return { outcome: 'PAUSED', since: next.since, until: next.until };
    });
  }

  resume(at: number): Promise<ResumeOutcome> {
    return this.transaction(async (client) => {
      const current = await this.lockedState(client, at);
      if (!isPaused(current, at)) return 'NOT_PAUSED';
      await this.write(client, { status: 'RUNNING' }, at);
      return 'RESUMED';
    });
  }
}
