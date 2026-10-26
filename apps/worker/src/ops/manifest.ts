/**
 * What a backup is checked against (06 section 4). Right before a dump the backup counts the rows of a few tables
 * and stores the counts next to it (the manifest). The restore drill counts the same tables in the restored copy and
 * in the live database. The append-only tables only ever grow, so the restored copy must hold at least what the
 * manifest says and at most what the live database holds now. A copy that is short, or has more than ever existed,
 * is not a good copy.
 */

/** Tables that are never deleted from and never shrink (the immutable ones, the strategy versions, the migrations). */
export const APPEND_ONLY_TABLES = [
  'signals',
  'signal_events',
  'signal_outcomes',
  'strategy_versions',
  'schema_migrations',
] as const;

/** Tables that have retention jobs: they can shrink, so the drill only asks that a copy of a filled table is not empty. */
export const PRUNED_TABLES = ['candles'] as const;

export const COUNTED_TABLES = [...APPEND_ONLY_TABLES, ...PRUNED_TABLES] as const;

export type Counts = Readonly<Record<string, number>>;

/** The query for the counts: the table names are constants of this file, never input. */
export const COUNTS_SQL = COUNTED_TABLES.map(
  (table) => `SELECT '${table}' AS table_name, count(*)::bigint AS n FROM ${table}`,
).join('\nUNION ALL\n');

export function countsOf(rows: readonly { table_name: string; n: string | number }[]): Counts {
  return Object.fromEntries(rows.map((row) => [row.table_name, Number(row.n)]));
}

export interface BackupCheck {
  readonly ok: boolean;
  readonly problems: readonly string[];
  /** One line per table, for the log of the drill. */
  readonly lines: readonly string[];
}

export function checkBackup(input: {
  readonly manifest: Counts;
  readonly restored: Counts;
  readonly live: Counts;
}): BackupCheck {
  const { manifest, restored, live } = input;
  const problems: string[] = [];
  const lines: string[] = [];
  const read = (counts: Counts, name: string, table: string): number | null => {
    const value = counts[table];
    if (value === undefined || !Number.isFinite(value) || value < 0) {
      problems.push(`${table}: no count in the ${name}`);
      return null;
    }
    return value;
  };

  for (const table of COUNTED_TABLES) {
    const before = read(manifest, 'manifest', table);
    const after = read(restored, 'restored copy', table);
    const now = read(live, 'live database', table);
    lines.push(
      `${table}: manifest ${String(before)}, restored ${String(after)}, live ${String(now)}`,
    );
    if (before === null || after === null || now === null) continue;

    if ((APPEND_ONLY_TABLES as readonly string[]).includes(table)) {
      if (after < before) {
        problems.push(
          `${table}: the restored copy has ${String(after)} rows, the backup was made with ${String(before)}`,
        );
      }
      if (after > now) {
        problems.push(
          `${table}: the restored copy has ${String(after)} rows, more than the live database (${String(now)})`,
        );
      }
    } else if (before > 0 && after === 0) {
      problems.push(
        `${table}: the restored copy is empty, the backup was made with ${String(before)} rows`,
      );
    }
  }
  return { ok: problems.length === 0, problems, lines };
}
