import type { Pool } from 'pg';

import { WORKER_HEARTBEAT, WORKER_READY_MAX_AGE_MS } from '@vmgs/db';

/** What `GET /health/ready` looks at (04 section 2). A value that is not there is null. */
export interface ReadinessFacts {
  /** The newest applied migration. */
  readonly migrationVersion: number | null;
  /** The worker's own heartbeat, epoch milliseconds. */
  readonly workerHeartbeatAt: number | null;
}

export interface ReadinessReader {
  /** Rejects when the database cannot be reached: that is "not ready", not an error of the API. */
  facts(): Promise<ReadinessFacts>;
}

export class PostgresReadinessReader implements ReadinessReader {
  constructor(private readonly pool: Pool) {}

  async facts(): Promise<ReadinessFacts> {
    const { rows } = await this.pool.query<{ version: number | null; beat: Date | null }>(
      `SELECT (SELECT max(version) FROM schema_migrations) AS version,
              (SELECT heartbeat_at FROM worker_heartbeats WHERE worker_name = $1) AS beat`,
      [WORKER_HEARTBEAT],
    );
    const row = rows[0];
    return {
      migrationVersion: row?.version ?? null,
      workerHeartbeatAt: row?.beat?.getTime() ?? null,
    };
  }
}

/** Ready: the database is at the version of this build and the worker has been heard from within the last minute. */
export function isReady(facts: ReadinessFacts, expectedMigration: number, now: number): boolean {
  return (
    facts.migrationVersion === expectedMigration &&
    facts.workerHeartbeatAt !== null &&
    now - facts.workerHeartbeatAt <= WORKER_READY_MAX_AGE_MS
  );
}
