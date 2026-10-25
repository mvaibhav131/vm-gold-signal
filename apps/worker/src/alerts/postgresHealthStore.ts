import type { Pool } from 'pg';

import type { FeedIncident, HealthStore } from './health';

/** The incidents of the feed and the open signals, as `HealthWatcher` reads them. */
export class PostgresHealthStore implements HealthStore {
  constructor(private readonly pool: Pool) {}

  async incidents(endedSince: number): Promise<FeedIncident[]> {
    const { rows } = await this.pool.query<{
      kind: FeedIncident['kind'];
      started_at: Date;
      ended_at: Date | null;
    }>(
      `SELECT kind, started_at, ended_at FROM feed_incidents
        WHERE kind IN ('DISCONNECT', 'STALE') AND (ended_at IS NULL OR ended_at >= $1)
        ORDER BY started_at`,
      [new Date(endedSince)],
    );
    return rows.map((row) => ({
      kind: row.kind,
      startedAt: row.started_at.getTime(),
      endedAt: row.ended_at === null ? null : row.ended_at.getTime(),
    }));
  }

  async openSeqs(): Promise<number[]> {
    const { rows } = await this.pool.query<{ seq: string | number }>(
      `SELECT s.seq FROM signal_state st
         JOIN signals s ON s.id = st.signal_id
        WHERE st.status IN ('ACTIVE', 'TP1_HIT')
        ORDER BY s.seq`,
    );
    return rows.map((row) => Number(row.seq));
  }
}
