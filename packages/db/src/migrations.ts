import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface MigrationFile {
  version: number;
  name: string;
  fileName: string;
  sql: string;
  checksum: string;
}

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export class MigrationError extends Error {
  readonly code: 'BAD_FILE_NAME' | 'GAP_OR_DUPLICATE' | 'CHECKSUM_MISMATCH' | 'UNKNOWN_APPLIED';

  constructor(code: MigrationError['code'], message: string) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
  }
}

/**
 * SHA-256 of the SQL with line endings normalised, so a Windows checkout and a Linux checkout of
 * the same file have the same checksum.
 */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replaceAll('\r\n', '\n'), 'utf8').digest('hex');
}

/**
 * Reads the migration files: `NNNN_name.sql`, numbered 0001, 0002, ... without gaps. Files are
 * forward-only; there are no down migrations (the backup taken before a deploy is the way back).
 */
export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const fileNames = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const migrations: MigrationFile[] = [];

  for (const fileName of fileNames) {
    const match = FILE_PATTERN.exec(fileName);
    if (match === null) {
      throw new MigrationError(
        'BAD_FILE_NAME',
        `Migration file name must look like 0001_name.sql: ${fileName}`,
      );
    }
    const sql = await readFile(`${dir}/${fileName}`, 'utf8');
    migrations.push({
      version: Number(match[1]),
      name: match[2] ?? '',
      fileName,
      sql,
      checksum: checksumOf(sql),
    });
  }

  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationError(
        'GAP_OR_DUPLICATE',
        `Migrations must be numbered 0001, 0002, ... without gaps or duplicates (found ${migration.fileName} at position ${String(index + 1)})`,
      );
    }
  });
  return migrations;
}
