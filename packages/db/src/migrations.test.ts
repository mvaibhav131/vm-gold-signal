import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MIGRATIONS_DIR, MigrationError, checksumOf, loadMigrations } from './migrations';

const created: string[] = [];

async function migrationDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vmgs-migrations-'));
  created.push(dir);
  await mkdir(dir, { recursive: true });
  for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
  return dir;
}

afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('checksumOf', () => {
  it('is the SHA-256 of the text', () => {
    expect(checksumOf('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('does not depend on the line endings of the checkout', () => {
    expect(checksumOf('SELECT 1;\r\nSELECT 2;\r\n')).toBe(checksumOf('SELECT 1;\nSELECT 2;\n'));
  });

  it('changes with the slightest edit', () => {
    expect(checksumOf('SELECT 1;')).not.toBe(checksumOf('SELECT 1; '));
  });
});

describe('loadMigrations', () => {
  it('reads the real migrations: 0001 schema, 0002 roles, numbered without gaps', async () => {
    const migrations = await loadMigrations();
    expect(migrations.map((m) => [m.version, m.name])).toEqual([
      [1, 'schema'],
      [2, 'roles'],
    ]);
    for (const migration of migrations) {
      expect(migration.sql.trim().length).toBeGreaterThan(100);
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('applies the schema of docs/03_Data_Model.sql as migration 0001, unchanged', async () => {
    const doc = await readFile(new URL('../../../docs/03_Data_Model.sql', import.meta.url), 'utf8');
    const migration = await readFile(join(MIGRATIONS_DIR, '0001_schema.sql'), 'utf8');
    expect(checksumOf(migration)).toBe(checksumOf(doc));
  });

  it('returns nothing for an empty directory and ignores other files', async () => {
    expect(await loadMigrations(await migrationDir({}))).toEqual([]);
    expect(await loadMigrations(await migrationDir({ 'README.md': 'notes' }))).toEqual([]);
  });

  it('orders by number', async () => {
    const dir = await migrationDir({ '0002_b.sql': 'SELECT 2;', '0001_a.sql': 'SELECT 1;' });
    expect((await loadMigrations(dir)).map((m) => m.fileName)).toEqual([
      '0001_a.sql',
      '0002_b.sql',
    ]);
  });

  it.each(['1_a.sql', '0001-a.sql', '0001_A.sql', '0001_.sql', 'init.sql', '00001_a.sql'])(
    'rejects the file name %s',
    async (name) => {
      const dir = await migrationDir({ [name]: 'SELECT 1;' });
      await expect(loadMigrations(dir)).rejects.toMatchObject({ code: 'BAD_FILE_NAME' });
    },
  );

  it('rejects a gap, a duplicate and a start that is not 0001', async () => {
    for (const files of [
      { '0001_a.sql': 'SELECT 1;', '0003_c.sql': 'SELECT 3;' },
      { '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 2;' },
      { '0002_b.sql': 'SELECT 2;' },
    ]) {
      const error = await loadMigrations(await migrationDir(files)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MigrationError);
      expect(error).toMatchObject({ code: 'GAP_OR_DUPLICATE' });
    }
  });
});
