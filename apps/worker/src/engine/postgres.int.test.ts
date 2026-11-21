import { defaultStrategyConfig } from '@vmgs/config';
import { bucketKeys, mergeByClose, type BucketDims } from '@vmgs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BASE,
  FEED_OK,
  FIVE_MS,
  pullbackSpec,
  seriesOf,
} from '../../../../packages/core/src/engine/test-data';
import { query } from '../../../../packages/db/test/database';
import { createPgWorld, type PgWorld } from '../lifecycle/pgHarness';
import { buyDraft } from '../lifecycle/test-data';
import { SignalCreator } from '../lifecycle/signals';
import { calendarContextOf } from './context';
import { DecisionLoop } from './loop';
import { ENGINE_STATE_KEY, PostgresEngineStore } from './postgresStore';
import { PostgresCalendarStore } from '../calendar/postgresStore';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

const SYMBOL = 'XAUUSD';
const TRIGGER = 53;
const CLOSE = (BASE.five[TRIGGER]?.openTime ?? 0) + FIVE_MS;
const PRICE = BASE.five[TRIGGER]?.c ?? 0;

let world: PgWorld;
let store: PostgresEngineStore;

beforeAll(async () => {
  world = await createPgWorld();
  store = new PostgresEngineStore(world.pool);
});

afterAll(async () => {
  await world.close();
});

const run = (sql: string, params: unknown[] = []) => query(world.database.url, sql, params);
const count = async (sql: string, params: unknown[] = []): Promise<number> =>
  Number((await query<{ n: string }>(world.database.url, sql, params))[0]?.n);

async function insertCandle(
  tf: string,
  openTime: number,
  prices: [number, number, number, number],
  options: { symbol?: string; complete?: boolean; spread?: number | null } = {},
): Promise<void> {
  const [o, h, l, c] = prices;
  await run(
    `INSERT INTO candles (symbol, tf, open_time, o, h, l, c, spread_avg, tick_count, complete)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 10, $9)`,
    [
      options.symbol ?? SYMBOL,
      tf,
      new Date(openTime),
      o,
      h,
      l,
      c,
      options.spread === undefined ? 0.2 : options.spread,
      options.complete ?? true,
    ],
  );
}

async function insertTick(ts: number, bid: number, ask: number, symbol = SYMBOL): Promise<void> {
  const day = new Date(ts).toISOString().slice(0, 10);
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  await run(
    `CREATE TABLE IF NOT EXISTS ticks_${day.replaceAll('-', '')} PARTITION OF ticks FOR VALUES FROM ('${day}') TO ('${next}')`,
  );
  await run('INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES ($1, $2, $3, $4, $5)', [
    new Date(ts),
    new Date(ts + 1_000),
    symbol,
    bid,
    ask,
  ]);
}

describe('the candles, on PostgreSQL, with the rights of the worker role', () => {
  const T = Date.UTC(2031, 0, 6, 8, 0, 0);

  beforeAll(async () => {
    for (let i = 0; i < 6; i += 1) {
      await insertCandle('5m', T + i * FIVE_MS, [4000 + i, 4001 + i, 3999 + i, 4000.5 + i], {
        spread: i === 2 ? null : 0.1 + i / 100,
      });
    }
    await insertCandle('5m', T + 6 * FIVE_MS, [1, 2, 0, 1], { complete: false });
    await insertCandle('5m', T + 7 * FIVE_MS, [1, 2, 0, 1], { symbol: 'EURUSD' });
    await insertCandle('15m', T, [4000, 4005, 3995, 4002]);
    await insertCandle('15m', T + 900_000, [4002, 4008, 4000, 4006]);
    await insertCandle('1h', T, [4000, 4010, 3990, 4005]);
    await insertCandle('1m', T, [4000, 4001, 3999, 4000]);
    await insertCandle('4h', T, [4000, 4001, 3999, 4000]);
  });

  it('gives the newest candles of each timeframe, oldest first, with their average spread, and no incomplete or foreign one', async () => {
    const found = await store.history({ '5m': 4, '15m': 10, '1h': 10 });
    expect(found.map((item) => `${item.tf}:${String(item.candle.openTime - T)}`)).toEqual([
      `5m:${String(2 * FIVE_MS)}`,
      `5m:${String(3 * FIVE_MS)}`,
      `5m:${String(4 * FIVE_MS)}`,
      `5m:${String(5 * FIVE_MS)}`,
      '15m:0',
      '15m:900000',
      '1h:0',
    ]);
    expect(found[0]?.candle).toEqual({
      openTime: T + 2 * FIVE_MS,
      o: 4002,
      h: 4003,
      l: 4001,
      c: 4002.5,
      spread: null,
    });
    expect(found[1]?.candle.spread).toBeCloseTo(0.13, 9);
  });

  it('gives what is after the cursor of each timeframe, in the order of the open times, in one read', async () => {
    const found = await store.after({ '5m': T + 3 * FIVE_MS, '15m': T, '1h': null }, 100);
    expect(found.map((item) => `${item.tf}:${String(item.candle.openTime - T)}`)).toEqual(
      ['1h:0', `5m:${String(4 * FIVE_MS)}`, `5m:${String(5 * FIVE_MS)}`, '15m:900000'].sort(
        (a, b) => {
          const at = (key: string) => Number(key.split(':')[1]);
          return at(a) - at(b) || a.localeCompare(b);
        },
      ),
    );
  });

  it('gives all of it for a cursor that is empty, and never an incomplete candle, a 1m or a 4h one', async () => {
    const found = await store.after({ '5m': null, '15m': null, '1h': null }, 100);
    expect(found).toHaveLength(6 + 2 + 1);
    expect(found.every((item) => ['5m', '15m', '1h'].includes(item.tf))).toBe(true);
  });

  it('gives at most the limit, oldest first', async () => {
    const found = await store.after({ '5m': null, '15m': null, '1h': null }, 3);
    expect(found.map((item) => item.candle.openTime)).toEqual([T, T, T]);
    expect(found).toHaveLength(3);
  });

  it('gives nothing when the cursor is at the newest candle', async () => {
    expect(await store.after({ '5m': T + 5 * FIVE_MS, '15m': T + 900_000, '1h': T }, 100)).toEqual(
      [],
    );
  });
});

describe('the first quote after a close', () => {
  const T = Date.UTC(2031, 1, 3, 9, 0, 0);

  beforeAll(async () => {
    await insertTick(T - 1_000, 4000, 4000.1);
    await insertTick(T + 2_000, 4001, 4001.1);
    await insertTick(T + 1_000, 4000.5, 4000.6);
    await insertTick(T + 500, 1, 2, 'EURUSD');
  });

  it('is the earliest tick of the traded symbol at or after the time', async () => {
    expect(await store.firstQuoteAtOrAfter(T)).toEqual({
      t: T + 1_000,
      rxAt: T + 2_000,
      bid: 4000.5,
      ask: 4000.6,
    });
    expect((await store.firstQuoteAtOrAfter(T + 1_000))?.t).toBe(T + 1_000);
    expect((await store.firstQuoteAtOrAfter(T + 1_001))?.t).toBe(T + 2_000);
  });

  it('is none after the last tick', async () => {
    expect(await store.firstQuoteAtOrAfter(T + 3_000)).toBeNull();
  });
});

describe('the controls of the owner', () => {
  const NOW = Date.UTC(2031, 2, 1, 12, 0, 0);
  const put = (key: string, value: unknown) =>
    run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );

  it('is running with no switch before the owner sets anything', async () => {
    await run(
      "DELETE FROM app_settings WHERE key IN ('engine', 'advisoryGates', 'strategyEnabled')",
    );
    expect(await store.controls(NOW)).toEqual({ paused: false, modes: {}, disabled: [] });
  });

  it('lists the strategies the owner has switched off, in the order of the strategies, and keeps the others on', async () => {
    await put('strategyEnabled', {
      squeeze_retest: false,
      trend_pullback: true,
      sweep_reversal: false,
    });
    expect((await store.controls(NOW)).disabled).toEqual(['sweep_reversal', 'squeeze_retest']);
    await put('strategyEnabled', {});
    expect((await store.controls(NOW)).disabled).toEqual([]);
  });

  it('refuses a strategy switch it does not understand rather than guess', async () => {
    await put('strategyEnabled', { trend_pullback: 'no' });
    await expect(store.controls(NOW)).rejects.toThrow();
    await put('strategyEnabled', { not_a_strategy: false });
    await expect(store.controls(NOW)).rejects.toThrow();
    await run("DELETE FROM app_settings WHERE key = 'strategyEnabled'");
  });

  it('is paused from a pause with no end, and from one that has not run out', async () => {
    await put('engine', {
      status: 'PAUSED',
      pausedSince: new Date(NOW - 60_000).toISOString(),
      pausedUntil: null,
    });
    expect((await store.controls(NOW)).paused).toBe(true);
    await put('engine', {
      status: 'PAUSED',
      pausedSince: new Date(NOW - 60_000).toISOString(),
      pausedUntil: new Date(NOW + 60_000).toISOString(),
    });
    expect((await store.controls(NOW)).paused).toBe(true);
  });

  it('is running again when a timed pause has run out, or after /resume', async () => {
    await put('engine', {
      status: 'PAUSED',
      pausedSince: new Date(NOW - 120_000).toISOString(),
      pausedUntil: new Date(NOW - 1).toISOString(),
    });
    expect((await store.controls(NOW)).paused).toBe(false);
    await put('engine', { status: 'RUNNING' });
    expect((await store.controls(NOW)).paused).toBe(false);
  });

  it('gives the advisory switches', async () => {
    await put('advisoryGates', {
      newsWindow: 'block',
      rollover: 'warn',
      offHours: 'warn',
      nearLevel: 'block',
    });
    expect((await store.controls(NOW)).modes).toEqual({
      newsWindow: 'block',
      rollover: 'warn',
      offHours: 'warn',
      nearLevel: 'block',
    });
  });

  it('refuses a stored switch it does not understand rather than guess (a blocking switch must not be lost)', async () => {
    await put('advisoryGates', { newsWindow: 'maybe' });
    await expect(store.controls(NOW)).rejects.toThrow();
    await run("DELETE FROM app_settings WHERE key IN ('engine', 'advisoryGates')");
  });
});

describe('the open signals and the evidence', () => {
  it('lists the open live signals with their label and what they still risk, and no closed or replay one', async () => {
    const strategy = await world.store.ensureStrategyVersion(
      defaultStrategyConfig('trend_pullback'),
    );
    const make = async (setupKey: string, side: 'BUY' | 'SELL', mode: 'LIVE' | 'SIMULATED') => {
      const draft = side === 'BUY' ? buyDraft({ setupKey, mode }) : buyDraft({ setupKey, mode });
      const created = await world.store.createSignal(draft, strategy, () => [], Date.now());
      if (created.status !== 'CREATED') throw new Error('not created');
      return created.created;
    };
    const first = await make('open-1', 'BUY', 'LIVE');
    const second = await make('open-2', 'BUY', 'LIVE');
    await make('open-sim', 'BUY', 'SIMULATED');
    await run(
      "UPDATE signal_state SET status = 'TP1_HIT', tp1_hit_at = now() WHERE signal_id = $1",
      [second.id],
    );
    const found = await store.openSignals();
    const ours = found.filter((item) => [first.id, second.id].includes(item.id));
    expect(ours).toEqual([
      {
        id: first.id,
        side: 'BUY',
        riskR: 1,
        label: `#S-${String(first.seq).padStart(4, '0')}`,
      },
      {
        id: second.id,
        side: 'BUY',
        riskR: 0,
        label: `#S-${String(second.seq).padStart(4, '0')}`,
      },
    ]);
    expect(found.some((item) => item.label.endsWith(String(first.seq + 2).padStart(4, '0')))).toBe(
      false,
    );
  });

  it('adds up the net R of the live signals closed in the trading day, and nothing else', async () => {
    const strategy = await world.store.ensureStrategyVersion(
      defaultStrategyConfig('trend_pullback'),
    );
    const outcome = async (
      setupKey: string,
      mode: 'LIVE' | 'SIMULATED',
      closedAt: string,
      result: 'WIN' | 'LOSS' | 'DATA_INVALID',
      net: number | null,
    ) => {
      const created = await world.store.createSignal(
        buyDraft({ setupKey, mode }),
        strategy,
        () => [],
        Date.now(),
      );
      if (created.status !== 'CREATED') throw new Error('not created');
      await run(
        `INSERT INTO signal_outcomes (signal_id, result, counts_in_stats, closed_at, exit_reason, realized_r_gross, cost_r, realized_r_net, duration_s)
         VALUES ($1, $2, $3, $4, 'TEST', $5, 0, $5, 600)`,
        [created.created.id, result, net !== null, closedAt, net],
      );
    };
    // Tuesday 7 January 2031, 12:00 UTC: the trading day began at 17:00 New York time on Monday, 22:00 UTC
    const now = Date.UTC(2031, 0, 7, 12, 0, 0);
    await outcome('day-before', 'LIVE', '2031-01-06T20:00:00Z', 'LOSS', -1);
    await outcome('day-loss', 'LIVE', '2031-01-07T08:00:00Z', 'LOSS', -1.04);
    await outcome('day-win', 'LIVE', '2031-01-07T10:00:00Z', 'WIN', 0.5);
    await outcome('day-sim', 'SIMULATED', '2031-01-07T09:00:00Z', 'LOSS', -1);
    await outcome('day-invalid', 'LIVE', '2031-01-07T09:30:00Z', 'DATA_INVALID', null);
    await outcome('day-later', 'LIVE', '2031-01-07T13:00:00Z', 'LOSS', -1);
    expect(await store.dayResultR(now)).toBeCloseTo(-0.54, 9);
    // before any signal of that day closed, the day is at nothing
    expect(await store.dayResultR(Date.UTC(2031, 0, 6, 22, 30, 0))).toBe(0);
  });

  const dims: BucketDims = {
    strategyKey: 'trend_pullback',
    strategyVersion: '9.9.9',
    side: 'BUY',
    session: 'LONDON',
    regime: 'TREND_UP',
    volBucket: 'NORMAL',
  };

  async function bucket(
    scope: 'FORWARD' | 'BACKTEST_OOS',
    level: number,
    n: number,
    key = bucketKeys(dims)[level] ?? '',
  ) {
    await run(
      `INSERT INTO stats_bucket (scope, level, bucket_key, n, wins, winners, partials, losses, time_exits, tp1_hits, tp2_hits, sum_r, sum_win_r, sum_loss_r)
       VALUES ($1, $2, $3, $4, $5, $5, 0, $6, 0, $5, $5, $7, $8, $9)`,
      [
        scope,
        level,
        key,
        n,
        Math.round(n * 0.6),
        n - Math.round(n * 0.6),
        0.5 * n,
        1.5 * Math.round(n * 0.6),
        -(n - Math.round(n * 0.6)),
      ],
    );
  }

  it('says insufficient, with no percentage, when nothing is stored', async () => {
    const evidence = await store.evidence(dims);
    expect(evidence).toMatchObject({
      scope: 'FORWARD',
      level: 4,
      n: 0,
      sampleLabel: 'INSUFFICIENT',
      winRate: null,
    });
  });

  it('takes the first level of the forward test with 30 results, and shows its numbers', async () => {
    await bucket('FORWARD', 0, 12);
    await bucket('FORWARD', 2, 40);
    await bucket('FORWARD', 3, 90);
    await bucket('FORWARD', 1, 31, 'another|key');
    const evidence = await store.evidence(dims);
    expect(evidence).toMatchObject({
      scope: 'FORWARD',
      level: 2,
      n: 40,
      wins: 24,
      sampleLabel: 'LOW_SAMPLE',
    });
    expect(evidence.winRate).toBeCloseTo(0.6, 9);
    expect(evidence.expectancyR).toBeCloseTo(0.5, 9);
  });

  it('ignores a row whose key belongs to another level of the same setup', async () => {
    const lost: BucketDims = { ...dims, strategyVersion: '9.9.7' };
    const keys = bucketKeys(lost);
    await bucket('FORWARD', 1, 50, keys[2] ?? '');
    await bucket('FORWARD', 2, 35, keys[2] ?? '');
    const evidence = await store.evidence(lost);
    expect(evidence).toMatchObject({ scope: 'FORWARD', level: 2, n: 35 });
  });

  it('turns to the backtest only when no forward level has 30 results', async () => {
    const other: BucketDims = { ...dims, strategyVersion: '9.9.8' };
    await bucket('FORWARD', 4, 20, bucketKeys(other)[4] ?? '');
    await bucket('BACKTEST_OOS', 3, 120, bucketKeys(other)[3] ?? '');
    const evidence = await store.evidence(other);
    expect(evidence).toMatchObject({
      scope: 'BACKTEST_OOS',
      level: 3,
      n: 120,
      sampleLabel: 'NORMAL',
    });
  });
});

describe('what the loop writes', () => {
  it('writes a rejection with its codes, its score and its detail', async () => {
    await store.recordRejection(Date.UTC(2031, 3, 1, 10, 0, 0), {
      strategyKey: 'sweep_reversal',
      side: 'SELL',
      setupKey: 'sweep_reversal:5m:x',
      codes: ['SPREAD_OK', 'NEWS_WINDOW'],
      qualityScore: 71.25,
      detail: { regime: 'RANGE', gates: [{ code: 'SPREAD_OK', passed: false }] },
    });
    const [row] = await query<{
      at: Date;
      strategy_key: string;
      side: string;
      failed_gates: string[];
      quality_score: string | null;
      detail: { setupKey: string; regime: string };
    }>(world.database.url, "SELECT * FROM rejections WHERE strategy_key = 'sweep_reversal'");
    expect(row).toMatchObject({
      strategy_key: 'sweep_reversal',
      side: 'SELL',
      failed_gates: ['SPREAD_OK', 'NEWS_WINDOW'],
      quality_score: '71.25',
      detail: { setupKey: 'sweep_reversal:5m:x', regime: 'RANGE' },
    });
    expect(row?.at.getTime()).toBe(Date.UTC(2031, 3, 1, 10, 0, 0));
  });

  it('writes a rejection that has no score', async () => {
    await store.recordRejection(1_000, {
      strategyKey: 'squeeze_retest',
      side: 'BUY',
      setupKey: 'k',
      codes: ['STOP_OK'],
      qualityScore: null,
      detail: {},
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM rejections WHERE strategy_key = 'squeeze_retest' AND quality_score IS NULL",
      ),
    ).toBe(1);
  });

  it('keeps one engine state, the latest', async () => {
    const state = {
      evaluatedAt: 1,
      regime: 'TREND_UP' as const,
      volBucket: 'NORMAL' as const,
      session: 'LONDON' as const,
      newsState: 'CLEAR' as const,
      atr5: 2.1,
      warmup: { ready: true, progressPct: 100, missingTimeframes: [] },
      waitReasons: [],
    };
    await store.saveState(state, 10_000);
    await store.saveState({ ...state, evaluatedAt: 2, regime: 'RANGE' }, 20_000);
    const rows = await query<{
      value: { evaluatedAt: number; regime: string };
      updated_at: Date;
    }>(world.database.url, 'SELECT value, updated_at FROM app_settings WHERE key = $1', [
      ENGINE_STATE_KEY,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toMatchObject({ evaluatedAt: 2, regime: 'RANGE' });
    expect(rows[0]?.updated_at.getTime()).toBe(20_000);
  });
});

describe('the whole way, from candles and a quote in the tables to a signal', () => {
  it('replays the candles, decides the one that closes, and writes the signal, its rollup and the engine state', async () => {
    await run("DELETE FROM candles WHERE symbol = 'XAUUSD'");
    const steps = mergeByClose(seriesOf(BASE));
    for (const step of steps) {
      if (step.closeTime > CLOSE) continue;
      const c = step.candle;
      await insertCandle(step.tf, c.openTime, [c.o, c.h, c.l, c.c], { spread: c.spread });
    }
    // the candle that closes now is not in the tables yet: it comes after the warm-up
    await run(
      "DELETE FROM candles WHERE symbol = 'XAUUSD' AND ((tf = '5m' AND open_time = $1) OR (tf = '15m' AND open_time = $2) OR (tf = '1h' AND open_time = $3))",
      [
        new Date(BASE.five[TRIGGER]?.openTime ?? 0),
        new Date(BASE.quarter.at(-1)?.openTime ?? 0),
        new Date(BASE.hourly.at(-1)?.openTime ?? 0),
      ],
    );
    const creator = new SignalCreator({ store: world.store, now: () => CLOSE + 2_000 });
    await creator.registerStrategies([defaultStrategyConfig('trend_pullback')]);
    const calendar = new PostgresCalendarStore(world.pool, SYMBOL);
    const loop = new DecisionLoop({
      specs: [pullbackSpec()],
      store,
      creator,
      calendar: calendarContextOf(calendar),
      news: {
        read: () =>
          Promise.resolve({ feed: 'AVAILABLE' as const, headlines: [], lastHighHeadlineAt: null }),
      },
      feed: () => ({ facts: FEED_OK, clockSkewMs: 900 }),
      now: () => CLOSE + 2_000,
      pollMs: 10,
    });
    await loop.warmUp();
    expect(loop.counts['5m']).toBe(TRIGGER);
    const before = await count("SELECT count(*) AS n FROM signals WHERE mode = 'LIVE'");

    // the recorder stores the candles that closed and the tick that closed them, in one batch
    for (const step of steps) {
      if (step.closeTime !== CLOSE) continue;
      const c = step.candle;
      await insertCandle(step.tf, c.openTime, [c.o, c.h, c.l, c.c], { spread: c.spread });
    }
    await insertTick(CLOSE, PRICE - 0.06, PRICE + 0.06);

    expect(await loop.runOnce()).toBe(1);
    expect(await loop.runOnce()).toBe(0);
    expect(await count("SELECT count(*) AS n FROM signals WHERE mode = 'LIVE'")).toBe(before + 1);
    const [signal] = await query<{
      side: string;
      setup_key: string;
      session: string;
      regime: string;
      quality_score: string;
      feature_snapshot: { spread: number };
    }>(
      world.database.url,
      "SELECT side, setup_key, session, regime, quality_score, feature_snapshot FROM signals WHERE setup_key LIKE 'trend_pullback:5m:leg-%' ORDER BY seq DESC LIMIT 1",
    );
    expect(signal).toMatchObject({ side: 'BUY', session: 'OVERLAP', regime: 'UNCERTAIN' });
    expect(signal?.feature_snapshot.spread).toBe(0.12);
    expect(Number(signal?.quality_score)).toBeGreaterThanOrEqual(65);

    // the state of the engine is stored for /status
    const [state] = await query<{ value: { evaluatedAt: number; session: string } }>(
      world.database.url,
      'SELECT value FROM app_settings WHERE key = $1',
      [ENGINE_STATE_KEY],
    );
    expect(state?.value).toMatchObject({ evaluatedAt: CLOSE, session: 'OVERLAP' });
    // and a restarted worker does not decide the candle again
    const again = new DecisionLoop({
      specs: [pullbackSpec()],
      store,
      creator,
      calendar: calendarContextOf(calendar),
      news: {
        read: () =>
          Promise.resolve({ feed: 'AVAILABLE' as const, headlines: [], lastHighHeadlineAt: null }),
      },
      feed: () => ({ facts: FEED_OK, clockSkewMs: 900 }),
      now: () => CLOSE + 4_000,
    });
    expect(await again.runOnce()).toBe(0);
    expect(await count("SELECT count(*) AS n FROM signals WHERE mode = 'LIVE'")).toBe(before + 1);
  });
});
