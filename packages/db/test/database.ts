import { randomBytes } from 'node:crypto';

import pg from 'pg';

export interface TestDatabase {
  name: string;
  /** Superuser connection string of this database. */
  url: string;
  /** Connection string of one of the application roles (after `enableLogin`). */
  urlFor(role: string, password: string): string;
  /**
   * Makes the database belong to a new login role that is not a superuser and has only CREATEROLE and CREATEDB, like
   * the admin of a managed Postgres, and returns its connection string. `drop` removes the role again.
   */
  managedAdminUrl(): Promise<string>;
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
  let managedRole: string | null = null;

  return {
    name,
    url: withDatabase(adminUrl, name).toString(),
    urlFor(role, password) {
      const next = withDatabase(adminUrl, name);
      next.username = role;
      next.password = password;
      return next.toString();
    },
    async managedAdminUrl() {
      const role = `${name}_admin`;
      const password = 'managed-admin-pass';
      await query(adminUrl, `CREATE ROLE ${role} LOGIN PASSWORD '${password}' CREATEROLE CREATEDB`);
      managedRole = role;
      await query(adminUrl, `ALTER DATABASE ${name} OWNER TO ${role}`);
      // The application roles are shared by every database of the test cluster, and may exist already. On a managed
      // database the admin creates them itself and so may give them a password; here it is given that right.
      for (const app of ['vmgs_worker', 'vmgs_api', 'vmgs_backup']) {
        await query(
          adminUrl,
          `DO $$ BEGIN CREATE ROLE ${app} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
        );
        await query(adminUrl, `GRANT ${app} TO ${role} WITH ADMIN OPTION`);
      }
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
        if (managedRole !== null) await client.query(`DROP ROLE IF EXISTS ${managedRole}`);
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
