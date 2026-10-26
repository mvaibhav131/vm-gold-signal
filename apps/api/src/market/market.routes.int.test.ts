import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  candlesResponseSchema,
  marketSnapshotSchema,
  type CandlesResponse,
  type OVERLAYS,
} from '@vmgs/contracts';
import type { StructureCandle } from '@vmgs/core';
import { WORKER_HEARTBEAT } from '@vmgs/db';

import { at, marketCandles } from '../../../../packages/core/src/levels/test-data';
import { startPgApi, type PgApi } from '../testing/pgApi';
import { PostgresChartLayers } from './layers';
import { computeOverlays, overlayWarmup } from './overlays';
import { PostgresMarketReader } from './reader';

const MIN = 60_000;
/** A Friday morning: the 12:00 5m candle has closed, the 11:45 15m and the 11:00 1h candles are the newest of theirs. */
const NOW = at('2026-10-23T12:07');

let api: PgApi;

beforeAll(async () => {
  api = await startPgApi();
  api.clock.now = NOW;
  for (const day of ['2026-10-23']) {
    await api.admin.query(
      `CREATE TABLE IF NOT EXISTS ticks_${day.replaceAll('-', '')} PARTITION OF ticks FOR VALUES FROM ('${day}') TO ('2026-10-24')`,
    );
  }
});

afterAll(async () => {
  await api.close();
});

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

function aggregate(candles: readonly StructureCandle[], ms: number): StructureCandle[] {
  const out: StructureCandle[] = [];
  for (const candle of candles) {
    const openTime = Math.floor(candle.openTime / ms) * ms;
    const last = out.at(-1);
    if (last?.openTime === openTime) {
      out[out.length - 1] = {
        openTime,
        o: last.o,
        h: Math.max(last.h, candle.h),
        l: Math.min(last.l, candle.l),
        c: candle.c,
      };
    } else {
      out.push({ openTime, o: candle.o, h: candle.h, l: candle.l, c: candle.c });
    }
  }
  return out;
}

const closedBy = (candles: readonly StructureCandle[], ms: number): StructureCandle[] =>
  candles.filter((c) => c.openTime + ms <= NOW);

const five = marketCandles('2026-10-05T00:00', '2026-10-23T12:30', 12).map((c) => ({
  openTime: c.openTime,
  o: round3(c.o),
  h: round3(c.h),
  l: round3(c.l),
  c: round3(c.c),
}));

async function seed(tf: string, candles: readonly StructureCandle[]): Promise<void> {
  await api.admin.query(
    `INSERT INTO candles (symbol, tf, open_time, o, h, l, c, tick_count, complete)
     SELECT 'XAUUSD', $1, x.t, x.o, x.h, x.l, x.c, 10, true
       FROM unnest($2::timestamptz[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[])
            AS x(t, o, h, l, c)`,
    [
      tf,
      candles.map((c) => new Date(c.openTime)),
      candles.map((c) => c.o),
      candles.map((c) => c.h),
      candles.map((c) => c.l),
      candles.map((c) => c.c),
    ],
  );
}

const get = (query: string) => api.send({ url: `/api/v1/market/candles?${query}` });

async function candles(query: string): Promise<CandlesResponse> {
  const reply = await get(query);
  expect(reply.status).toBe(200);
  return candlesResponseSchema.parse(reply.json());
}

describe('the market routes on an empty database', () => {
  it('have no quote to show: a 503 for the snapshot, and nothing drawn on the chart', async () => {
    const snapshot = await api.send({ url: '/api/v1/market/snapshot' });
    expect(snapshot.status).toBe(503);
    expect(snapshot.headers['content-type']).toContain('application/problem+json');

    expect(await candles('tf=15m&objects=zones,trendlines,patterns,fib')).toEqual({
      candles: [],
      overlays: {},
      levels: [],
      objects: [],
    });
  });
});

describe('the market routes on stored data', () => {
  const quarters = aggregate(five, 15 * MIN);
  const hours = aggregate(five, 60 * MIN);
  const shownQuarters = closedBy(quarters, 15 * MIN);

  beforeAll(async () => {
    await seed('5m', closedBy(five, 5 * MIN));
    await seed('15m', shownQuarters);
    await seed('1h', closedBy(hours, 60 * MIN));
    await api.admin.query(
      'INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES ($1, $2, $3, $4, $5)',
      [new Date(NOW - 3000), new Date(NOW - 2500), 'XAUUSD', 4017.37, 4017.55],
    );
    await api.admin.query(
      `INSERT INTO worker_heartbeats (worker_name, heartbeat_at, metadata) VALUES ($1, $2, $3::jsonb)`,
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
      `INSERT INTO app_settings (key, value) VALUES ('engineState', $1::jsonb)`,
      [
        JSON.stringify({
          evaluatedAt: NOW - 2 * MIN,
          regime: 'RANGE',
          volBucket: 'NORMAL',
          session: 'LONDON',
          newsState: 'CLEAR',
          atr5: 4.3,
          warmup: { ready: true, progressPct: 100, missingTimeframes: [] },
          waitReasons: [],
        }),
      ],
    );
  });

  it('answer the snapshot with the last tick, the worker and the engine as the contract says', async () => {
    const reply = await api.send({ url: '/api/v1/market/snapshot' });
    expect(reply.status).toBe(200);
    expect(marketSnapshotSchema.parse(reply.json())).toMatchObject({
      symbol: 'XAUUSD',
      bid: 4017.37,
      ask: 4017.55,
      spread: 0.18,
      ageMs: 3000,
      feedState: 'LIVE',
      regime: 'RANGE',
      engine: { status: 'RUNNING', openCount: 0, warmup: { ready: true } },
    });
  });

  it('give the newest candles oldest first, and honour the limit, the timeframe and `before`', async () => {
    const page = await candles('tf=15m&limit=40');
    expect(page.candles).toHaveLength(40);
    const times = page.candles.map((c) => Date.parse(c.t));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times.at(-1)).toBe(must(shownQuarters.at(-1)).openTime);
    expect(page.overlays).toEqual({});
    expect(page.objects).toEqual([]);

    const older = await candles(`tf=15m&limit=10&before=${must(page.candles[20]).t}`);
    expect(older.candles.map((c) => c.t)).toEqual(page.candles.slice(10, 20).map((c) => c.t));

    const defaults = await candles('limit=3');
    expect(defaults.candles.map((c) => Date.parse(c.t))).toEqual(
      closedBy(five, 5 * MIN)
        .slice(-3)
        .map((c) => c.openTime),
    );
    expect((await candles('tf=1h&limit=2')).candles).toHaveLength(2);
    expect((await candles('tf=4h&limit=2')).candles).toEqual([]);
  });

  it('cut the averages to the candles shown, with values from the first one (the warm-up is read and dropped)', async () => {
    const names = [
      'ema20',
      'ema50',
      'supertrend',
    ] as const satisfies readonly (typeof OVERLAYS)[number][];
    const page = await candles(`tf=15m&limit=30&overlays=${names.join(',')}`);
    expect(Object.keys(page.overlays).sort()).toEqual([...names].sort());

    const reader = new PostgresMarketReader(api.pool);
    const stored = await reader.candles('15m', 30 + overlayWarmup([...names]), null);
    const expected = computeOverlays(stored, [...names]);
    for (const name of names) {
      const values = must(page.overlays[name]);
      expect(values).toHaveLength(30);
      expect(values).toEqual(must(expected[name]).slice(-30));
      expect(values.every((value) => value !== null)).toBe(true);
    }

    // with too little history the early values are null, never made up
    const short = await candles('tf=15m&limit=1000&overlays=ema200');
    const ema200 = must(short.overlays.ema200);
    expect(ema200).toHaveLength(short.candles.length);
    expect(ema200[0]).toBeNull();
    expect(ema200.at(-1)).not.toBeNull();
  });

  it('draw the levels of the engine on every chart, and the objects only when asked for', async () => {
    const layers = new PostgresChartLayers(api.pool);
    const plain = await candles('tf=5m&limit=5');
    expect(plain.levels).toEqual(await layers.levels(NOW));
    expect(plain.levels.map((l) => l.key)).toEqual(expect.arrayContaining(['PDH', 'PDL']));
    expect(plain.objects).toEqual([]);
    expect((await candles('tf=1h&limit=5')).levels).toEqual(plain.levels);

    const all = await candles('tf=15m&limit=5&objects=trendlines,zones,patterns,fib');
    expect(all.objects).toEqual(
      await layers.objects(['trendlines', 'zones', 'patterns', 'fib'], '15m', NOW),
    );
    expect(all.objects.length).toBeGreaterThan(0);

    const zones = await candles('tf=15m&limit=5&objects=zones');
    expect(zones.objects.length).toBeGreaterThan(0);
    expect(zones.objects.every((object) => object.type === 'zone')).toBe(true);
    expect(zones.objects).toEqual(await layers.objects(['zones'], '15m', NOW));
  });

  it('refuse what the contract does not allow, with a 400 that names nothing but the fields', async () => {
    for (const query of [
      'tf=2m',
      'limit=0',
      'limit=2001',
      'limit=abc',
      'overlays=ema9',
      'objects=cloud',
      'before=yesterday',
      'unknown=1',
    ]) {
      const reply = await get(query);
      expect(reply.status, query).toBe(400);
      expect(reply.headers['content-type'], query).toContain('application/problem+json');
    }
  });

  it('need a session', async () => {
    expect((await api.anonymous('/api/v1/market/snapshot')).status).toBe(401);
    expect((await api.anonymous('/api/v1/market/candles?tf=15m')).status).toBe(401);
  });
});

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('a value was expected');
  return value;
}
