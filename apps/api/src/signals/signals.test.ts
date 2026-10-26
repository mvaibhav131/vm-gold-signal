import { describe, expect, it } from 'vitest';

import {
  featureSnapshotResponseSchema,
  openSignalsResponseSchema,
  problemSchema,
  signalDetailSchema,
  signalHistoryPageSchema,
} from '@vmgs/contracts';
import { summarizeResults } from '@vmgs/core';

import { makeHarness } from '../testing/harness';
import { must } from '../testing/must';
import { historyRecord, openRecord, signalRecord } from '../testing/signalFixtures';
import {
  decodeCursor,
  encodeCursor,
  openRiskOf,
  openSignalOf,
  pageOf,
  signalOf,
  sortValueOf,
  summaryOf,
} from './mappers';
import {
  historyWhere,
  type DetailRecord,
  type HistoryPageRequest,
  type HistoryRecord,
  type OpenRecord,
  type SignalsReader,
} from './reader';
import { registerSignalsRoutes } from './routes';

const T0 = Date.UTC(2026, 9, 23, 6, 10, 0);
const MIN = 60_000;
const ID = '0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e10';

describe('the cursor', () => {
  it('goes there and back, for every sort, with a value and without', () => {
    for (const sort of ['generatedAt', 'qualityScore', 'realizedRNet', 'durationS'] as const) {
      for (const order of ['asc', 'desc'] as const) {
        for (const value of [null, 0, -1.03, 1_792_000_000_000]) {
          const cursor = encodeCursor({ sort, order, value, seq: 7 });
          expect(decodeCursor(cursor, sort, order)).toEqual({ value, seq: 7 });
        }
      }
    }
  });

  it('is refused for another sort or order, and for anything that is not a cursor of ours', () => {
    const cursor = encodeCursor({ sort: 'qualityScore', order: 'desc', value: 78, seq: 7 });
    expect(() => decodeCursor(cursor, 'generatedAt', 'desc')).toThrow(
      expect.objectContaining({ status: 400, code: 'invalid_cursor' }),
    );
    expect(() => decodeCursor(cursor, 'qualityScore', 'asc')).toThrow(
      expect.objectContaining({ code: 'invalid_cursor' }),
    );
    const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const bad of [
      '',
      'x',
      '!!!',
      base64({}),
      base64([]),
      base64(['qualityScore', 'desc', 78]),
      base64(['qualityScore', 'desc', 78, 7, 1]),
      base64(['qualityScore', 'desc', '78', 7]),
      base64(['qualityScore', 'desc', 78, '7']),
      base64(['qualityScore', 'desc', 78, 0]),
      base64(['qualityScore', 'desc', 78, -3]),
      base64(['qualityScore', 'desc', 78, 1.5]),
      base64(['qualityScore', 'desc', null, 7, 'x']),
    ]) {
      expect(() => decodeCursor(bad, 'qualityScore', 'desc'), bad).toThrow(
        expect.objectContaining({ code: 'invalid_cursor' }),
      );
    }
  });
});

describe('pageOf', () => {
  const summary = summaryOf({ generated: 0, closed: [] });
  const rows = [3, 2, 1].map((seq) =>
    historyRecord({
      seq,
      signalId: `0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e1${String(seq)}`,
      qualityScore: 70 + seq,
    }),
  );

  it('shows `limit` rows and a cursor that continues after the last shown one when the reader found one more', () => {
    const page = pageOf(rows, { limit: 2, sort: 'qualityScore', order: 'desc' }, summary);
    expect(page.items.map((item) => item.seq)).toEqual([3, 2]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor ?? '', 'qualityScore', 'desc')).toEqual({
      value: 72,
      seq: 2,
    });
  });

  it('has no cursor on the last page, nor on an empty one', () => {
    expect(
      pageOf(rows, { limit: 3, sort: 'generatedAt', order: 'desc' }, summary).nextCursor,
    ).toBeNull();
    expect(pageOf([], { limit: 3, sort: 'generatedAt', order: 'desc' }, summary)).toMatchObject({
      items: [],
      nextCursor: null,
    });
  });

  it('carries a null value for a row that has none, so that the list goes on among those', () => {
    const open = [
      historyRecord({ seq: 9, realizedRNet: null }),
      historyRecord({ seq: 8, realizedRNet: null }),
    ];
    const page = pageOf(open, { limit: 1, sort: 'realizedRNet', order: 'asc' }, summary);
    expect(decodeCursor(page.nextCursor ?? '', 'realizedRNet', 'asc')).toEqual({
      value: null,
      seq: 9,
    });
    expect(sortValueOf(must(open[0]), 'durationS')).toBe(2400);
  });
});

describe('summaryOf', () => {
  it('is the overview of the closed signals, and counts every signal of the list as generated', () => {
    const closed = [
      {
        result: 'WIN',
        countsInStats: true,
        realizedRNet: 1.5,
        durationS: 600,
        tp1Hit: true,
        tp2Hit: true,
        closedAt: T0 + 10 * MIN,
      },
      {
        result: 'LOSS',
        countsInStats: true,
        realizedRNet: -1,
        durationS: 300,
        tp1Hit: false,
        tp2Hit: false,
        closedAt: T0 + 20 * MIN,
      },
      {
        result: 'CANCELLED',
        countsInStats: false,
        realizedRNet: null,
        durationS: 0,
        tp1Hit: false,
        tp2Hit: false,
        closedAt: T0 + 30 * MIN,
      },
    ] as const;
    const summary = summaryOf({ generated: 5, closed: [...closed] });
    const core = summarizeResults([...closed]);
    expect(summary).toMatchObject({
      generated: 5,
      resolvedValid: 2,
      wins: 1,
      losses: 1,
      cancelled: 1,
      netR: 0.5,
      expectancyR: 0.25,
      maxDrawdownR: core.maxDrawdownR,
      avgDurationS: 450,
      winRate: null,
      currentStreak: { type: 'LOSS', length: 1 },
    });
    expect(summary).not.toHaveProperty('n');
    expect(summary).not.toHaveProperty('winners');
    expect(summary).not.toHaveProperty('sampleLabel');
  });

  it('is zeros and nulls for an empty list', () => {
    expect(summaryOf({ generated: 0, closed: [] })).toEqual({
      generated: 0,
      resolvedValid: 0,
      wins: 0,
      partials: 0,
      losses: 0,
      timeExits: 0,
      cancelled: 0,
      dataInvalid: 0,
      winRate: null,
      ci95: null,
      netR: 0,
      expectancyR: null,
      profitFactor: null,
      maxDrawdownR: 0,
      avgDurationS: null,
      tp1Rate: null,
      tp2Rate: null,
      currentStreak: null,
    });
  });
});

describe('openSignalOf', () => {
  const quote = { bid: 4020.1, ask: 4020.3, at: T0 + 6 * MIN };

  it('values a BUY at the bid and a SELL at the ask, in the R the engine counts', () => {
    const buy = openSignalOf(openRecord('ACTIVE'), quote, T0 + 6 * MIN).live;
    expect(buy).toMatchObject({
      currentPrice: 4020.1,
      unrealisedR: 0.42,
      stopLossCurrent: 4010.9,
      status: 'ACTIVE',
    });
    const sell = openSignalOf(
      openRecord('ACTIVE', { side: 'SELL', stopLoss: 4023.84, tp1: 4010.9, tp2: 4004.43 }),
      quote,
      T0 + 6 * MIN,
    ).live;
    expect(sell).toMatchObject({ currentPrice: 4020.3, unrealisedR: -0.45 });
  });

  it('counts the half that was banked at TP1 for a partial profile, and nothing extra for a single target', () => {
    const partial = openSignalOf(openRecord('TP1_HIT'), quote, T0 + 6 * MIN).live;
    expect(partial.unrealisedR).toBe(0.71);
    const single = openSignalOf(
      openRecord('TP1_HIT', { exitProfile: 'EP2_SINGLE', tp2: null }),
      quote,
      T0 + 6 * MIN,
    ).live;
    expect(single.unrealisedR).toBe(0.42);
  });

  it('rounds the excursions to two decimals and never shows a negative time to the time stop', () => {
    const live = openSignalOf(openRecord('ACTIVE'), quote, T0 + 6 * MIN).live;
    expect(live).toMatchObject({ mfeR: 1.23, maeR: -0.46 });
    expect(live.timeToTimeStopS).toBe(114 * 60);
    expect(openSignalOf(openRecord('ACTIVE'), quote, T0 + 130 * MIN).live.timeToTimeStopS).toBe(0);
    expect(
      openSignalOf(openRecord('ACTIVE'), quote, T0 + 120 * MIN - 1500).live.timeToTimeStopS,
    ).toBe(1);
  });

  it('refuses a state that is not an open one rather than show it as one', () => {
    const closed = {
      ...openRecord('ACTIVE'),
      state: { ...openRecord('ACTIVE').state, status: 'CLOSED' },
    };
    expect(() => openSignalOf(closed, quote, T0)).toThrow();
  });

  it('adds up the risk of the open signals: one R until TP1, nothing after', () => {
    expect(openRiskOf([openRecord('ACTIVE'), openRecord('TP1_HIT'), openRecord('ACTIVE')])).toBe(2);
    expect(openRiskOf([])).toBe(0);
  });

  it('gives the signal with ISO times and without the feature snapshot', () => {
    const shown = signalOf(signalRecord());
    expect(shown).toMatchObject({
      id: ID,
      symbol: 'XAUUSD',
      generatedAt: '2026-10-23T06:10:00.000Z',
      createdAt: '2026-10-23T06:10:00.400Z',
    });
    expect(shown).not.toHaveProperty('featureSnapshot');
    expect(shown).not.toHaveProperty('snapshotPruned');
  });
});

describe('historyWhere', () => {
  it('always leaves out a replay, and numbers its parameters in the order of the clauses', () => {
    expect(historyWhere({})).toEqual({ sql: "mode <> 'BACKTEST'", values: [] });
    const where = historyWhere({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
      result: 'WIN',
      strategy: 'trend_pullback',
      side: 'BUY',
      session: 'LONDON',
      regime: 'RANGE',
      cause: 'NEWS_SHOCK',
    });
    expect(where.sql).toBe(
      "mode <> 'BACKTEST' AND generated_at >= $1 AND generated_at < $2 AND result = $3 AND strategy_key = $4 AND side = $5 AND session = $6 AND regime = $7 AND primary_cause = $8",
    );
    expect(where.values).toEqual([
      new Date('2026-10-01T00:00:00.000Z'),
      new Date('2026-11-01T00:00:00.000Z'),
      'WIN',
      'trend_pullback',
      'BUY',
      'LONDON',
      'RANGE',
      'NEWS_SHOCK',
    ]);
  });

  it('turns a grade into the band of scores of 02 section 8', () => {
    expect(historyWhere({ grade: 'Moderate' })).toEqual({
      sql: "mode <> 'BACKTEST' AND quality_score >= $1 AND quality_score < $2",
      values: [65, 75],
    });
    expect(historyWhere({ grade: 'Strong' }).values).toEqual([75, 90]);
    expect(historyWhere({ grade: 'Very strong' })).toEqual({
      sql: "mode <> 'BACKTEST' AND quality_score >= $1",
      values: [90],
    });
  });
});

class FakeReader implements SignalsReader {
  opens: { items: OpenRecord[]; quote: { bid: number; ask: number; at: number } | null } = {
    items: [],
    quote: null,
  };
  pages: HistoryPageRequest[] = [];
  summaries: object[] = [];
  rows: HistoryRecord[] = [];
  detailRecord: DetailRecord | null = null;
  snapshotRecord: { pruned: boolean; features: unknown } | null = null;

  open() {
    return Promise.resolve(this.opens);
  }
  history(request: HistoryPageRequest) {
    this.pages.push(request);
    return Promise.resolve(this.rows);
  }
  summary(filter: object) {
    this.summaries.push(filter);
    return Promise.resolve({ generated: this.rows.length, closed: [] });
  }
  detail() {
    return Promise.resolve(this.detailRecord);
  }
  snapshot() {
    return Promise.resolve(this.snapshotRecord);
  }
}

async function setup() {
  const reader = new FakeReader();
  const h = await makeHarness({
    routes: (app, clock) => {
      registerSignalsRoutes(app, { reader, now: () => clock.now });
    },
  });
  h.clock.now = T0 + 6 * MIN;
  return { h, reader, cookie: await h.login() };
}

const BASE = '/api/v1/signals';

describe('the signals routes', () => {
  it('answer /open with nothing, and need no price for it', async () => {
    const { h, cookie } = await setup();
    const reply = await h.send({ url: `${BASE}/open`, cookie });
    expect(openSignalsResponseSchema.parse(reply.json())).toEqual({
      items: [],
      openCount: 0,
      openRiskR: 0,
    });
  });

  it('answer /open with the live fields, and 503 when a signal is open and there is no price', async () => {
    const { h, reader, cookie } = await setup();
    reader.opens = { items: [openRecord('ACTIVE'), openRecord('TP1_HIT')], quote: null };
    const none = await h.send({ url: `${BASE}/open`, cookie });
    expect(none.status).toBe(503);
    expect(problemSchema.parse(none.json()).code).toBe('no_quote');
    reader.opens = {
      items: [openRecord('ACTIVE'), openRecord('TP1_HIT')],
      quote: { bid: 4020.1, ask: 4020.3, at: T0 },
    };
    const body = openSignalsResponseSchema.parse(
      (await h.send({ url: `${BASE}/open`, cookie })).json(),
    );
    expect(body).toMatchObject({ openCount: 2, openRiskR: 1 });
    expect(body.items[1]?.live.status).toBe('TP1_HIT');
  });

  it('read the list with the defaults of the contract, and pass the filter to the summary too', async () => {
    const { h, reader, cookie } = await setup();
    reader.rows = [historyRecord()];
    const reply = await h.send({ url: `${BASE}?strategy=trend_pullback&grade=Strong`, cookie });
    const page = signalHistoryPageSchema.parse(reply.json());
    expect(page.items).toHaveLength(1);
    expect(page.summary.generated).toBe(1);
    expect(reader.pages).toEqual([
      expect.objectContaining({ sort: 'generatedAt', order: 'desc', limit: 50, after: null }),
    ]);
    expect(reader.pages[0]?.filter).toMatchObject({ strategy: 'trend_pullback', grade: 'Strong' });
    expect(reader.summaries[0]).toEqual(reader.pages[0]?.filter);
  });

  it('continue from a cursor of their own list, and refuse the cursor of another', async () => {
    const { h, reader, cookie } = await setup();
    reader.rows = [historyRecord({ seq: 5 }), historyRecord({ seq: 4 }), historyRecord({ seq: 3 })];
    const first = signalHistoryPageSchema.parse(
      (await h.send({ url: `${BASE}?limit=2&sort=qualityScore`, cookie })).json(),
    );
    expect(first.nextCursor).not.toBeNull();
    reader.pages.length = 0;
    await h.send({
      url: `${BASE}?limit=2&sort=qualityScore&cursor=${first.nextCursor ?? ''}`,
      cookie,
    });
    expect(reader.pages[0]?.after).toEqual({ value: 78, seq: 4 });
    const other = await h.send({
      url: `${BASE}?limit=2&sort=durationS&cursor=${first.nextCursor ?? ''}`,
      cookie,
    });
    expect(other.status).toBe(400);
    expect(problemSchema.parse(other.json()).code).toBe('invalid_cursor');
  });

  it('refuse what the contract refuses', async () => {
    const { h, reader, cookie } = await setup();
    for (const query of [
      'limit=201',
      'result=DRAW',
      'side=LONG',
      'from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z',
      'sort=seq',
      'order=up',
      'x=1',
    ]) {
      const reply = await h.send({ url: `${BASE}?${query}`, cookie });
      expect(reply.status, query).toBe(400);
    }
    expect(reader.pages).toEqual([]);
  });

  it('answer a detail, and 404 / 400 for an id that is not there / not an id', async () => {
    const { h, reader, cookie } = await setup();
    reader.detailRecord = {
      signal: signalRecord(),
      state: {
        status: 'ACTIVE',
        stopLossCurrent: 4010.9,
        tp1HitAt: null,
        mfeR: 0.4,
        maeR: -0.2,
        updatedAt: T0 + MIN,
      },
      events: [{ id: 1, eventType: 'CREATED', eventAt: T0, price: 4017.37, meta: {} }],
      outcome: null,
      autopsy: null,
    };
    const detail = signalDetailSchema.parse(
      (await h.send({ url: `${BASE}/${ID}`, cookie })).json(),
    );
    expect(detail.events).toHaveLength(1);
    expect(detail.snapshotAvailable).toBe(true);
    reader.detailRecord = null;
    expect((await h.send({ url: `${BASE}/${ID}`, cookie })).status).toBe(404);
    expect((await h.send({ url: `${BASE}/42`, cookie })).status).toBe(400);
  });

  it('answer a snapshot, 404 snapshot_pruned for a pruned one, and 404 for no signal', async () => {
    const { h, reader, cookie } = await setup();
    reader.snapshotRecord = { pruned: false, features: { ema20: 4015.2 } };
    expect(
      featureSnapshotResponseSchema.parse(
        (await h.send({ url: `${BASE}/${ID}/snapshot`, cookie })).json(),
      ),
    ).toEqual({
      signalId: ID,
      features: { ema20: 4015.2 },
    });
    reader.snapshotRecord = { pruned: true, features: { pruned: true } };
    const pruned = await h.send({ url: `${BASE}/${ID}/snapshot`, cookie });
    expect(pruned.status).toBe(404);
    expect(problemSchema.parse(pruned.json()).code).toBe('snapshot_pruned');
    reader.snapshotRecord = null;
    expect(
      problemSchema.parse((await h.send({ url: `${BASE}/${ID}/snapshot`, cookie })).json()).code,
    ).toBe('not_found');
  });

  it('need a session', async () => {
    const { h } = await setup();
    for (const url of [`${BASE}/open`, BASE, `${BASE}/${ID}`, `${BASE}/${ID}/snapshot`]) {
      expect((await h.send({ url })).status, url).toBe(401);
    }
  });
});
