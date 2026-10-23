import { readFile } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateTypes } from './codegen';
import { createDb, createPool } from './pool';
import { type TestDatabase, query } from '../test/database';
import { STRATEGY_ID, insert, strategyVersionRow } from '../test/fixtures';
import { migratedDatabase } from '../test/setup';

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
});

afterAll(async () => {
  await database.drop();
});

const normalise = (text: string) => text.replaceAll('\r\n', '\n');

describe('generated Kysely types', () => {
  it('are up to date with the migrated database', async () => {
    const generated = await generateTypes(database.url);
    const committed = await readFile(new URL('./types.generated.ts', import.meta.url), 'utf8');
    expect(
      normalise(committed) === normalise(generated),
      'src/types.generated.ts is out of date: run "pnpm --filter @vmgs/db codegen" and commit the result',
    ).toBe(true);
  });

  it('are deterministic', async () => {
    expect(await generateTypes(database.url)).toBe(await generateTypes(database.url));
  });

  it('cover every table and view and leave out partitions and the migration log', async () => {
    const generated = await generateTypes(database.url);
    for (const name of ['signals', 'signal_history_v', 'ticks', 'auth_owner', 'storage_usage_v']) {
      expect(generated).toContain(`  ${name}: `);
    }
    expect(generated).not.toMatch(/ticks_\d{8}/);
    expect(generated).not.toContain('schema_migrations');
  });

  it('mark identity columns as written by the database only', async () => {
    const generated = await generateTypes(database.url);
    expect(generated).toContain('seq: GeneratedAlways<Int8>;');
    expect(generated).toContain('is_win: GeneratedAlways<boolean | null>;');
    expect(generated).toContain('id: Generated<string>;');
  });
});

describe('typed queries on the real database', () => {
  it('inserts and reads through Kysely with the types of the generated file', async () => {
    const pool = createPool(database.url, { max: 2 });
    const db = createDb(pool);
    try {
      await insert(database.url, 'strategy_versions', strategyVersionRow());
      const inserted = await db
        .insertInto('signals')
        .values({
          side: 'BUY',
          strategy_version_id: STRATEGY_ID,
          exit_profile: 'EP1_PARTIAL',
          mode: 'LIVE',
          generated_at: new Date('2026-10-23T06:10:00Z'),
          source_at: new Date('2026-10-23T06:10:00Z'),
          entry: '4017.370',
          max_valid_entry: '4017.550',
          entry_valid_until: new Date('2026-10-23T06:13:00Z'),
          stop_loss: '4010.900',
          tp1: '4023.840',
          risk_distance: '6.470',
          atr5: '4.300',
          time_stop_at: new Date('2026-10-23T08:10:00Z'),
          regime: 'TREND_UP',
          session: 'LONDON',
          vol_bucket: 'NORMAL',
          news_state: 'CLEAR',
          setup_key: 'kysely-1',
          quality_score: '78',
          grouped_scores: JSON.stringify([]),
          hard_gates: JSON.stringify([]),
          feature_snapshot: JSON.stringify({}),
          explanation: JSON.stringify({}),
          evidence: JSON.stringify({ winRate: 0.58 }),
        })
        .returning(['id', 'seq', 'entry', 'generated_at', 'evidence'])
        .executeTakeFirstOrThrow();

      expect(inserted.entry).toBe('4017.370');
      expect(inserted.generated_at).toEqual(new Date('2026-10-23T06:10:00Z'));
      expect(inserted.evidence).toEqual({ winRate: 0.58 });
      expect(typeof inserted.id).toBe('string');
      expect(Number(inserted.seq)).toBeGreaterThan(0);
    } finally {
      await db.destroy();
    }
  });

  it('returns date columns as YYYY-MM-DD text, not as a Date shifted by the local time zone', async () => {
    const pool = createPool(database.url, { max: 1 });
    const db = createDb(pool);
    try {
      await query(
        database.url,
        "INSERT INTO stats_monthly (month, strategy_key) VALUES ('2026-10-01', '*')",
      );
      const row = await db.selectFrom('stats_monthly').select('month').executeTakeFirstOrThrow();
      expect(row.month).toBe('2026-10-01');
    } finally {
      await db.destroy();
    }
  });
});
