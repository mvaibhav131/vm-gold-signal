import {
  QUALITY_GROUPS,
  type IncidentSpan,
  type QualityGroup,
  type ReportRow,
  type TimeWindow,
} from '@vmgs/core';
import type { Pool } from 'pg';

import type { ReportStore } from './store';

type Num = string | number;

/** The heartbeat that the nightly backup writes (`worker_heartbeats.worker_name`, B31). */
export const BACKUP_HEARTBEAT = 'backup';

const num = (value: Num): number => {
  const result = Number(value);
  if (!Number.isFinite(result))
    throw new Error(`database returned an invalid number: ${String(value)}`);
  return result;
};

/** The groups of `weak_groups_at_entry` (`[{group, state}]`); what is not a known group is left out. */
function weakGroupsOf(value: unknown): QualityGroup[] {
  if (!Array.isArray(value)) return [];
  const found = new Set<string>();
  for (const entry of value as unknown[]) {
    if (typeof entry === 'object' && entry !== null && 'group' in entry) {
      found.add(String(entry.group));
    }
  }
  return QUALITY_GROUPS.filter((group) => found.has(group));
}

/** What the reports read from PostgreSQL, with the rights of the worker role (all reads). */
export class PostgresReportStore implements ReportStore {
  constructor(private readonly pool: Pool) {}

  async rows(window: TimeWindow): Promise<ReportRow[]> {
    const { rows } = await this.pool.query<{
      seq: Num;
      side: ReportRow['side'];
      strategy_key: ReportRow['strategyKey'];
      session: ReportRow['session'];
      quality_score: Num;
      generated_at: Date;
      result: ReportRow['result'];
      counts_in_stats: boolean | null;
      realized_r_net: Num | null;
      duration_s: number | null;
      tp1_hit: boolean | null;
      tp2_hit: boolean | null;
      closed_at: Date | null;
      primary_cause: ReportRow['primaryCause'];
      weak_groups: unknown;
    }>(
      `SELECT s.seq, s.side, sv.strategy_key, s.session, s.quality_score, s.generated_at,
              o.result, o.counts_in_stats, o.realized_r_net, o.duration_s, o.tp1_hit, o.tp2_hit,
              o.closed_at, a.primary_cause, a.weak_groups_at_entry AS weak_groups
         FROM signals s
         JOIN strategy_versions sv ON sv.id = s.strategy_version_id
         LEFT JOIN signal_outcomes o ON o.signal_id = s.id
         LEFT JOIN signal_autopsies a ON a.signal_id = s.id
        WHERE s.generated_at >= $1 AND s.generated_at < $2 AND s.mode = 'LIVE'
        ORDER BY s.seq`,
      [new Date(window.from), new Date(window.until)],
    );
    return rows.map((row) => ({
      seq: num(row.seq),
      side: row.side,
      strategyKey: row.strategy_key,
      session: row.session,
      qualityScore: num(row.quality_score),
      generatedAt: row.generated_at.getTime(),
      result: row.result,
      countsInStats: row.counts_in_stats ?? false,
      realizedRNet: row.realized_r_net === null ? null : num(row.realized_r_net),
      durationS: row.duration_s ?? 0,
      tp1Hit: row.tp1_hit ?? false,
      tp2Hit: row.tp2_hit ?? false,
      closedAt: (row.closed_at ?? row.generated_at).getTime(),
      primaryCause: row.primary_cause,
      weakGroups: weakGroupsOf(row.weak_groups),
    }));
  }

  async incidents(window: TimeWindow): Promise<IncidentSpan[]> {
    const { rows } = await this.pool.query<{ started_at: Date; ended_at: Date | null }>(
      `SELECT started_at, ended_at FROM feed_incidents
        WHERE kind IN ('DISCONNECT', 'STALE') AND started_at < $2
          AND (ended_at IS NULL OR ended_at > $1)
        ORDER BY started_at`,
      [new Date(window.from), new Date(window.until)],
    );
    return rows.map((row) => ({
      startedAt: row.started_at.getTime(),
      endedAt: row.ended_at === null ? null : row.ended_at.getTime(),
    }));
  }

  async databaseSize(): Promise<number | null> {
    const { rows } = await this.pool.query<{ size: Num }>(
      'SELECT pg_database_size(current_database()) AS size',
    );
    const row = rows[0];
    return row === undefined ? null : num(row.size);
  }

  async lastBackupAt(): Promise<number | null> {
    const { rows } = await this.pool.query<{ heartbeat_at: Date }>(
      'SELECT heartbeat_at FROM worker_heartbeats WHERE worker_name = $1',
      [BACKUP_HEARTBEAT],
    );
    return rows[0]?.heartbeat_at.getTime() ?? null;
  }
}
