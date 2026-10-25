import type { MarketCandle } from '@vmgs/core';
import { createPool } from '@vmgs/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { query } from '../../../../packages/db/test/database';
import type { TestDatabase } from '../../../../packages/db/test/database';
import { migratedDatabase } from '../../../../packages/db/test/setup';
import { PostgresBootstrapStore } from './store';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
/** A Wednesday, 10:00 UTC. */
const T = Date.UTC(2023, 0, 4, 10, 0, 0);

let database: TestDatabase;
let pool: ReturnType<typeof createPool>;
let store: PostgresBootstrapStore;

beforeAll(async () => {
  database = await migratedDatabase();
  await query(database.url, "ALTER ROLE vmgs_worker LOGIN PASSWORD 'worker-pass'");
  pool = createPool(database.urlFor('vmgs_worker', 'worker-pass'), { max: 2 });
  store = new PostgresBootstrapStore(pool);
});

afterAll(async () => {
  await pool.end();
  await database.drop();
});

const candle = (
  change: Partial<MarketCandle> & Pick<MarketCandle, 'tf' | 'openTime'>,
): MarketCandle => ({
  symbol: 'XAUUSD',
  o: 1800.1,
  h: 1801.2,
  l: 1799.3,
  c: 1800.4,
  spreadAvg: null,
  spreadMax: null,
  tickCount: 0,
  complete: true,
  source: 'histdata_bootstrap',
  ...change,
});

interface Row {
  o: string;
  h: string;
  c: string;
  spread_avg: string | null;
  tick_count: number;
  complete: boolean;
  source: string;
}

const rowOf = async (tf: string, openTime: number): Promise<Row | undefined> =>
  (
    await query<Row>(
      database.url,
      'SELECT o, h, c, spread_avg, tick_count, complete, source FROM candles WHERE symbol = $1 AND tf = $2 AND open_time = $3',
      ['XAUUSD', tf, new Date(openTime)],
    )
  )[0];

const countRows = async (where = 'true'): Promise<number> =>
  Number(
    (
      await query<{ n: string }>(database.url, `SELECT count(*) AS n FROM candles WHERE ${where}`)
    )[0]?.n,
  );

describe('write', () => {
  it('stores history candles as complete bootstrap candles with their prices', async () => {
    const added = await store.write([
      candle({ tf: '5m', openTime: T }),
      candle({ tf: '1h', openTime: T, o: 1802.001, c: 1803.5 }),
    ]);
    expect(added).toBe(2);
    expect(await rowOf('5m', T)).toEqual({
      o: '1800.100',
      h: '1801.200',
      c: '1800.400',
      spread_avg: null,
      tick_count: 0,
      complete: true,
      source: 'histdata_bootstrap',
    });
    expect(await rowOf('1h', T)).toMatchObject({ o: '1802.001', c: '1803.500' });
  });

  it('keeps the spread and the tick count of a candle that has them', async () => {
    await store.write([
      candle({ tf: '15m', openTime: T, spreadAvg: 0.25, spreadMax: 0.4, tickCount: 77 }),
    ]);
    expect(await rowOf('15m', T)).toMatchObject({ spread_avg: '0.250', tick_count: 77 });
  });

  it('writes a candle that is already there as nothing, and leaves it as it was', async () => {
    const added = await store.write([
      candle({ tf: '5m', openTime: T, o: 1.5, h: 2, l: 1, c: 1.7 }),
    ]);
    expect(added).toBe(0);
    expect(await rowOf('5m', T)).toMatchObject({ o: '1800.100' });
  });

  it('never overwrites a candle the worker recorded', async () => {
    await query(
      database.url,
      `INSERT INTO candles (symbol, tf, open_time, o, h, l, c, spread_avg, tick_count, complete, source)
       VALUES ('XAUUSD', '5m', $1, 2000, 2001, 1999, 2000.5, 0.12, 300, true, 'live')`,
      [new Date(T + 5 * MINUTE)],
    );
    const added = await store.write([candle({ tf: '5m', openTime: T + 5 * MINUTE })]);
    expect(added).toBe(0);
    expect(await rowOf('5m', T + 5 * MINUTE)).toMatchObject({
      o: '2000.000',
      spread_avg: '0.120',
      source: 'live',
    });
  });

  it('counts only the new ones of a mixed batch', async () => {
    const added = await store.write([
      candle({ tf: '5m', openTime: T }),
      candle({ tf: '5m', openTime: T + 10 * MINUTE }),
      candle({ tf: '5m', openTime: T + 15 * MINUTE }),
    ]);
    expect(added).toBe(2);
  });

  it('writes more candles than one statement holds, and writes nothing for no candles', async () => {
    const before = await countRows("tf = '1d'");
    const many = Array.from({ length: 2_500 }, (_, i) =>
      candle({ tf: '1d', openTime: Date.UTC(2000, 0, 1) + i * 86_400_000 }),
    );
    expect(await store.write(many)).toBe(2_500);
    expect(await countRows("tf = '1d'")).toBe(before + 2_500);
    expect(await store.write([])).toBe(0);
  });
});

describe('liveFrom', () => {
  it('is null while the worker has recorded no minute, whatever the history holds', async () => {
    expect(await store.liveFrom()).toBeNull();
  });

  it('is the first live 1m candle, and not a live candle of another timeframe or a bootstrap minute', async () => {
    const insert = (tf: string, at: number, source: string) =>
      query(
        database.url,
        `INSERT INTO candles (symbol, tf, open_time, o, h, l, c, complete, source)
         VALUES ('XAUUSD', $1, $2, 1, 1, 1, 1, true, $3)`,
        [tf, new Date(at), source],
      );
    await insert('1m', T - 10 * HOUR, 'histdata_bootstrap');
    await insert('1d', T - 30 * HOUR, 'live');
    expect(await store.liveFrom()).toBeNull();
    await insert('1m', T + 3 * HOUR, 'live');
    await insert('1m', T + HOUR, 'live');
    expect(await store.liveFrom()).toBe(T + HOUR);
  });
});

describe('spreadRows', () => {
  const insertFive = (at: number, spread: number | null, source = 'live', symbol = 'XAUUSD') =>
    query(
      database.url,
      `INSERT INTO candles (symbol, tf, open_time, o, h, l, c, spread_avg, complete, source)
       VALUES ($1, '5m', $2, 1, 1, 1, 1, $3, true, $4)`,
      [symbol, new Date(at), spread, source],
    );

  it('gives the median and the 90th percentile of the live 5m spreads by UTC hour', async () => {
    const day = Date.UTC(2024, 5, 3);
    for (let i = 0; i < 40; i += 1)
      await insertFive(day + 9 * HOUR + i * MINUTE, i < 36 ? 0.1 : 0.5);
    for (let i = 0; i < 6; i += 1) await insertFive(day + 20 * HOUR + i * MINUTE, 0.3);
    const rows = await store.spreadRows(day);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ hour: 9, n: 40 });
    expect(rows[0]?.median).toBeCloseTo(0.1, 9);
    expect(rows[0]?.p90).toBeCloseTo(0.14, 9);
    expect(rows[1]).toMatchObject({ hour: 20, n: 6 });
    expect(rows[1]?.median).toBeCloseTo(0.3, 9);
  });

  it('leaves out bootstrap candles, candles with no spread, other symbols, other timeframes and older candles', async () => {
    const day = Date.UTC(2025, 5, 3);
    await insertFive(day + 4 * HOUR, 0.2);
    await insertFive(day + 4 * HOUR + MINUTE, 0.2, 'histdata_bootstrap');
    await insertFive(day + 4 * HOUR + 2 * MINUTE, null);
    await insertFive(day + 4 * HOUR + 3 * MINUTE, 0.2, 'live', 'DXY');
    await query(
      database.url,
      `INSERT INTO candles (symbol, tf, open_time, o, h, l, c, spread_avg, complete, source)
       VALUES ('XAUUSD', '15m', $1, 1, 1, 1, 1, 0.2, true, 'live')`,
      [new Date(day + 4 * HOUR + 4 * MINUTE)],
    );
    await insertFive(day - 2 * HOUR, 0.2);
    const rows = await store.spreadRows(day);
    expect(rows).toEqual([
      {
        hour: 4,
        median: expect.closeTo(0.2, 9) as number,
        p90: expect.closeTo(0.2, 9) as number,
        n: 1,
      },
    ]);
  });

  it('takes candles from the instant asked, the edge in', async () => {
    const day = Date.UTC(2026, 5, 3);
    await insertFive(day + 6 * HOUR, 0.2);
    expect((await store.spreadRows(day + 6 * HOUR)).map((row) => row.n)).toEqual([1]);
    expect(await store.spreadRows(day + 6 * HOUR + 1)).toEqual([]);
  });
});
