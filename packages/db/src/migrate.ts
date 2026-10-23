import pg from 'pg';

import { MigrationError, loadMigrations, type MigrationFile } from './migrations';

/** One advisory lock key for every migration run, so two deploys cannot migrate at the same time. */
const ADVISORY_LOCK_KEY = '7405900123';

export interface MigrateResult {
  /** Versions applied by this run. */
  applied: number[];
  /** The newest version in the database after this run. */
  current: number;
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

function checkApplied(applied: readonly AppliedRow[], files: readonly MigrationFile[]): void {
  applied.forEach((row, index) => {
    const file = files[index];
    if (file?.version !== row.version) {
      throw new MigrationError(
        'UNKNOWN_APPLIED',
        `The database has migration ${String(row.version)} (${row.name}) that this code does not know. ` +
          'Refusing to run: the code is older than the database.',
      );
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        'CHECKSUM_MISMATCH',
        `Migration ${file.fileName} was changed after it was applied. ` +
          'Applied migrations are never edited: add a new migration instead.',
      );
    }
  });
}

/**
 * Applies the pending migrations, in order, forward only. A Postgres advisory lock makes
 * concurrent runs wait for each other, every file runs in its own transaction (a failure rolls
 * that file back completely) and every applied file is recorded with its checksum.
 * `connectionString` must belong to the schema owner (a role that may create roles and tables).
 */
export async function migrate(
  connectionString: string,
  options: { migrations?: readonly MigrationFile[] } = {},
): Promise<MigrateResult> {
  const files = options.migrations ?? (await loadMigrations());
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [ADVISORY_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer     PRIMARY KEY,
        name       text        NOT NULL,
        checksum   text        NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query<AppliedRow>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    );
    checkApplied(rows, files);

    const applied: number[] = [];
    for (const file of files.slice(rows.length)) {
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [file.version, file.name, file.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      applied.push(file.version);
    }

    return { applied, current: files.length };
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1::bigint)', [ADVISORY_LOCK_KEY])
      .catch(() => undefined);
    await client.end();
  }
}
