import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { query } from '../../../../packages/db/test/database';
import { createPgWorld, type PgWorld } from '../lifecycle/pgHarness';
import { PostgresCalendarStore } from './postgresStore';
import { calendarStoreContract } from './storeContract';
import { T0, providerEvent } from './testData';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

let world: PgWorld;
let store: PostgresCalendarStore;

beforeAll(async () => {
  world = await createPgWorld();
  store = new PostgresCalendarStore(world.pool, 'XAUUSD');
});

afterAll(async () => {
  await world.close();
});

const reset = async (): Promise<void> => {
  await query(world.database.url, 'TRUNCATE macro_events');
  await query(world.database.url, "DELETE FROM worker_heartbeats WHERE worker_name = 'calendar'");
};

calendarStoreContract('PostgreSQL', async () => {
  await reset();
  return {
    harness: {
      store,
      surprise: async (id) => {
        const rows = await query<{ surprise: unknown }>(
          world.database.url,
          "SELECT raw->'surprise' AS surprise FROM macro_events WHERE id = $1",
          [id],
        );
        return (rows[0]?.surprise ?? null) as { sigma: number; n: number; std: number } | null;
      },
    },
    done: () => Promise.resolve(),
  };
});

describe('PostgresCalendarStore (details only SQL can show)', () => {
  it('keeps the provider details in raw, beside the columns the schema has', async () => {
    await reset();
    await store.upsert([providerEvent({ actual: 0.5 })], T0);
    const [row] = await query<{
      source: string;
      source_event_id: string;
      raw: Record<string, unknown>;
    }>(world.database.url, 'SELECT source, source_event_id, raw FROM macro_events');
    expect(row?.source).toBe('biquote');
    expect(row?.source_event_id).toBe('mql5:277492');
    expect(row?.raw).toEqual({
      eventId: 'mql5:840030005',
      period: '2026-09-01T00:00:00Z',
      digits: 1,
      timeMode: 'exact',
      type: 'indicator',
      revision: 0,
      origin: 'mql5',
      sourceUrl: 'https://www.bls.gov',
    });
  });

  it('does not touch an event that did not change (last_updated_at stays)', async () => {
    await reset();
    await store.upsert([providerEvent()], T0);
    await store.upsert([providerEvent()], T0 + 60_000);
    const [row] = await query<{ last_updated_at: Date }>(
      world.database.url,
      'SELECT last_updated_at FROM macro_events',
    );
    expect(row?.last_updated_at.getTime()).toBe(T0);
    await store.upsert([providerEvent({ forecast: 0.2 })], T0 + 120_000);
    const [after] = await query<{ last_updated_at: Date }>(
      world.database.url,
      'SELECT last_updated_at FROM macro_events',
    );
    expect(after?.last_updated_at.getTime()).toBe(T0 + 120_000);
  });

  it('is allowed by the database for the worker role: a row with every importance it can have', async () => {
    await reset();
    const result = await store.upsert(
      [
        providerEvent({ sourceEventId: 'l', importance: 'low' }),
        providerEvent({ sourceEventId: 'm', importance: 'medium' }),
        providerEvent({ sourceEventId: 'h', importance: 'high' }),
      ],
      T0,
    );
    expect(result.inserted).toBe(3);
  });

  it('reads the ticks of the traded symbol only, from and until a time, by time', async () => {
    await reset();
    const day = new Date(T0).toISOString().slice(0, 10);
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    await query(
      world.database.url,
      `CREATE TABLE IF NOT EXISTS ticks_${day.replaceAll('-', '')} PARTITION OF ticks FOR VALUES FROM ('${day}') TO ('${next}')`,
    );
    const at = (offset: number) => new Date(T0 + offset);
    for (const [offset, symbol, bid, ask] of [
      [1000, 'XAUUSD', 4000.5, 4000.7],
      [-1000, 'XAUUSD', 4000.1, 4000.3],
      [2000, 'EURUSD', 1.1, 1.1002],
      [15_000, 'XAUUSD', 3997.4, 3997.8],
      [15_001, 'XAUUSD', 3990, 3990.4],
    ] as const) {
      await query(
        world.database.url,
        'INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES ($1, $1, $2, $3, $4)',
        [at(offset), symbol, bid, ask],
      );
    }
    expect(await store.ticks(T0 - 1000, T0 + 15_000)).toEqual([
      { ts: T0 - 1000, bid: 4000.1, ask: 4000.3 },
      { ts: T0 + 1000, bid: 4000.5, ask: 4000.7 },
      { ts: T0 + 15_000, bid: 3997.4, ask: 3997.8 },
    ]);
  });
});
