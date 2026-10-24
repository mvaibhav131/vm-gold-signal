import { TRADED_SYMBOL, type FeedGap, type MarketCandle, type TickInput } from '@vmgs/core';
import { createPool } from '@vmgs/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { query, type TestDatabase } from '../../../packages/db/test/database';
import { migratedDatabase } from '../../../packages/db/test/setup';
import { PostgresRecorderStore } from './postgresStore';
import type { RecorderBatch } from './store';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

const SYMBOLS = [TRADED_SYMBOL, 'DXY'];
let database: TestDatabase;
let pool: ReturnType<typeof createPool>;
let store: PostgresRecorderStore;

beforeAll(async () => {
  database = await migratedDatabase();
  await query(database.url, "ALTER ROLE vmgs_worker LOGIN PASSWORD 'worker-pass'");
  pool = createPool(database.urlFor('vmgs_worker', 'worker-pass'), { max: 4 });
  store = new PostgresRecorderStore(pool);
});

afterAll(async () => {
  await pool.end();
  await database.drop();
});

function candle(openTime: number, change: Partial<MarketCandle> = {}): MarketCandle {
  return {
    symbol: TRADED_SYMBOL,
    tf: '1m',
    openTime,
    o: 4017,
    h: 4017.2,
    l: 4017,
    c: 4017.1,
    spreadAvg: 0.18,
    spreadMax: 0.2,
    tickCount: 2,
    complete: true,
    source: 'live',
    ...change,
  };
}

function tick(ts: number, change: Partial<TickInput> = {}): TickInput {
  return {
    ts,
    rxAt: ts + 500,
    symbol: TRADED_SYMBOL,
    bid: 4017,
    ask: 4017.2,
    ...change,
  };
}

function batch(change: Partial<RecorderBatch> = {}): RecorderBatch {
  return {
    ticks: [],
    candles: [],
    gaps: [],
    incidents: [],
    ...change,
  };
}

describe('PostgresRecorderStore', () => {
  it('writes partitioned ticks, upserts candles, and restores the candle/tick replay boundary', async () => {
    await store.ensureTickPartitions();
    const now = Date.now();
    const minuteStart = Math.floor((now - 180_000) / 60_000) * 60_000;
    const first = tick(minuteStart + 5_000);
    const afterClose = tick(minuteStart + 65_000, { bid: 4017.1, ask: 4017.3 });
    const original = candle(minuteStart);
    const corrected = candle(minuteStart, { h: 4017.5, tickCount: 3 });

    await store.writeBatch(batch({ ticks: [first], candles: [original] }));
    await store.writeBatch(batch({ ticks: [afterClose], candles: [corrected] }));

    const recovery = await store.loadRecovery(SYMBOLS, TRADED_SYMBOL, now);
    const savedMinute = recovery.minutesBySymbol
      .get(TRADED_SYMBOL)
      ?.find((item) => item.openTime === minuteStart);
    expect(savedMinute).toMatchObject({ h: 4017.5, tickCount: 3 });
    expect(recovery.latestTicks).toContainEqual(afterClose);
    expect(recovery.previousTradedTick).toEqual(first);
    const replayed = [];
    for await (const item of store.readTicks(
      TRADED_SYMBOL,
      recovery.replayFromMs,
      recovery.replayUntilMs,
    )) {
      replayed.push(item);
    }
    expect(replayed).toEqual([afterClose]);
    const rows = await query<{ count: string }>(
      database.url,
      'SELECT count(*)::text AS count FROM ticks WHERE symbol = $1 AND ts >= $2',
      [TRADED_SYMBOL, new Date(minuteStart)],
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });

  it('stores gap flags idempotently and closes a feed incident by its process-local id', async () => {
    const startMs = Date.now() - 90_000;
    const gap: FeedGap = {
      startMs,
      endMs: startMs + 70_000,
      durationMs: 70_000,
      kind: 'FEED',
    };
    const record = { symbol: TRADED_SYMBOL, gap };
    const opened = {
      localId: 77,
      kind: 'STALE' as const,
      startedAt: startMs,
      endedAt: null,
      details: { reason: 'no ticks' },
    };
    const closed = { ...opened, endedAt: startMs + 80_000 };

    expect((await store.writeBatch(batch({ gaps: [record] }))).gaps).toBe(1);
    expect((await store.writeBatch(batch({ gaps: [record] }))).gaps).toBe(0);
    await store.writeBatch(batch({ incidents: [{ phase: 'OPEN', incident: opened }] }));
    await store.writeBatch(batch({ incidents: [{ phase: 'CLOSE', incident: closed }] }));

    const rows = await query<{
      kind: string;
      started_at: Date;
      ended_at: Date | null;
      details: Record<string, unknown>;
    }>(
      database.url,
      `SELECT kind, started_at, ended_at, details FROM feed_incidents
       WHERE started_at >= $1 ORDER BY id`,
      [new Date(startMs - 1)],
    );
    expect(rows.filter((row) => row.kind === 'GAP')).toHaveLength(1);
    expect(rows.find((row) => row.kind === 'GAP')?.details).toMatchObject({
      symbol: TRADED_SYMBOL,
      gapKind: 'FEED',
      weekend: false,
    });
    const incident = rows.find((row) => row.kind === 'STALE');
    expect(incident?.ended_at?.getTime()).toBe(closed.endedAt);
    expect(incident?.details).toMatchObject({ close: { at: closed.endedAt } });
  });

  it('rolls back ticks when a candle in the same batch is invalid', async () => {
    await store.ensureTickPartitions();
    const now = Date.now();
    const invalidCandle = candle(now, { h: 4016, l: 4017 });
    await expect(
      store.writeBatch(
        batch({
          ticks: [tick(now, { bid: 4017.4, ask: 4017.6 })],
          candles: [invalidCandle],
        }),
      ),
    ).rejects.toThrow();
    const rows = await query<{ count: string }>(
      database.url,
      'SELECT count(*)::text AS count FROM ticks WHERE ts = $1 AND bid = 4017.4',
      [new Date(now)],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('upserts the worker heartbeat and closes incidents left open by a restart', async () => {
    const now = Date.now();
    await store.writeHeartbeat('recorder-test', now, { state: 'LIVE' });
    await store.writeHeartbeat('recorder-test', now + 1_000, { state: 'STALE' });
    const heartbeat = await query<{ heartbeat_at: Date; metadata: Record<string, unknown> }>(
      database.url,
      "SELECT heartbeat_at, metadata FROM worker_heartbeats WHERE worker_name = 'recorder-test'",
    );
    expect(heartbeat).toHaveLength(1);
    expect(heartbeat[0]?.heartbeat_at.getTime()).toBe(now + 1_000);
    expect(heartbeat[0]?.metadata).toEqual({ state: 'STALE' });

    await pool.query(
      "INSERT INTO feed_incidents (kind, started_at, details) VALUES ('STALE', $1, '{}'::jsonb)",
      [new Date(now)],
    );
    expect(await store.closeOpenIncidents(now + 5_000)).toBe(1);
    const incident = await query<{ ended_at: Date; details: Record<string, unknown> }>(
      database.url,
      "SELECT ended_at, details FROM feed_incidents WHERE kind = 'STALE' AND started_at = $1",
      [new Date(now)],
    );
    expect(incident[0]?.ended_at.getTime()).toBe(now + 5_000);
    expect(incident[0]?.details).toEqual({ closedOnRestart: true });
  });
});
