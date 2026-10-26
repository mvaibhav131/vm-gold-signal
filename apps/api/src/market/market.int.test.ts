import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { marketSnapshotSchema } from '@vmgs/contracts';
import { WORKER_HEARTBEAT } from '@vmgs/db';

import { startPgApi, type PgApi } from '../testing/pgApi';
import { SEED_AT, startSeedWorld, type SeedWorld } from '../testing/seedWorld';
import { PostgresMarketReader } from './reader';
import { snapshotOf } from './snapshot';

const NOW = Date.UTC(2026, 9, 23, 6, 12, 0);
const MIN = 60_000;

let api: PgApi;
let world: SeedWorld;
let reader: PostgresMarketReader;

beforeAll(async () => {
  api = await startPgApi();
  world = await startSeedWorld(api);
  reader = new PostgresMarketReader(api.pool);
  for (const day of ['2026-10-13', '2026-10-22', '2026-10-23']) {
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    await api.admin.query(
      `CREATE TABLE IF NOT EXISTS ticks_${day.replaceAll('-', '')} PARTITION OF ticks FOR VALUES FROM ('${day}') TO ('${next}')`,
    );
  }
});

afterAll(async () => {
  await world.finish();
  await api.close();
});

const tick = (symbol: string, ts: number, rxAt: number, bid: number, ask: number) =>
  api.admin.query('INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES ($1, $2, $3, $4, $5)', [
    new Date(ts),
    new Date(rxAt),
    symbol,
    bid,
    ask,
  ]);

const candle = (tf: string, openTime: number, c: number, complete = true, symbol = 'XAUUSD') =>
  api.admin.query(
    `INSERT INTO candles (symbol, tf, open_time, o, h, l, c, tick_count, complete)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 10, $8)`,
    [symbol, tf, new Date(openTime), c - 0.3, c + 0.8, c - 0.9, c, complete],
  );

describe('the market reader on Postgres', () => {
  it('has no quote in an empty database: a 503 for the snapshot, not an invented price', async () => {
    const facts = await reader.facts(NOW);
    expect(facts).toMatchObject({
      quote: null,
      worker: { heartbeatAt: null, provider: null, feedState: null },
      engineDoc: null,
      engineStateDoc: null,
      openStatuses: [],
    });
    expect(() => snapshotOf(facts, NOW)).toThrow(expect.objectContaining({ status: 503 }));
  });

  it('reads the newest tick of the traded symbol (by source time, then by receive time), and no other symbol', async () => {
    await tick('XAUUSD', NOW - 30_000, NOW - 29_000, 4016.1, 4016.3);
    await tick('XAUUSD', NOW - 2000, NOW - 1500, 4017.2, 4017.4);
    await tick('XAUUSD', NOW - 2000, NOW - 900, 4017.37, 4017.55); // same source second, received later
    await tick('EURUSD', NOW - 500, NOW - 100, 1.08, 1.0801); // another symbol, newer
    const { quote } = await reader.facts(NOW);
    expect(quote).toEqual({
      sourceAt: NOW - 2000,
      receivedAt: NOW - 900,
      bid: 4017.37,
      ask: 4017.55,
    });

    // the one received later put in first: the answer does not come from the order the rows were written in
    await tick('XAUUSD', NOW - 1000, NOW - 300, 4020.1, 4020.3);
    await tick('XAUUSD', NOW - 1000, NOW - 700, 4020.9, 4021.1);
    expect((await reader.facts(NOW)).quote).toEqual({
      sourceAt: NOW - 1000,
      receivedAt: NOW - 300,
      bid: 4020.1,
      ask: 4020.3,
    });
    await api.admin.query('DELETE FROM ticks WHERE ts = $1', [new Date(NOW - 1000)]);
  });

  it('does not look for a quote further back than ten days, and finds one that is exactly ten days old', async () => {
    const old = await startPgApi();
    try {
      await old.admin.query(
        `CREATE TABLE IF NOT EXISTS ticks_20261013 PARTITION OF ticks FOR VALUES FROM ('2026-10-13') TO ('2026-10-14')`,
      );
      const add = (at: number) =>
        old.admin.query(
          `INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES ($1, $1, 'XAUUSD', 4000, 4000.2)`,
          [new Date(at)],
        );
      await add(NOW - 10 * 86_400_000 - 1000);
      expect((await new PostgresMarketReader(old.pool).facts(NOW)).quote).toBeNull();
      await add(NOW - 10 * 86_400_000);
      expect((await new PostgresMarketReader(old.pool).facts(NOW)).quote).toMatchObject({
        sourceAt: NOW - 10 * 86_400_000,
      });
    } finally {
      await old.close();
    }
  });

  it('reads the heartbeat of the worker, the pause and the state of the engine, and counts the open signals', async () => {
    await api.admin.query(
      `INSERT INTO worker_heartbeats (worker_name, heartbeat_at, metadata) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (worker_name) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at, metadata = EXCLUDED.metadata`,
      [
        WORKER_HEARTBEAT,
        new Date(NOW - 4000),
        JSON.stringify({
          mode: 'record-only',
          provider: 'biquote',
          recorder: { feedState: 'LIVE' },
        }),
      ],
    );
    await api.admin.query(
      `INSERT INTO app_settings (key, value) VALUES ('engineState', $1::jsonb), ('engine', $2::jsonb)`,
      [
        JSON.stringify({
          evaluatedAt: NOW - 2 * MIN,
          regime: 'TREND_UP',
          volBucket: 'NORMAL',
          session: 'LONDON',
          newsState: 'CLEAR',
          atr5: 4.3,
          warmup: { ready: true, progressPct: 100, missingTimeframes: [] },
          waitReasons: [{ code: 'SPREAD_OK', label: 'Spread too high: 0.90 USD' }],
        }),
        JSON.stringify({ status: 'RUNNING' }),
      ],
    );
    const running = await world.createSignal({ generatedAt: SEED_AT });
    const afterTp1 = await world.createSignal({ generatedAt: SEED_AT + MIN });
    await world.setState(
      afterTp1.id,
      {
        status: 'TP1_HIT',
        stopLossCurrent: 4017.37,
        tp1HitAt: SEED_AT + 2 * MIN,
        mfeR: 1.1,
        maeR: -0.1,
      },
      SEED_AT + 2 * MIN,
    );
    await world.createSignal({ generatedAt: SEED_AT + 2 * MIN, draft: { mode: 'BACKTEST' } });
    expect(running.id).not.toBe(afterTp1.id);

    const facts = await reader.facts(NOW);
    expect(facts.worker).toEqual({
      heartbeatAt: NOW - 4000,
      provider: 'biquote',
      feedState: 'LIVE',
    });
    expect([...facts.openStatuses].sort()).toEqual(['ACTIVE', 'TP1_HIT']);

    const snapshot = marketSnapshotSchema.parse(snapshotOf(facts, NOW));
    expect(snapshot).toMatchObject({
      bid: 4017.37,
      ask: 4017.55,
      mid: 4017.46,
      spread: 0.18,
      ageMs: 2000,
      feedState: 'LIVE',
      regime: 'TREND_UP',
      mode: 'LIVE',
      engine: {
        status: 'RUNNING',
        openCount: 2,
        openRiskR: 1,
        warmup: { ready: true, progressPct: 100, missingTimeframes: [] },
        waitReasons: [{ code: 'SPREAD_OK', label: 'Spread too high: 0.90 USD' }],
      },
    });
  });

  it('follows the pause the owner set through the API', async () => {
    api.clock.now = NOW;
    expect(
      (await api.send({ method: 'POST', url: '/api/v1/engine/pause', body: { minutes: 30 } }))
        .status,
    ).toBe(204);
    const snapshot = snapshotOf(await reader.facts(NOW), NOW);
    expect(snapshot.engine).toMatchObject({
      status: 'PAUSED',
      pausedSince: new Date(NOW).toISOString(),
    });
    expect(snapshotOf(await reader.facts(NOW + 31 * MIN), NOW + 31 * MIN).engine.status).toBe(
      'RUNNING',
    );
  });
});

describe('the candles of the reader on Postgres', () => {
  const t0 = Date.UTC(2026, 9, 22, 12, 0, 0);

  it('gives the newest complete candles of the timeframe, oldest first, from before a time, and no other timeframe or symbol', async () => {
    for (let i = 0; i < 10; i += 1) await candle('5m', t0 + i * 5 * MIN, 4000 + i);
    await candle('5m', t0 + 10 * 5 * MIN, 4010, false); // still forming: not shown
    await candle('15m', t0, 4100);
    await candle('5m', t0 + 3 * 5 * MIN, 1.0, true, 'EURUSD');

    const newest = await reader.candles('5m', 4, null);
    expect(newest.map((each) => each.c)).toEqual([4006, 4007, 4008, 4009]);
    expect(newest[0]).toEqual({
      openTime: t0 + 6 * 5 * MIN,
      o: 4005.7,
      h: 4006.8,
      l: 4005.1,
      c: 4006,
    });

    const page = await reader.candles('5m', 3, t0 + 5 * 5 * MIN); // before the sixth: the open time itself is not in it
    expect(page.map((each) => each.c)).toEqual([4002, 4003, 4004]);
    expect((await reader.candles('5m', 50, t0)).length).toBe(0);
    expect((await reader.candles('15m', 5, null)).map((each) => each.c)).toEqual([4100]);
    expect(await reader.candles('1h', 5, null)).toEqual([]);
  });
});
