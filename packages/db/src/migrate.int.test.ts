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

describe('migrate as the admin of a managed database (not a superuser)', () => {
  it('applies every migration, with the fallback of 0005, and the backup role can still read everything pg_dump needs', async () => {
    const database = await freshDatabase();
    const managed = await database.managedAdminUrl();
    const files = await loadMigrations();

    const result = await migrate(managed);
    expect(result).toEqual({
      applied: files.map((f) => f.version),
      current: files.length,
      fallbacks: [5],
    });
    // recorded with the checksum of 0005 itself, so a database that took the other way is the same database
    const recorded = await query<{ checksum: string }>(
      database.url,
      'SELECT checksum FROM schema_migrations WHERE version = 5',
    );
    expect(recorded[0]?.checksum).toBe(files.find((f) => f.version === 5)?.checksum);

    // explicit grants, which a member of pg_read_all_data would not have: the tables, the sequences, the later ones
    const grants = await query<{ relname: string; privilege_type: string }>(
      database.url,
      `SELECT c.relname, a.privilege_type
       FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee
       WHERE r.rolname = 'vmgs_backup' AND c.relname IN ('auth_owner', 'ticks', 'signals_seq_seq')
       ORDER BY c.relname, a.privilege_type`,
    );
    expect(grants).toEqual([
      { relname: 'auth_owner', privilege_type: 'SELECT' },
      { relname: 'signals_seq_seq', privilege_type: 'SELECT' },
      { relname: 'ticks', privilege_type: 'SELECT' },
    ]);
    const defaults = await query<{ defaclobjtype: string }>(
      database.url,
      `SELECT d.defaclobjtype FROM pg_default_acl d
       WHERE d.defaclnamespace = 'public'::regnamespace AND d.defaclacl::text LIKE '%vmgs_backup=r/%'
       ORDER BY 1`,
    );
    expect(defaults.map((d) => d.defaclobjtype)).toEqual(['S', 'r']);
  });

  it('does nothing when it runs again, and says nothing about a fallback', async () => {
    const database = await freshDatabase();
    const managed = await database.managedAdminUrl();
    await migrate(managed);
    expect(await migrate(managed)).toEqual({
      applied: [],
      current: (await loadMigrations()).length,
    });
  });

  it('still refuses a permission error of a migration that has no fallback', async () => {
    const database = await freshDatabase();
    const managed = await database.managedAdminUrl();
    const broken = fake(1, 'needs_superuser', 'CREATE ROLE vmgs_needs_bypass BYPASSRLS;');
    await expect(migrate(managed, { migrations: [broken] })).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('runs the fallback only after the file itself was refused, and rolls both back when the fallback fails too', async () => {
    const database = await freshDatabase();
    const managed = await database.managedAdminUrl();
    const both: MigrationFile = {
      ...fake(
        1,
        'both',
        'CREATE TABLE half (id integer); CREATE ROLE vmgs_needs_bypass2 BYPASSRLS;',
      ),
      fallbackSql: 'CREATE TABLE half2 (id integer); SELECT 1 / 0;',
    };
    await expect(migrate(managed, { migrations: [both] })).rejects.toMatchObject({ code: '22012' });
    const tables = await query<{ tablename: string }>(
      database.url,
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    expect(tables.map((t) => t.tablename)).toEqual(['schema_migrations']);
    expect(await query(database.url, 'SELECT version FROM schema_migrations')).toEqual([]);

    // a fallback that works leaves only its own work behind
    const works: MigrationFile = {
      ...both,
      fallbackSql: 'CREATE TABLE only_fallback (id integer);',
    };
    expect(await migrate(managed, { migrations: [works] })).toEqual({
      applied: [1],
      current: 1,
      fallbacks: [1],
    });
    const after = await query<{ tablename: string }>(
      database.url,
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
    );
    expect(after.map((t) => t.tablename)).toEqual(['only_fallback', 'schema_migrations']);
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
