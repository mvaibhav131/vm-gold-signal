import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  featureSnapshotResponseSchema,
  openSignalsResponseSchema,
  problemSchema,
  signalDetailSchema,
  signalHistoryPageSchema,
  type SignalHistoryPage,
} from '@vmgs/contracts';
import type { Review, StrategyKey } from '@vmgs/core';

import { startPgApi, type PgApi } from '../testing/pgApi';
import {
  MINUTE_MS,
  SEED_AT,
  outcomeOf,
  startSeedWorld,
  type SeededSignal,
  type SeedWorld,
} from '../testing/seedWorld';

const HOUR = 60 * MINUTE_MS;
const BASE = '/api/v1/signals';

let api: PgApi;
let world: SeedWorld;
type SignalName = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'S9';
const made = {} as Record<SignalName, SeededSignal>;

beforeAll(async () => {
  api = await startPgApi();
  world = await startSeedWorld(api);
  await api.admin.query(
    `CREATE TABLE IF NOT EXISTS ticks_20261023 PARTITION OF ticks FOR VALUES FROM ('2026-10-23') TO ('2026-10-24')`,
  );

  const at = (hours: number) => SEED_AT + hours * HOUR;
  const review = (primaryCause: Review['primaryCause']): Review => ({
    status: 'PRELIMINARY',
    primaryCause,
    causes: [{ code: primaryCause, evidence: { mfeR: 0.2 } }],
    weakGroupsAtEntry: [{ group: 'trigger', state: 'WEAK' }],
    counterfactual: null,
  });
  const make = async (
    name: SignalName,
    strategy: StrategyKey,
    side: 'BUY' | 'SELL',
    hours: number,
    qualityScore: number,
    draft: Parameters<SeedWorld['createSignal']>[0] extends infer O
      ? O extends { draft?: infer D }
        ? D
        : never
      : never = {},
  ) => {
    made[name] = await world.createSignal({
      strategy,
      side,
      generatedAt: at(hours),
      qualityScore,
      draft,
    });
  };

  await make('S1', 'trend_pullback', 'BUY', 0, 78);
  await make('S2', 'trend_pullback', 'SELL', 1, 68, { session: 'NEW_YORK', regime: 'RANGE' });
  await make('S3', 'sweep_reversal', 'BUY', 2, 92);
  await make('S4', 'sweep_reversal', 'SELL', 3, 66);
  await make('S5', 'squeeze_retest', 'BUY', 4, 80);
  await make('S6', 'trend_pullback', 'BUY', 5, 75);
  await make('S7', 'trend_pullback', 'BUY', 5.5, 77, { mode: 'BACKTEST' });
  await make('S8', 'trend_pullback', 'BUY', 6, 78);
  await make('S9', 'sweep_reversal', 'SELL', 7, 70);

  await world.close(
    made.S1,
    outcomeOf('WIN', at(0) + 40 * MINUTE_MS, { durationS: 2400 }),
    review('NO_FOLLOW_THROUGH'),
  );
  await world.close(
    made.S2,
    outcomeOf('LOSS', at(1) + 10 * MINUTE_MS, { durationS: 600 }),
    review('STOP_HUNT_REVERSAL'),
  );
  await world.close(made.S3, outcomeOf('PARTIAL_WIN', at(2) + 50 * MINUTE_MS, { durationS: 3000 }));
  await world.close(made.S4, outcomeOf('CANCELLED', at(3) + MINUTE_MS));
  await world.close(made.S8, outcomeOf('TIME_EXIT', at(6) + 20 * MINUTE_MS, { durationS: 1200 }));
  await world.setState(
    made.S6.id,
    {
      status: 'TP1_HIT',
      stopLossCurrent: 4017.37,
      tp1HitAt: at(5) + 5 * MINUTE_MS,
      mfeR: 1.234,
      maeR: -0.1,
    },
    at(5) + 5 * MINUTE_MS,
  );

  await api.admin.query(
    `INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES ($1, $1, 'XAUUSD', 4020.1, 4020.3)`,
    [new Date(at(7) + 30 * MINUTE_MS)],
  );
  api.clock.now = at(7) + 31 * MINUTE_MS;
});

afterAll(async () => {
  await world.finish();
  await api.close();
});

const list = async (query = ''): Promise<SignalHistoryPage> => {
  const reply = await api.send({ url: `${BASE}${query === '' ? '' : `?${query}`}` });
  expect(reply.status, reply.body).toBe(200);
  return signalHistoryPageSchema.parse(reply.json());
};

const names = (page: SignalHistoryPage): string[] =>
  page.items.map((item) => {
    const found = Object.entries(made).find(([, signal]) => signal.id === item.signalId);
    return found?.[0] ?? item.signalId;
  });

describe('GET /signals/open on Postgres', () => {
  it('lists the open signals, newest first, with the price of the closing side and the result in R the engine counts', async () => {
    const reply = await api.send({ url: `${BASE}/open` });
    expect(reply.status).toBe(200);
    const open = openSignalsResponseSchema.parse(reply.json());
    expect(open.items.map((item) => item.signal.seq)).toEqual([
      made.S9.seq,
      made.S6.seq,
      made.S5.seq,
    ]);
    expect(open.openCount).toBe(3);
    // two still risk one R each; the one that hit TP1 has its stop at the entry
    expect(open.openRiskR).toBe(2);

    const [sell, afterTp1, active] = open.items;
    // BUY is valued at the bid, SELL at the ask
    expect(active?.live).toMatchObject({
      status: 'ACTIVE',
      currentPrice: 4020.1,
      unrealisedR: 0.42,
      stopLossCurrent: 4010.9,
    });
    expect(sell?.live).toMatchObject({
      status: 'ACTIVE',
      currentPrice: 4020.3,
      unrealisedR: -0.45,
    });
    // half was banked at TP1 (one R), the other half is at 0.42 R
    expect(afterTp1?.live).toMatchObject({
      status: 'TP1_HIT',
      unrealisedR: 0.71,
      mfeR: 1.23,
      maeR: -0.1,
      stopLossCurrent: 4017.37,
    });
    // the time stop of S9 (two hours after its decision) is 89 minutes away; S5's passed long ago and is shown as 0
    expect(sell?.live.timeToTimeStopS).toBe(89 * 60);
    expect(active?.live.timeToTimeStopS).toBe(0);
    expect(active?.signal).toMatchObject({
      strategyKey: 'squeeze_retest',
      qualityScore: 80,
      side: 'BUY',
    });
    expect(active?.signal).not.toHaveProperty('featureSnapshot');
  });

  it('shows no signal that has closed, was cancelled or is a replay, and says 503 when there is a signal and no price', async () => {
    const open = openSignalsResponseSchema.parse((await api.send({ url: `${BASE}/open` })).json());
    const ids = open.items.map((item) => item.signal.id);
    for (const name of ['S1', 'S2', 'S3', 'S4', 'S7', 'S8'] as const) {
      expect(ids, name).not.toContain(made[name].id);
    }
    await api.admin.query('DELETE FROM ticks');
    const reply = await api.send({ url: `${BASE}/open` });
    expect(reply.status).toBe(503);
    expect(problemSchema.parse(reply.json()).code).toBe('no_quote');
    await api.admin.query(
      `INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES ($1, $1, 'XAUUSD', 4020.1, 4020.3)`,
      [new Date(SEED_AT + 7 * HOUR + 30 * MINUTE_MS)],
    );
  });
});

describe('GET /signals on Postgres', () => {
  it('lists every signal of the owner, newest first, and none of a replay', async () => {
    const page = await list();
    expect(names(page)).toEqual(['S9', 'S8', 'S6', 'S5', 'S4', 'S3', 'S2', 'S1']);
    expect(page.nextCursor).toBeNull();
    const closed = page.items.find((item) => item.signalId === made.S1.id);
    expect(closed).toMatchObject({
      seq: made.S1.seq,
      state: 'CLOSED',
      result: 'WIN',
      countsInStats: true,
      isWin: true,
      realizedRNet: 1.47,
      durationS: 2400,
      primaryCause: 'NO_FOLLOW_THROUGH',
      autopsyStatus: 'PRELIMINARY',
      strategyKey: 'trend_pullback',
      strategyVersion: '0.1.0',
      qualityScore: 78,
      evidenceN: 64,
    });
    const open = page.items.find((item) => item.signalId === made.S5.id);
    expect(open).toMatchObject({
      state: 'ACTIVE',
      result: null,
      closedAt: null,
      realizedRNet: null,
      durationS: null,
    });
  });

  it('puts the counters of the WHOLE filtered list above the page, whatever the page is', async () => {
    const whole = await list();
    expect(whole.summary).toMatchObject({
      generated: 8,
      resolvedValid: 4,
      wins: 1,
      partials: 1,
      losses: 1,
      timeExits: 1,
      cancelled: 1,
      dataInvalid: 0,
      winRate: null,
      ci95: null,
      netR: 0.98,
    });
    // closed in this order: win, loss, win (S3), win (S8: a time exit above zero)
    expect(whole.summary.currentStreak).toEqual({ type: 'WIN', length: 2 });
    const firstPage = await list('limit=2');
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.summary).toEqual(whole.summary);
    const trend = await list('strategy=trend_pullback');
    expect(trend.summary).toMatchObject({
      generated: 4,
      resolvedValid: 3,
      wins: 1,
      losses: 1,
      timeExits: 1,
      cancelled: 0,
    });
  });

  it('filters by strategy, side, result, session, regime, cause and grade', async () => {
    expect(names(await list('strategy=sweep_reversal'))).toEqual(['S9', 'S4', 'S3']);
    expect(names(await list('side=SELL'))).toEqual(['S9', 'S4', 'S2']);
    expect(names(await list('result=WIN'))).toEqual(['S1']);
    expect(names(await list('result=CANCELLED'))).toEqual(['S4']);
    expect(names(await list('session=NEW_YORK'))).toEqual(['S2']);
    expect(names(await list('regime=RANGE'))).toEqual(['S2']);
    expect(names(await list('cause=STOP_HUNT_REVERSAL'))).toEqual(['S2']);
    expect(names(await list('grade=Moderate'))).toEqual(['S9', 'S4', 'S2']);
    expect(names(await list('grade=Strong'))).toEqual(['S8', 'S6', 'S5', 'S1']);
    expect(names(await list(`grade=${encodeURIComponent('Very strong')}`))).toEqual(['S3']);
    expect(names(await list('strategy=sweep_reversal&side=SELL&grade=Moderate'))).toEqual([
      'S9',
      'S4',
    ]);
    expect(names(await list('strategy=squeeze_retest&side=SELL'))).toEqual([]);
  });

  it('takes from as inclusive and to as exclusive', async () => {
    const third = new Date(SEED_AT + 2 * HOUR).toISOString();
    expect(
      names(await list(`from=${third}&to=${new Date(SEED_AT + 4 * HOUR).toISOString()}`)),
    ).toEqual(['S4', 'S3']);
    expect(names(await list(`to=${third}`))).toEqual(['S2', 'S1']);
    expect(names(await list(`from=${third}`))).toEqual(['S9', 'S8', 'S6', 'S5', 'S4', 'S3']);
    expect((await list(`from=${third}&to=${third}`)).items).toEqual([]);
    expect((await list(`from=${third}&to=${third}`)).summary.generated).toBe(0);
  });

  it('sorts by quality, newest number first among equals, and the rows without a value last in both directions', async () => {
    expect(names(await list('sort=qualityScore'))).toEqual([
      'S3',
      'S5',
      'S8',
      'S1',
      'S6',
      'S9',
      'S2',
      'S4',
    ]);
    expect(names(await list('sort=qualityScore&order=asc'))).toEqual([
      'S4',
      'S2',
      'S9',
      'S6',
      'S8',
      'S1',
      'S5',
      'S3',
    ]);
    expect(names(await list('sort=realizedRNet'))).toEqual([
      'S1',
      'S3',
      'S8',
      'S2',
      'S9',
      'S6',
      'S5',
      'S4',
    ]);
    expect(names(await list('sort=realizedRNet&order=asc'))).toEqual([
      'S2',
      'S8',
      'S3',
      'S1',
      'S9',
      'S6',
      'S5',
      'S4',
    ]);
    // a cancelled signal has a duration of 0 s: it has a value, and the open ones have none
    expect(names(await list('sort=durationS'))).toEqual([
      'S3',
      'S1',
      'S8',
      'S2',
      'S4',
      'S9',
      'S6',
      'S5',
    ]);
    expect(names(await list('sort=generatedAt&order=asc'))).toEqual([
      'S1',
      'S2',
      'S3',
      'S4',
      'S5',
      'S6',
      'S8',
      'S9',
    ]);
  });

  it('pages through every sort in both directions without a gap or a repeat', async () => {
    for (const sort of ['generatedAt', 'qualityScore', 'realizedRNet', 'durationS']) {
      for (const order of ['asc', 'desc']) {
        const whole = names(await list(`sort=${sort}&order=${order}&limit=200`));
        const paged: string[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 10; guard += 1) {
          const page: SignalHistoryPage = await list(
            `sort=${sort}&order=${order}&limit=3${cursor === null ? '' : `&cursor=${cursor}`}`,
          );
          paged.push(...names(page));
          cursor = page.nextCursor;
          if (cursor === null) break;
        }
        expect(paged, `${sort} ${order}`).toEqual(whole);
        expect(new Set(paged).size).toBe(8);
      }
    }
  });

  it('is 400 for a cursor of another sort or order, and for one that is no cursor at all', async () => {
    const page = await list('sort=qualityScore&limit=2');
    const cursor = page.nextCursor ?? '';
    expect(cursor).not.toBe('');
    for (const query of [
      `sort=qualityScore&order=asc&cursor=${cursor}`,
      `sort=generatedAt&cursor=${cursor}`,
      `cursor=${cursor}`,
      'cursor=not-a-cursor',
      'cursor=e30',
    ]) {
      const reply = await api.send({ url: `${BASE}?${query}` });
      expect(reply.status, query).toBe(400);
      expect(problemSchema.parse(reply.json()).code).toBe('invalid_cursor');
    }
    expect((await api.send({ url: `${BASE}?limit=0` })).status).toBe(400);
    expect((await api.send({ url: `${BASE}?grade=Excellent` })).status).toBe(400);
  });
});

describe('GET /signals/:id on Postgres', () => {
  it('gives a closed signal with its events, outcome and review, and no state', async () => {
    const id = made.S2.id;
    const reply = await api.send({ url: `${BASE}/${id}` });
    expect(reply.status).toBe(200);
    const detail = signalDetailSchema.parse(reply.json());
    expect(detail.state).toBeNull();
    expect(detail.signal).toMatchObject({
      id,
      side: 'SELL',
      session: 'NEW_YORK',
      regime: 'RANGE',
      strategyKey: 'trend_pullback',
    });
    expect(detail.signal.explanation.levels.stop).toBe(4023.84);
    expect(detail.events.map((event) => event.eventType)).toContain('CREATED');
    expect(detail.outcome).toMatchObject({
      result: 'LOSS',
      realizedRNet: -1.03,
      isWin: false,
      durationS: 600,
    });
    expect(detail.autopsy).toMatchObject({
      primaryCause: 'STOP_HUNT_REVERSAL',
      status: 'PRELIMINARY',
    });
    expect(detail.snapshotAvailable).toBe(true);
  });

  it('gives an open signal with its state and no outcome', async () => {
    const detail = signalDetailSchema.parse(
      (await api.send({ url: `${BASE}/${made.S6.id}` })).json(),
    );
    expect(detail.outcome).toBeNull();
    expect(detail.autopsy).toBeNull();
    expect(detail.state).toMatchObject({
      status: 'TP1_HIT',
      stopLossCurrent: 4017.37,
      mfeR: 1.234,
      maeR: -0.1,
    });
    expect(detail.state?.tp1HitAt).toBe(new Date(SEED_AT + 5 * HOUR + 5 * MINUTE_MS).toISOString());
  });

  it('is 404 for a signal that does not exist and for a replay, and 400 for an id that is no id', async () => {
    const none = await api.send({ url: `${BASE}/0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e11` });
    expect(none.status).toBe(404);
    expect(problemSchema.parse(none.json()).code).toBe('not_found');
    expect((await api.send({ url: `${BASE}/${made.S7.id}` })).status).toBe(404);
    for (const id of ['x', '123', 'S-0042', '0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e1z']) {
      expect((await api.send({ url: `${BASE}/${id}` })).status, id).toBe(400);
    }
  });
});

describe('GET /signals/:id/snapshot on Postgres', () => {
  it('gives the features the signal was decided on', async () => {
    const reply = await api.send({ url: `${BASE}/${made.S1.id}/snapshot` });
    expect(reply.status).toBe(200);
    expect(featureSnapshotResponseSchema.parse(reply.json())).toEqual({
      signalId: made.S1.id,
      features: { ema20: 4015.2, rsi14: 54.1, spread: 0.12 },
    });
  });

  it('is 404 snapshot_pruned once the retention job has replaced it by a marker, and says so in the detail', async () => {
    const pruned = await world.createSignal({
      generatedAt: SEED_AT - 400 * 24 * HOUR,
      draft: {
        featureSnapshot: { pruned: true, prunedAt: '2026-10-01T00:00:00.000Z', spread: 0.12 },
      },
    });
    const reply = await api.send({ url: `${BASE}/${pruned.id}/snapshot` });
    expect(reply.status).toBe(404);
    expect(problemSchema.parse(reply.json()).code).toBe('snapshot_pruned');
    const detail = signalDetailSchema.parse(
      (await api.send({ url: `${BASE}/${pruned.id}` })).json(),
    );
    expect(detail.snapshotAvailable).toBe(false);
  });

  it('is 404 not_found for an id that is no signal, and for a replay', async () => {
    const none = await api.send({ url: `${BASE}/0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e11/snapshot` });
    expect(problemSchema.parse(none.json()).code).toBe('not_found');
    expect((await api.send({ url: `${BASE}/${made.S7.id}/snapshot` })).status).toBe(404);
  });
});
