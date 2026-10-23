import {
  AUTOPSY_STATUSES,
  CANDLE_SOURCES,
  FEED_INCIDENT_KINDS,
  GROUP_STATES,
  MACRO_IMPORTANCE,
  MARKET_EVENT_KINDS,
  NEWS_IMPACTS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  RESULTS,
  SIDES,
  SIGNAL_EVENT_TYPES,
  SIGNAL_MODES,
  SIGNAL_STATUSES,
  STATS_SCOPES,
  STRATEGY_STATUSES,
  TIMEFRAMES,
} from '@vmgs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { query, type TestDatabase } from '../test/database';
import { migratedDatabase } from '../test/setup';

// The vocabularies of the database and of the code must be the same lists, or a value the engine
// produces could be refused by a CHECK constraint (or the reverse). The code side is the single
// source (packages/core/src/domain.ts); this test reads the CHECK constraints of the real database.

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
});

afterAll(async () => {
  await database.drop();
});

/** The values of `CHECK (column IN ('a', 'b', ...))` as Postgres stores it. */
async function allowedValues(table: string, column: string): Promise<string[]> {
  const rows = await query<{ def: string }>(
    database.url,
    `SELECT pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = $1 AND c.contype = 'c'`,
    [table],
  );
  const matches = rows
    .map((row) => row.def)
    .filter((def) => def.includes(`(${column} = ANY (ARRAY[`));
  if (matches.length !== 1) {
    throw new Error(
      `expected one IN-list check on ${table}.${column}, found ${String(matches.length)}`,
    );
  }
  const list = /ARRAY\[(.*?)\]\)/.exec(matches[0] ?? '')?.[1] ?? '';
  return [...list.matchAll(/'([^']*)'::text/g)].map((m) => m[1] ?? '');
}

const PARITY: { table: string; column: string; values: readonly string[] }[] = [
  { table: 'candles', column: 'tf', values: TIMEFRAMES },
  { table: 'candles', column: 'source', values: CANDLE_SOURCES },
  { table: 'feed_incidents', column: 'kind', values: FEED_INCIDENT_KINDS },
  { table: 'strategy_versions', column: 'status', values: STRATEGY_STATUSES },
  { table: 'signals', column: 'side', values: SIDES },
  { table: 'signals', column: 'mode', values: SIGNAL_MODES },
  { table: 'signal_state', column: 'status', values: SIGNAL_STATUSES },
  { table: 'signal_events', column: 'event_type', values: SIGNAL_EVENT_TYPES },
  { table: 'signal_outcomes', column: 'result', values: RESULTS },
  { table: 'signal_autopsies', column: 'status', values: AUTOPSY_STATUSES },
  { table: 'rejections', column: 'side', values: SIDES },
  { table: 'stats_bucket', column: 'scope', values: STATS_SCOPES },
  { table: 'evidence_group_stats', column: 'scope', values: STATS_SCOPES },
  { table: 'evidence_group_stats', column: 'state', values: GROUP_STATES },
  { table: 'notification_outbox', column: 'channel', values: NOTIFICATION_CHANNELS },
  { table: 'notification_outbox', column: 'status', values: NOTIFICATION_STATUSES },
  { table: 'macro_events', column: 'importance', values: MACRO_IMPORTANCE },
  { table: 'news_items', column: 'impact', values: NEWS_IMPACTS },
  { table: 'news_impact_samples', column: 'impact', values: NEWS_IMPACTS },
  { table: 'news_topic_stats', column: 'impact', values: NEWS_IMPACTS },
  { table: 'market_events', column: 'kind', values: MARKET_EVENT_KINDS },
];

describe('database CHECK lists equal the vocabularies of the code', () => {
  it.each(PARITY)('$table.$column', async ({ table, column, values }) => {
    expect([...(await allowedValues(table, column))].sort()).toEqual([...values].sort());
  });

  it('reads a list correctly (guards the parser of this test)', async () => {
    expect(await allowedValues('candles', 'tf')).toEqual(['1m', '5m', '15m', '1h', '4h', '1d']);
  });
});
