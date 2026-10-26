import { describe, expect, it } from 'vitest';

import {
  APPEND_ONLY_TABLES,
  COUNTED_TABLES,
  COUNTS_SQL,
  checkBackup,
  countsOf,
  type Counts,
} from './manifest';

function counts(value: number, overrides: Counts = {}): Counts {
  return { ...Object.fromEntries(COUNTED_TABLES.map((table) => [table, value])), ...overrides };
}

describe('checkBackup', () => {
  it('accepts a copy between what the backup saw and what the live database holds now', () => {
    const check = checkBackup({
      manifest: counts(10),
      restored: counts(11, { candles: 5 }),
      live: counts(12, { candles: 4 }),
    });
    expect(check.problems).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.lines).toHaveLength(COUNTED_TABLES.length);
  });

  it('accepts a copy of exactly the live database', () => {
    expect(checkBackup({ manifest: counts(10), restored: counts(10), live: counts(10) }).ok).toBe(
      true,
    );
  });

  it('refuses a copy that lost rows of an append-only table', () => {
    const check = checkBackup({
      manifest: counts(10),
      restored: counts(10, { signals: 9 }),
      live: counts(10),
    });
    expect(check.ok).toBe(false);
    expect(check.problems).toEqual([
      'signals: the restored copy has 9 rows, the backup was made with 10',
    ]);
  });

  it('refuses a copy that has more rows than the live database ever had', () => {
    const check = checkBackup({
      manifest: counts(10),
      restored: counts(10, { signal_events: 13 }),
      live: counts(12),
    });
    expect(check.problems).toEqual([
      'signal_events: the restored copy has 13 rows, more than the live database (12)',
    ]);
  });

  it('lets a pruned table shrink but not be emptied', () => {
    const shrunk = checkBackup({
      manifest: counts(10),
      restored: counts(10, { candles: 3 }),
      live: counts(10, { candles: 1 }),
    });
    expect(shrunk.ok).toBe(true);
    const emptied = checkBackup({
      manifest: counts(10),
      restored: counts(10, { candles: 0 }),
      live: counts(10),
    });
    expect(emptied.problems).toEqual([
      'candles: the restored copy is empty, the backup was made with 10 rows',
    ]);
    expect(
      checkBackup({
        manifest: counts(10, { candles: 0 }),
        restored: counts(10, { candles: 0 }),
        live: counts(10, { candles: 0 }),
      }).ok,
    ).toBe(true);
  });

  it('refuses a missing, negative or invalid count', () => {
    const missing = Object.fromEntries(
      COUNTED_TABLES.filter((table) => table !== 'schema_migrations').map((table) => [table, 1]),
    );
    expect(
      checkBackup({ manifest: counts(1), restored: missing, live: counts(1) }).problems,
    ).toEqual(['schema_migrations: no count in the restored copy']);
    const bad = checkBackup({
      manifest: counts(1, { signals: -1 }),
      restored: counts(1, { signals: Number.NaN }),
      live: counts(1),
    });
    expect(bad.ok).toBe(false);
    expect(bad.problems).toEqual([
      'signals: no count in the manifest',
      'signals: no count in the restored copy',
    ]);
  });

  it('checks the schema version like any other append-only table', () => {
    expect(APPEND_ONLY_TABLES).toContain('schema_migrations');
    const check = checkBackup({
      manifest: counts(4),
      restored: counts(4, { schema_migrations: 3 }),
      live: counts(4),
    });
    expect(check.problems).toEqual([
      'schema_migrations: the restored copy has 3 rows, the backup was made with 4',
    ]);
  });
});

describe('the counts', () => {
  it('are read from rows, and the bigint text becomes a number', () => {
    expect(
      countsOf([
        { table_name: 'signals', n: '42' },
        { table_name: 'candles', n: 7 },
      ]),
    ).toEqual({ signals: 42, candles: 7 });
  });

  it('come from one query over the fixed list of tables', () => {
    for (const table of COUNTED_TABLES) expect(COUNTS_SQL).toContain(`FROM ${table}`);
    expect(COUNTS_SQL.split('UNION ALL')).toHaveLength(COUNTED_TABLES.length);
  });
});
