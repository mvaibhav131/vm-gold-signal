import { statfs } from 'node:fs/promises';

import { RETENTION_DAYS } from '@vmgs/core';
import type { Pool } from 'pg';

import type {
  DiskUsage,
  MaintenanceRun,
  RetentionStore,
  RunLog,
  StorageStore,
  TableSize,
} from './store';

const CANDLE_BATCH = 10_000;
const TICK_DAYS_KEY = 'tickRetentionDays';

/**
 * The maintenance of the database in PostgreSQL: the deletes of the nightly retention, the sizes the guard reads, the
 * days of ticks kept, and the log of the runs. Nothing here may touch `signals`, `signal_events` or `signal_outcomes`
 * but one statement: the replacement of the feature snapshot of an old signal by a marker (the database allows no other change).
 */
export class PostgresMaintenanceStore implements RetentionStore, StorageStore, RunLog {
  constructor(private readonly pool: Pool) {}

  async dropTickPartitions(keepDays: number): Promise<number> {
    const { rows } = await this.pool.query<{ dropped: number }>(
      'SELECT drop_old_tick_partitions($1::integer) AS dropped',
      [keepDays],
    );
    return rows[0]?.dropped ?? 0;
  }

  /** The 1m candles in batches, so that a long catch-up does not hold the table for long. */
  async deleteCandles1m(before: number): Promise<number> {
    let total = 0;
    for (;;) {
      const result = await this.pool.query(
        `DELETE FROM candles
          WHERE ctid IN (SELECT ctid FROM candles WHERE tf = '1m' AND open_time < $1 LIMIT $2)`,
        [new Date(before), CANDLE_BATCH],
      );
      const deleted = result.rowCount ?? 0;
      total += deleted;
      if (deleted < CANDLE_BATCH) return total;
    }
  }

  async pruneSnapshots(before: number, at: number): Promise<number> {
    const result = await this.pool.query(
      `UPDATE signals
          SET feature_snapshot = jsonb_strip_nulls(jsonb_build_object(
                'pruned', true, 'prunedAt', $2::text, 'spread', feature_snapshot -> 'spread'))
        WHERE generated_at < $1 AND COALESCE(feature_snapshot ->> 'pruned', '') <> 'true'`,
      [new Date(before), new Date(at).toISOString()],
    );
    return result.rowCount ?? 0;
  }

  async deleteOutbox(sentBefore: number, failedBefore: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM notification_outbox
        WHERE (status = 'SENT' AND created_at < $1)
           OR (status IN ('FAILED', 'DEAD', 'EXPIRED') AND created_at < $2)`,
      [new Date(sentBefore), new Date(failedBefore)],
    );
    return result.rowCount ?? 0;
  }

  async deleteRejections(before: number): Promise<number> {
    const result = await this.pool.query('DELETE FROM rejections WHERE at < $1', [
      new Date(before),
    ]);
    return result.rowCount ?? 0;
  }

  /** An incident that is still open is kept, however old. */
  async deleteFeedIncidents(before: number): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM feed_incidents WHERE started_at < $1 AND ended_at IS NOT NULL',
      [new Date(before)],
    );
    return result.rowCount ?? 0;
  }

  async deleteMaintenanceRuns(before: number): Promise<number> {
    const result = await this.pool.query('DELETE FROM maintenance_runs WHERE started_at < $1', [
      new Date(before),
    ]);
    return result.rowCount ?? 0;
  }

  /** The headlines shown with a signal or a market move are copied into them (frozen), so none is kept for that. */
  async deleteHeadlines(before: number): Promise<number> {
    const result = await this.pool.query('DELETE FROM news_items WHERE first_seen_at < $1', [
      new Date(before),
    ]);
    return result.rowCount ?? 0;
  }

  async deleteMarketEvents(before: number): Promise<number> {
    const result = await this.pool.query('DELETE FROM market_events WHERE detected_at < $1', [
      new Date(before),
    ]);
    return result.rowCount ?? 0;
  }

  // ------------------------------------------------------------------------------- the sizes

  async databaseSize(): Promise<number> {
    const { rows } = await this.pool.query<{ size: string }>(
      'SELECT pg_database_size(current_database())::bigint AS size',
    );
    return Number(rows[0]?.size ?? 0);
  }

  async tableSizes(): Promise<TableSize[]> {
    const { rows } = await this.pool.query<{ table_name: string; bytes: string }>(
      `SELECT COALESCE(p.relname, c.relname) AS table_name,
              sum(pg_total_relation_size(c.oid))::bigint AS bytes
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
         LEFT JOIN pg_class p ON p.oid = i.inhparent
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        GROUP BY 1
        ORDER BY 2 DESC, 1`,
    );
    return rows.map((row) => ({ table: row.table_name, bytes: Number(row.bytes) }));
  }

  async tickRetentionDays(): Promise<number> {
    const { rows } = await this.pool.query<{ value: unknown }>(
      'SELECT value FROM app_settings WHERE key = $1',
      [TICK_DAYS_KEY],
    );
    const value = rows[0]?.value;
    return typeof value === 'number' && Number.isInteger(value) && value >= 1
      ? value
      : RETENTION_DAYS.ticks;
  }

  async setTickRetentionDays(days: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, to_jsonb($2::integer), now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [TICK_DAYS_KEY, days],
    );
  }

  // ------------------------------------------------------------------------------- the log

  async record(run: MaintenanceRun): Promise<void> {
    await this.pool.query(
      `INSERT INTO maintenance_runs (job, started_at, finished_at, rows_deleted, db_size_bytes, details)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        run.job,
        new Date(run.startedAt),
        run.finishedAt === null ? null : new Date(run.finishedAt),
        run.rowsDeleted,
        run.dbSizeBytes,
        JSON.stringify(run.details),
      ],
    );
  }

  async lastFinished(job: string): Promise<number | null> {
    const { rows } = await this.pool.query<{ at: Date | null }>(
      'SELECT max(finished_at) AS at FROM maintenance_runs WHERE job = $1',
      [job],
    );
    return rows[0]?.at?.getTime() ?? null;
  }
}

/** The disk under a path (the working directory of the worker by default: the disk of the VM, as a container sees it). */
export class StatfsDisk implements DiskUsage {
  constructor(private readonly path: string = process.cwd()) {}

  async usage(): Promise<{ totalBytes: number; freeBytes: number } | null> {
    try {
      const stats = await statfs(this.path);
      return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
    } catch {
      return null;
    }
  }
}
