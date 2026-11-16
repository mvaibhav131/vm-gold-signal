import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface MigrationFile {
  version: number;
  name: string;
  fileName: string;
  sql: string;
  checksum: string;
  /**
   * The text of `NNNN_name.fallback.sql`, when there is one: what runs instead of `sql` on a database whose admin may
   * not do what `sql` asks (error 42501), as on a managed Postgres. The checksum is the one of `sql` alone.
   */
  fallbackSql?: string;
}

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const FALLBACK_PATTERN = /^(\d{4})_([a-z0-9_]+)\.fallback\.sql$/;

export class MigrationError extends Error {
  readonly code:
    | 'BAD_FILE_NAME'
    | 'GAP_OR_DUPLICATE'
    | 'CHECKSUM_MISMATCH'
    | 'UNKNOWN_APPLIED'
    | 'ORPHAN_FALLBACK';

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
 * A file `NNNN_name.fallback.sql` beside a migration is its fallback (see `MigrationFile.fallbackSql`); it is how a
 * migration that was already applied can still be made to work on a database with fewer rights, without being edited.
 */
export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const fileNames = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const migrations: MigrationFile[] = [];
  const fallbacks = new Map<string, string>();

  for (const fileName of fileNames) {
    const fallback = FALLBACK_PATTERN.exec(fileName);
    if (fallback !== null) {
      fallbacks.set(
        `${fallback[1] ?? ''}_${fallback[2] ?? ''}.sql`,
        await readFile(`${dir}/${fileName}`, 'utf8'),
      );
      continue;
    }
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

  for (const [mainName, fallbackSql] of fallbacks) {
    const migration = migrations.find((m) => m.fileName === mainName);
    if (migration === undefined) {
      throw new MigrationError(
        'ORPHAN_FALLBACK',
        `${mainName.replace(/\.sql$/, '.fallback.sql')} has no migration ${mainName} beside it`,
      );
    }
    migration.fallbackSql = fallbackSql;
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
