import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { query } from '../../../../packages/db/test/database';
import { createPgWorld, type PgWorld } from '../lifecycle/pgHarness';
import { PostgresMarketReader } from './postgresMarketReader';
import { PostgresNewsStore } from './postgresStore';
import { newsStoreContract } from './storeContract';
import { FEEDS, MIN, T0, newItem, uuid } from './testData';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

let world: PgWorld;
let store: PostgresNewsStore;

beforeAll(async () => {
  world = await createPgWorld();
  store = new PostgresNewsStore(world.pool);
});

afterAll(async () => {
  await world.close();
});

const reset = async (): Promise<void> => {
  await query(
    world.database.url,
    'TRUNCATE news_impact_samples, news_topic_stats, news_items, news_sources, market_events, macro_events RESTART IDENTITY CASCADE',
  );
};

newsStoreContract('PostgreSQL', async () => {
  await reset();
  return {
    harness: {
      store,
      setEnabled: async (key, enabled) => {
        await query(world.database.url, 'UPDATE news_sources SET enabled = $2 WHERE key = $1', [
          key,
          enabled,
        ]);
      },
      addHighEvent: async (at) => {
        await query(
          world.database.url,
          `INSERT INTO macro_events (source, source_event_id, scheduled_at, name, importance)
           VALUES ('biquote', $1, $2, 'CPI m/m', 'high')`,
          [`e-${String(at)}`, new Date(at)],
        );
      },
    },
    done: () => Promise.resolve(),
  };
});

describe('PostgresNewsStore (details only SQL can show)', () => {
  it('does not count a medium or a low calendar event in the times of events', async () => {
    await reset();
    await store.ensureSources(FEEDS);
    for (const [id, importance] of [
      ['a', 'high'],
      ['b', 'medium'],
      ['c', 'low'],
    ] as const) {
      await query(
        world.database.url,
        `INSERT INTO macro_events (source, source_event_id, scheduled_at, name, importance)
         VALUES ('biquote', $1, $2, 'Event', $3)`,
        [id, new Date(T0), importance],
      );
    }
    expect(await store.eventTimes(T0 - MIN, T0 + MIN)).toEqual([T0]);
  });

  it('keeps the worker role inside what it may do: it can write all that the news need', async () => {
    await reset();
    await store.ensureSources(FEEDS);
    const [item] = await store.insertItems([newItem({ clusterId: uuid(1) })]);
    expect(item?.id).toMatch(/^[0-9a-f-]{36}$/);
    await store.saveSample({
      clusterId: uuid(1),
      topics: ['GEOPOLITICS_WAR'],
      impact: 'HIGH',
      publishedAt: T0,
      session: 'LONDON',
      atr5: 4,
      move2m: null,
      move5m: null,
      move10m: 2,
      maxAbs10m: 3,
    });
    await store.rebuildStats(T0);
    const id = await store.insertMove({
      kind: 'SPIKE_DOWN',
      detectedAt: T0,
      windowS: 60,
      moveUsd: 4,
      moveAtr: 3.1,
      spread: null,
      headlines: [],
      meta: {},
    });
    expect(id).toBe(1);
  });

  it('refuses a row that breaks a rule of the schema, so the stores cannot be fooled into one', async () => {
    await reset();
    await store.ensureSources(FEEDS);
    await expect(store.insertItems([newItem({ summary: 'x'.repeat(301) })])).rejects.toThrow();
    await expect(store.insertItems([newItem({ impact: 'SEVERE' as never })])).rejects.toThrow();
    expect(await store.items()).toEqual([]);
  });

  it('writes a story that has a topic the contract does not know without losing it', async () => {
    await reset();
    await store.ensureSources(FEEDS);
    await store.insertItems([newItem({ topics: ['FED_RATES', 'RISK_OFF', 'GOLD_DIRECT'] })]);
    expect((await store.items())[0]?.topics).toEqual(['FED_RATES', 'RISK_OFF', 'GOLD_DIRECT']);
  });
});

describe('PostgresMarketReader', () => {
  it('reads the ticks of the traded symbol and the complete candles that had closed', async () => {
    await reset();
    const day = new Date(T0).toISOString().slice(0, 10);
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    await query(
      world.database.url,
      `CREATE TABLE IF NOT EXISTS ticks_${day.replaceAll('-', '')} PARTITION OF ticks FOR VALUES FROM ('${day}') TO ('${next}')`,
    );
    for (const [offset, symbol, bid, ask] of [
      [-1000, 'XAUUSD', 4000.1, 4000.3],
      [1000, 'XAUUSD', 4000.5, 4000.7],
      [2000, 'EURUSD', 1.1, 1.1002],
      [15_000, 'XAUUSD', 3997.4, 3997.8],
      [15_001, 'XAUUSD', 3990, 3990.4],
    ] as const) {
      await query(
        world.database.url,
        'INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES ($1, $1, $2, $3, $4)',
        [new Date(T0 + offset), symbol, bid, ask],
      );
    }
    const candle = (tf: string, openTime: number, complete: boolean, o: number) =>
      query(
        world.database.url,
        `INSERT INTO candles (symbol, tf, open_time, o, h, l, c, complete)
         VALUES ('XAUUSD', $1, $2, $3::numeric, $3::numeric + 1, $3::numeric - 1, $3::numeric, $4)`,
        [tf, new Date(openTime), o, complete],
      );
    for (let i = 0; i < 6; i += 1) await candle('5m', T0 + i * 5 * MIN, i !== 5, 4000 + i);
    await candle('1m', T0, true, 4000);
    await candle('1m', T0 + MIN, true, 4001);
    await candle('1m', T0 + 2 * MIN, false, 4002);

    const reader = new PostgresMarketReader(world.pool, 'XAUUSD');
    expect(await reader.ticks(T0 - 1000, T0 + 15_000)).toEqual([
      { ts: T0 - 1000, bid: 4000.1, ask: 4000.3 },
      { ts: T0 + 1000, bid: 4000.5, ask: 4000.7 },
      { ts: T0 + 15_000, bid: 3997.4, ask: 3997.8 },
    ]);
    // 5m candles opened at T0, +5, +10, +15, +20 (complete) and +25 (not complete)
    const closed = await reader.closedCandles('5m', T0 + 15 * MIN, 10);
    expect(closed.map((c) => c.openTime)).toEqual([T0, T0 + 5 * MIN, T0 + 10 * MIN]);
    expect(closed[2]).toEqual({ openTime: T0 + 10 * MIN, o: 4002, h: 4003, l: 4001, c: 4002 });
    expect(
      (await reader.closedCandles('5m', T0 + 15 * MIN - 1, 10)).map((c) => c.openTime),
    ).toEqual([T0, T0 + 5 * MIN]);
    expect((await reader.closedCandles('5m', T0 + 60 * MIN, 2)).map((c) => c.openTime)).toEqual([
      T0 + 15 * MIN,
      T0 + 20 * MIN,
    ]);
    expect((await reader.closedCandles('1m', T0 + 10 * MIN, 10)).map((c) => c.openTime)).toEqual([
      T0,
      T0 + MIN,
    ]);
    expect(
      (await reader.candlesBetween('5m', T0 + 5 * MIN, T0 + 15 * MIN)).map((c) => c.openTime),
    ).toEqual([T0 + 5 * MIN, T0 + 10 * MIN]);
    expect(await reader.candlesBetween('1m', T0 + 2 * MIN, T0 + 3 * MIN)).toEqual([]);
    expect(
      await new PostgresMarketReader(world.pool, 'EURUSD').closedCandles('5m', T0 + MIN * 60, 5),
    ).toEqual([]);
  });

  it('puts the ticks in the order of their time, whatever order they were received in', async () => {
    await reset();
    const day = new Date(T0).toISOString().slice(0, 10);
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    await query(
      world.database.url,
      `CREATE TABLE IF NOT EXISTS ticks_${day.replaceAll('-', '')} PARTITION OF ticks FOR VALUES FROM ('${day}') TO ('${next}')`,
    );
    await query(world.database.url, 'TRUNCATE ticks');
    // the later tick was received first
    for (const [ts, rxAt, bid] of [
      [T0 + 2000, T0 + 3000, 4002],
      [T0 + 1000, T0 + 9000, 4001],
    ] as const) {
      await query(
        world.database.url,
        "INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES ($1, $2, 'XAUUSD', $3, $3 + 0.2)",
        [new Date(ts), new Date(rxAt), bid],
      );
    }
    const reader = new PostgresMarketReader(world.pool, 'XAUUSD');
    expect((await reader.ticks(T0, T0 + 5000)).map((tick) => tick.bid)).toEqual([4001, 4002]);
  });
});
