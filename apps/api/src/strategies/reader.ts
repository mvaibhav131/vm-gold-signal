import type { Pool } from 'pg';

import { defaultSettings } from '@vmgs/config';
import {
  STRATEGY_ENABLED_KEY,
  evidenceSchema,
  strategyEnabledSchema,
  type Evidence,
  type StrategyEnabled,
} from '@vmgs/contracts';
import {
  STRATEGY_KEYS,
  isRetiredStrategy,
  type StrategyKey,
  type StrategyStatus,
} from '@vmgs/core';

/** The newest version of a strategy, and what its newest signal said. */
export interface StrategyRow {
  readonly key: StrategyKey;
  readonly version: string;
  readonly status: StrategyStatus;
  readonly lastSignalAt: number | null;
  /** The evidence as the newest signal showed it (it does not move after that signal was made). */
  readonly evidence: Evidence | null;
}

/** The owner's two switches of every strategy, as stored; a strategy with no entry has the default. */
export interface StrategySwitches {
  readonly enabled: StrategyEnabled;
  readonly alerts: Readonly<Partial<Record<StrategyKey, 'on' | 'off'>>>;
}

export interface StrategyListing {
  readonly rows: readonly StrategyRow[];
  readonly switches: StrategySwitches;
}

export interface StrategyChange {
  readonly enabled?: boolean | undefined;
  readonly alerts?: boolean | undefined;
}

export interface StrategiesReader {
  list(): Promise<StrategyListing>;
  /** The config of the newest version, for reading; null when the strategy has no version. */
  config(key: StrategyKey): Promise<{ version: string; config: Record<string, unknown> } | null>;
  /** Sets the switches the owner sent, together or not at all. */
  change(key: StrategyKey, change: StrategyChange, at: number): Promise<void>;
}

/** `strategyAlerts` is also a setting (`PATCH /settings`): the same row, the same switch. */
export const STRATEGY_ALERTS_KEY = 'strategyAlerts';

interface VersionRow {
  strategy_key: StrategyKey;
  version: string;
  status: StrategyStatus;
}

interface LastRow {
  strategy_key: StrategyKey;
  generated_at: Date;
  evidence: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What is stored for the alert switches: only entries that name a strategy and say on or off count. */
function alertSwitchesOf(value: unknown): StrategySwitches['alerts'] {
  const found: Partial<Record<StrategyKey, 'on' | 'off'>> = {};
  if (!isRecord(value)) return found;
  for (const key of STRATEGY_KEYS) {
    const entry = value[key];
    if (entry === 'on' || entry === 'off') found[key] = entry;
  }
  return found;
}

/**
 * One statement that adds the entry to the object that is there ($3), or starts the row ($2): two switches that are
 * changed at the same moment (here, or by `PATCH /settings`) both stay, because the row is locked for the merge.
 */
const UPSERT_MERGING = `
  INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, $4)
  ON CONFLICT (key) DO UPDATE
     SET value = app_settings.value || $3::jsonb, updated_at = EXCLUDED.updated_at`;

export class PostgresStrategiesReader implements StrategiesReader {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<StrategyListing> {
    const [versions, last, settings] = await Promise.all([
      this.pool.query<VersionRow>(
        `SELECT DISTINCT ON (strategy_key) strategy_key, version, status
           FROM strategy_versions ORDER BY strategy_key, created_at DESC, version DESC`,
      ),
      this.pool.query<LastRow>(
        `SELECT DISTINCT ON (sv.strategy_key) sv.strategy_key, s.generated_at, s.evidence
           FROM signals s JOIN strategy_versions sv ON sv.id = s.strategy_version_id
          WHERE s.mode <> 'BACKTEST'
          ORDER BY sv.strategy_key, s.generated_at DESC, s.seq DESC`,
      ),
      this.pool.query<{ key: string; value: unknown }>(
        'SELECT key, value FROM app_settings WHERE key = ANY($1::text[])',
        [[STRATEGY_ENABLED_KEY, STRATEGY_ALERTS_KEY]],
      ),
    ]);
    const newest = new Map(last.rows.map((row) => [row.strategy_key, row]));
    const rows = versions.rows
      // a retired strategy is not in the list (its signals are still in the history)
      .filter((row) => !isRetiredStrategy(row.strategy_key))
      .map((row): StrategyRow => {
        const signal = newest.get(row.strategy_key);
        return {
          key: row.strategy_key,
          version: row.version,
          status: row.status,
          lastSignalAt: signal?.generated_at.getTime() ?? null,
          evidence: signal === undefined ? null : evidenceSchema.parse(signal.evidence),
        };
      })
      .sort((a, b) => STRATEGY_KEYS.indexOf(a.key) - STRATEGY_KEYS.indexOf(b.key));
    const stored = new Map(settings.rows.map((row) => [row.key, row.value]));
    const enabled = stored.get(STRATEGY_ENABLED_KEY);
    return {
      rows,
      switches: {
        enabled: enabled === undefined ? {} : strategyEnabledSchema.parse(enabled),
        alerts: alertSwitchesOf(stored.get(STRATEGY_ALERTS_KEY)),
      },
    };
  }

  async config(
    key: StrategyKey,
  ): Promise<{ version: string; config: Record<string, unknown> } | null> {
    const { rows } = await this.pool.query<{ version: string; config: unknown }>(
      `SELECT version, config FROM strategy_versions
        WHERE strategy_key = $1 ORDER BY created_at DESC, version DESC LIMIT 1`,
      [key],
    );
    const row = rows[0];
    if (row === undefined) return null;
    if (!isRecord(row.config)) throw new Error('a strategy config is not an object');
    return { version: row.version, config: row.config };
  }

  async change(key: StrategyKey, change: StrategyChange, at: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (change.enabled !== undefined) {
        const patch = JSON.stringify({ [key]: change.enabled });
        await client.query(UPSERT_MERGING, [STRATEGY_ENABLED_KEY, patch, patch, new Date(at)]);
      }
      if (change.alerts !== undefined) {
        // a database that was never seeded has no row yet: it starts from the documented defaults, not from one switch
        const patch = JSON.stringify({ [key]: change.alerts ? 'on' : 'off' });
        const first = JSON.stringify({
          ...defaultSettings().strategyAlerts,
          [key]: change.alerts ? 'on' : 'off',
        });
        await client.query(UPSERT_MERGING, [STRATEGY_ALERTS_KEY, first, patch, new Date(at)]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
