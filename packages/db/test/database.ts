import { randomBytes } from 'node:crypto';

import pg from 'pg';

export interface TestDatabase {
  name: string;
  /** Superuser connection string of this database. */
  url: string;
  /** Connection string of one of the application roles (after `enableLogin`). */
  urlFor(role: string, password: string): string;
  drop(): Promise<void>;
}

function withDatabase(url: string, database: string): URL {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next;
}

/** A fresh, empty database inside the shared test container. Every test file gets its own. */
export async function createTestDatabase(adminUrl: string): Promise<TestDatabase> {
  const name = `vmgs_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  return {
    name,
    url: withDatabase(adminUrl, name).toString(),
    urlFor(role, password) {
      const next = withDatabase(adminUrl, name);
      next.username = role;
      next.password = password;
      return next.toString();
    },
    async drop() {
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}

/** Runs one statement as a one-off connection and returns the rows. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  connectionString: string,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return (await client.query<T>(sql, values)).rows;
  } finally {
    await client.end();
  }
}

/** The SQLSTATE and message of the error a statement raises, or null when it succeeds. */
export async function failureOf(
  connectionString: string,
  sql: string,
  values: unknown[] = [],
): Promise<{ code: string; message: string } | null> {
  try {
    await query(connectionString, sql, values);
    return null;
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
}
