import { afterEach, describe, expect, it } from 'vitest';

import { migrate } from './migrate';
import { MigrationError, checksumOf, loadMigrations, type MigrationFile } from './migrations';
import { query, type TestDatabase } from '../test/database';
import { emptyDatabase } from '../test/setup';

const open: TestDatabase[] = [];

async function freshDatabase(): Promise<TestDatabase> {
  const database = await emptyDatabase();
  open.push(database);
  return database;
}

afterEach(async () => {
  for (const database of open.splice(0)) await database.drop();
});

function fake(version: number, name: string, sql: string): MigrationFile {
  return {
    version,
    name,
    fileName: `${String(version).padStart(4, '0')}_${name}.sql`,
    sql,
    checksum: checksumOf(sql),
  };
}

describe('migrate on an empty database', () => {
  it('applies every migration and records each with its checksum', async () => {
    const database = await freshDatabase();
    const files = await loadMigrations();

    const result = await migrate(database.url);
    expect(result).toEqual({ applied: files.map((f) => f.version), current: files.length });

    const rows = await query<{ version: number; name: string; checksum: string }>(
      database.url,
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    );
    expect(rows).toEqual(
      files.map((f) => ({ version: f.version, name: f.name, checksum: f.checksum })),
    );
  });

  it('creates the tables, the views and the two application roles', async () => {
    const database = await freshDatabase();
    await migrate(database.url);

    const relations = await query<{ relname: string; relkind: string }>(
      database.url,
      `SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v') AND NOT c.relispartition`,
    );
    const names = relations.map((r) => r.relname);
    for (const table of [
      'ticks',
      'candles',
      'signals',
      'signal_events',
      'signal_outcomes',
      'auth_owner',
      'app_settings',
    ]) {
      expect(names).toContain(table);
    }
    expect(relations.find((r) => r.relname === 'signal_history_v')?.relkind).toBe('v');
    expect(relations.find((r) => r.relname === 'ticks')?.relkind).toBe('p');

    const roles = await query<{ rolname: string }>(
      database.url,
      "SELECT rolname FROM pg_roles WHERE rolname IN ('vmgs_worker', 'vmgs_api') ORDER BY rolname",
    );
    expect(roles.map((r) => r.rolname)).toEqual(['vmgs_api', 'vmgs_worker']);
  });

  it('does nothing when it runs again', async () => {
    const database = await freshDatabase();
    await migrate(database.url);
    const before = await query(
      database.url,
      'SELECT version, applied_at FROM schema_migrations ORDER BY version',
    );

    const again = await migrate(database.url);
    expect(again.applied).toEqual([]);
    expect(
      await query(
        database.url,
        'SELECT version, applied_at FROM schema_migrations ORDER BY version',
      ),
    ).toEqual(before);
  });

  it('lets two runs at the same time take turns (advisory lock)', async () => {
    const database = await freshDatabase();
    const [a, b] = await Promise.all([migrate(database.url), migrate(database.url)]);
    const applied = [...a.applied, ...b.applied].sort();
    expect(applied).toEqual((await loadMigrations()).map((f) => f.version));
    const count = await query<{ n: string }>(
      database.url,
      'SELECT count(*) AS n FROM schema_migrations',
    );
    expect(Number(count[0]?.n)).toBe(applied.length);
  });
});

describe('migrate refuses to run on a database it cannot trust', () => {
  it('detects an applied migration that was edited afterwards', async () => {
    const database = await freshDatabase();
    await migrate(database.url);
    const edited = (await loadMigrations()).map((m) =>
      m.version === 1 ? fake(1, m.name, `${m.sql}\n-- sneaky edit\n`) : m,
    );

    const error = await migrate(database.url, { migrations: edited }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationError);
    expect(error).toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    expect((error as Error).message).toContain('0001_schema.sql');
  });

  it('detects a database that is newer than the code', async () => {
    const database = await freshDatabase();
    await migrate(database.url);
    const older = (await loadMigrations()).slice(0, 1);

    await expect(migrate(database.url, { migrations: older })).rejects.toMatchObject({
      code: 'UNKNOWN_APPLIED',
    });
  });
});

describe('a failing migration', () => {
  it('rolls its own file back completely, keeps the earlier ones and can be fixed and run again', async () => {
    const database = await freshDatabase();
    const first = fake(1, 'first', 'CREATE TABLE kept (id integer PRIMARY KEY);');
    const broken = fake(2, 'second', 'CREATE TABLE half_done (id integer); SELECT 1 / 0;');

    const error = await migrate(database.url, { migrations: [first, broken] }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: '22012' });

    const tables = await query<{ tablename: string }>(
      database.url,
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    expect(tables.map((t) => t.tablename)).toEqual(['kept', 'schema_migrations']);
    const recorded = await query<{ version: number }>(
      database.url,
      'SELECT version FROM schema_migrations',
    );
    expect(recorded.map((r) => r.version)).toEqual([1]);

    // The lock was released: a corrected version 2 applies. Version 2 was never recorded, so its
    // text may change.
    const fixed = fake(2, 'second', 'CREATE TABLE fixed (id integer);');
    expect(await migrate(database.url, { migrations: [first, fixed] })).toEqual({
      applied: [2],
      current: 2,
    });
  });

  it('is applied in one transaction: nothing of it is visible while it fails', async () => {
    const database = await freshDatabase();
    const files = [fake(1, 'one', 'CREATE TABLE a (id integer); CREATE TABLE a (id integer);')];
    const error = await migrate(database.url, { migrations: files }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: '42P07' });
    const tables = await query<{ tablename: string }>(
      database.url,
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    expect(tables.map((t) => t.tablename)).not.toContain('a');
  });
});
