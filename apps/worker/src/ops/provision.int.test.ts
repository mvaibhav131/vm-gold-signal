import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadMigrations } from '@vmgs/db';

import { failureOf, query, type TestDatabase } from '../../../../packages/db/test/database';
import { emptyDatabase } from '../../../../packages/db/test/setup';
import { provision } from './provision';

const PASSWORDS = {
  DB_PASSWORD_WORKER: 'w'.repeat(40),
  DB_PASSWORD_API: 'a'.repeat(40),
  DB_PASSWORD_BACKUP: 'b'.repeat(40),
};

let database: TestDatabase;

beforeAll(async () => {
  database = await emptyDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe('provision', () => {
  it('migrates an empty database and lets the roles with a password log in, the others not', async () => {
    const result = await provision({
      DATABASE_URL_ADMIN: database.url,
      DB_PASSWORD_WORKER: PASSWORDS.DB_PASSWORD_WORKER,
      DB_PASSWORD_BACKUP: PASSWORDS.DB_PASSWORD_BACKUP,
    });
    const versions = (await loadMigrations()).map((m) => m.version);
    expect(result).toEqual({
      applied: versions,
      current: versions.length,
      roles: ['vmgs_worker', 'vmgs_backup'],
    });

    expect(
      await failureOf(database.urlFor('vmgs_worker', PASSWORDS.DB_PASSWORD_WORKER), 'SELECT 1'),
    ).toBeNull();
    expect(
      await failureOf(database.urlFor('vmgs_backup', PASSWORDS.DB_PASSWORD_BACKUP), 'SELECT 1'),
    ).toBeNull();
    // no password for the api yet: it cannot log in
    expect(
      (await failureOf(database.urlFor('vmgs_api', PASSWORDS.DB_PASSWORD_API), 'SELECT 1'))?.code,
    ).toBe('28P01');
  });

  it('does nothing to the schema when it runs again, and rotates a password', async () => {
    const rotated = 'r'.repeat(40);
    const again = await provision({
      DATABASE_URL_ADMIN: database.url,
      DB_PASSWORD_WORKER: rotated,
      DB_PASSWORD_API: PASSWORDS.DB_PASSWORD_API,
    });
    expect(again.applied).toEqual([]);
    expect(again.roles).toEqual(['vmgs_worker', 'vmgs_api']);

    expect(await failureOf(database.urlFor('vmgs_worker', rotated), 'SELECT 1')).toBeNull();
    expect(
      (await failureOf(database.urlFor('vmgs_worker', PASSWORDS.DB_PASSWORD_WORKER), 'SELECT 1'))
        ?.code,
    ).toBe('28P01');
    expect(
      await failureOf(database.urlFor('vmgs_api', PASSWORDS.DB_PASSWORD_API), 'SELECT 1'),
    ).toBeNull();
    // the backup role keeps the password of the first run: an unset one is not touched
    expect(
      await failureOf(database.urlFor('vmgs_backup', PASSWORDS.DB_PASSWORD_BACKUP), 'SELECT 1'),
    ).toBeNull();
  });

  it('gives the roles the rights of the schema, so the worker works with the password it was given', async () => {
    const worker = database.urlFor('vmgs_worker', 'r'.repeat(40));
    expect(await failureOf(worker, 'SELECT count(*) FROM candles')).toBeNull();
    expect((await failureOf(worker, 'SELECT count(*) FROM auth_owner'))?.code).toBe('42501');
    const rows = await query<{ n: string }>(
      database.url,
      'SELECT count(*)::text AS n FROM schema_migrations',
    );
    expect(Number(rows[0]?.n)).toBe((await loadMigrations()).length);
  });

  it('writes a password that has a quote in it as it is (it is quoted by the server)', async () => {
    const odd = 'x\'y"z'.padEnd(30, 'q');
    // bypass the env schema on purpose: the point is that the statement cannot be broken out of
    await provision({ DATABASE_URL_ADMIN: database.url, DB_PASSWORD_WORKER: odd });
    expect(await failureOf(database.urlFor('vmgs_worker', odd), 'SELECT 1')).toBeNull();
  });

  it('stops with the error of the database when it cannot connect as the owner', async () => {
    await expect(
      provision({
        DATABASE_URL_ADMIN: database.urlFor('vmgs_worker', 'wrong'.padEnd(30, 'x')),
        DB_PASSWORD_WORKER: 'x'.repeat(30),
      }),
    ).rejects.toThrow(/password authentication failed/);
  });
});

describe('provision on a managed database (the admin is not a superuser)', () => {
  let managedDb: TestDatabase;

  beforeAll(async () => {
    managedDb = await emptyDatabase();
  });

  afterAll(async () => {
    await managedDb.drop();
  });

  it('migrates with the fallback of 0005, tells so, and lets all three roles log in and do their work', async () => {
    const admin = await managedDb.managedAdminUrl();
    const result = await provision({ DATABASE_URL_ADMIN: admin, ...PASSWORDS });
    const versions = (await loadMigrations()).map((m) => m.version);
    expect(result).toEqual({
      applied: versions,
      current: versions.length,
      fallbacks: [5],
      roles: ['vmgs_worker', 'vmgs_api', 'vmgs_backup'],
    });

    const worker = managedDb.urlFor('vmgs_worker', PASSWORDS.DB_PASSWORD_WORKER);
    const api = managedDb.urlFor('vmgs_api', PASSWORDS.DB_PASSWORD_API);
    const backup = managedDb.urlFor('vmgs_backup', PASSWORDS.DB_PASSWORD_BACKUP);
    expect(await failureOf(worker, 'SELECT count(*) FROM candles')).toBeNull();
    expect((await failureOf(worker, 'SELECT count(*) FROM auth_owner'))?.code).toBe('42501');
    expect(await failureOf(api, 'SELECT count(*) FROM auth_owner')).toBeNull();
    expect(await failureOf(backup, 'SELECT count(*) FROM auth_owner')).toBeNull();
    // the partition maintenance runs with the owner's rights, which a managed admin has
    expect(await failureOf(worker, 'SELECT ensure_tick_partitions(2)')).toBeNull();
  });
});
