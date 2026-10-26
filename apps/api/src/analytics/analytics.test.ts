import { describe, expect, it } from 'vitest';

import {
  breakdownResponseSchema,
  calibrationResponseSchema,
  driftResponseSchema,
  equityResponseSchema,
  failuresResponseSchema,
  groupEffectivenessResponseSchema,
  monthlyResponseSchema,
  newsImpactResponseSchema,
  overviewResponseSchema,
  problemSchema,
} from '@vmgs/contracts';
import type { StatsScope } from '@vmgs/core';

import { makeHarness, type Clock } from '../testing/harness';
import { AnswerCache } from './cache';
import type { AnalyticsReader, TopicStatRow, TradeQuery, TradeRow } from './reader';
import { registerAnalyticsRoutes, type AnalyticsDeps } from './routes';
import { START, row, series } from './testRows';

const BASE = '/api/v1/analytics';

/** A reader with fixtures. It does not filter: what the routes ask for is recorded, the SQL has its own tests. */
class FakeReader implements AnalyticsReader {
  readonly tradeCalls: TradeQuery[] = [];
  topicCalls = 0;
  zoneCalls = 0;
  failure: Error | null = null;
  gate: Promise<void> | null = null;
  rows: Record<StatsScope, TradeRow[]> = { FORWARD: [], BACKTEST_OOS: [] };
  stats: TopicStatRow[] = [];
  zone: unknown = null;

  async trades(query: TradeQuery): Promise<TradeRow[]> {
    this.tradeCalls.push(query);
    if (this.gate !== null) await this.gate;
    if (this.failure !== null) throw this.failure;
    return this.rows[query.scope];
  }

  displayTz(): Promise<unknown> {
    this.zoneCalls += 1;
    return Promise.resolve(this.zone);
  }

  topicStats(): Promise<TopicStatRow[]> {
    this.topicCalls += 1;
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(this.stats);
  }
}

async function setup(reader: FakeReader, options: Partial<AnalyticsDeps> = {}) {
  let clock: Clock | null = null;
  const h = await makeHarness({
    routes: (app, c) => {
      clock = c;
      registerAnalyticsRoutes(app, { reader, now: () => c.now, ...options });
    },
  });
  const cookie = await h.login();
  const get = (url: string) => h.send({ url, cookie });
  return { h, cookie, get, clock: clock as unknown as Clock };
}

/** Every endpoint with the schema its answer must match. */
const ENDPOINTS = [
  ['overview', overviewResponseSchema],
  ['monthly', monthlyResponseSchema],
  ['breakdown?by=side', breakdownResponseSchema],
  ['failures', failuresResponseSchema],
  ['groups', groupEffectivenessResponseSchema],
  ['score-calibration', calibrationResponseSchema],
  ['equity', equityResponseSchema],
  ['drift', driftResponseSchema],
  ['news-impact', newsImpactResponseSchema],
] as const;

function populated(): FakeReader {
  const reader = new FakeReader();
  reader.rows.FORWARD = [
    ...series('trend_pullback', 35, 20, 1).map((each, index) => ({
      ...each,
      groups: [{ key: 'trend' as const, state: 'STRONG' as const }],
      primaryCause: index % 3 === 2 ? ('NORMAL_LOSS' as const) : null,
      weakGroups: index % 3 === 2 ? ['trigger' as const] : [],
    })),
    row({ seq: 100, open: true }),
  ];
  reader.rows.BACKTEST_OOS = series('trend_pullback', 40, 24, 500);
  reader.stats = [
    { topic: 'FED_RATES', impact: 'HIGH', n: 142, moved: 61, sumAbsAtr10m: 190.28, baseline: 0.19 },
  ];
  return reader;
}

describe('every analytics route', () => {
  it('answers with a body that matches its contract, on data and on none', async () => {
    for (const reader of [populated(), new FakeReader()]) {
      const { get } = await setup(reader);
      for (const [path, schema] of ENDPOINTS) {
        const reply = await get(`${BASE}/${path}`);
        expect(reply.status, path).toBe(200);
        expect(schema.safeParse(reply.json()).success, path).toBe(true);
        expect(reply.res.headers['cache-control'], path).toBe('no-store');
        expect(reply.res.headers['content-type'], path).toContain('application/json');
      }
    }
  });

  it('needs a session: 401 without one, and the database is not read', async () => {
    const reader = populated();
    const { h } = await setup(reader);
    for (const [path] of ENDPOINTS) {
      const reply = await h.send({ url: `${BASE}/${path}` });
      expect(reply.status, path).toBe(401);
    }
    expect(reader.tradeCalls).toEqual([]);
    expect(reader.topicCalls).toBe(0);
  });

  it('answers the empty database with zeros and nulls, and empty lists', async () => {
    const { get } = await setup(new FakeReader());
    expect((await get(`${BASE}/overview`)).json()).toMatchObject({
      generated: 0,
      resolvedValid: 0,
      winRate: null,
      expectancyR: null,
      netR: 0,
      currentStreak: null,
    });
    for (const path of ['monthly', 'groups', 'equity', 'drift', 'news-impact']) {
      expect((await get(`${BASE}/${path}`)).json(), path).toEqual({ items: [] });
    }
    expect((await get(`${BASE}/breakdown?by=regime`)).json()).toEqual({ by: 'regime', items: [] });
    expect((await get(`${BASE}/failures`)).json()).toEqual({ causes: [], weakGroups: [] });
    const calibration = (await get(`${BASE}/score-calibration`)).json() as {
      items: { n: number }[];
    };
    expect(calibration.items.map((item) => item.n)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('the scope', () => {
  it('is FORWARD unless the request says BACKTEST_OOS, on every endpoint that is about trades', async () => {
    for (const [path] of ENDPOINTS) {
      if (path === 'drift' || path === 'news-impact') continue;
      const forward = new FakeReader();
      await (await setup(forward)).get(`${BASE}/${path}`);
      expect(
        forward.tradeCalls.map((call) => call.scope),
        path,
      ).toEqual(['FORWARD']);

      const backtest = new FakeReader();
      const separator = path.includes('?') ? '&' : '?';
      await (await setup(backtest)).get(`${BASE}/${path}${separator}scope=BACKTEST_OOS`);
      expect(
        backtest.tradeCalls.map((call) => call.scope),
        path,
      ).toEqual(['BACKTEST_OOS']);
    }
  });

  it('is never mixed: the figures of one scope are worked out from the rows of that scope only', async () => {
    const reader = new FakeReader();
    reader.rows.FORWARD = series('trend_pullback', 3, 3, 1);
    reader.rows.BACKTEST_OOS = series('trend_pullback', 5, 0, 100);
    const { get } = await setup(reader);
    expect((await get(`${BASE}/overview`)).json()).toMatchObject({
      generated: 3,
      wins: 3,
      losses: 0,
    });
    expect((await get(`${BASE}/overview?scope=BACKTEST_OOS`)).json()).toMatchObject({
      generated: 5,
      wins: 0,
      losses: 5,
    });
  });

  it('is refused for a value that is no statistics scope, and for the two sections that have none on purpose', async () => {
    const reader = populated();
    const { get } = await setup(reader);
    for (const path of [
      'overview?scope=LIVE',
      'overview?scope=forward',
      'overview?scope=',
      'drift?scope=BACKTEST_OOS',
      'drift?scope=FORWARD',
      'news-impact?scope=FORWARD',
      'drift?anything=1',
    ]) {
      const reply = await get(`${BASE}/${path}`);
      expect(reply.status, path).toBe(400);
      expect(problemSchema.parse(reply.json()).code, path).toBe('invalid_request');
    }
    expect(reader.tradeCalls).toEqual([]);
  });

  it('reads both scopes for the drift: the forward results are judged by the backtest interval', async () => {
    const reader = new FakeReader();
    reader.rows.FORWARD = series('trend_pullback', 30, 8, 1); // 8 of 30 won: 0.267
    reader.rows.BACKTEST_OOS = series('trend_pullback', 100, 55, 500);
    const { get } = await setup(reader);
    const answer = driftResponseSchema.parse((await get(`${BASE}/drift`)).json());
    expect(answer.items).toEqual([
      {
        strategy: 'trend_pullback',
        window: 50,
        n: 30,
        rollingWinRate: 0.267,
        evidenceCi95: [0.452, 0.644],
        status: 'BELOW_RANGE',
      },
    ]);
    expect(reader.tradeCalls.map((call) => call.scope).sort()).toEqual(['BACKTEST_OOS', 'FORWARD']);
    // swapping the data between the scopes would change the answer
    const swapped = new FakeReader();
    swapped.rows.FORWARD = reader.rows.BACKTEST_OOS;
    swapped.rows.BACKTEST_OOS = reader.rows.FORWARD;
    const { get: getSwapped } = await setup(swapped);
    expect((await getSwapped(`${BASE}/drift`)).json()).not.toEqual(answer);
  });
});

describe('the queries', () => {
  it('hand the range, the strategy and the scope to the reader, the instants as milliseconds', async () => {
    const reader = new FakeReader();
    const { get } = await setup(reader);
    const from = '2026-10-01T00:00:00Z';
    const to = '2026-10-31T18:30:00.500Z';
    await get(`${BASE}/overview?from=${from}&to=${to}&strategy=sweep_reversal&scope=BACKTEST_OOS`);
    await get(`${BASE}/breakdown?by=grade&from=${from}&strategy=trend_pullback`);
    await get(`${BASE}/failures?to=${to}`);
    await get(`${BASE}/equity?from=${from}&to=${to}`);
    await get(`${BASE}/groups?strategy=squeeze_retest`);
    await get(`${BASE}/monthly?strategy=pattern_breakout&months=3`);
    await get(`${BASE}/score-calibration?scope=BACKTEST_OOS`);
    expect(reader.tradeCalls).toEqual([
      {
        scope: 'BACKTEST_OOS',
        from: Date.parse(from),
        to: Date.parse(to),
        strategy: 'sweep_reversal',
      },
      { scope: 'FORWARD', from: Date.parse(from), strategy: 'trend_pullback' },
      { scope: 'FORWARD', to: Date.parse(to) },
      { scope: 'FORWARD', from: Date.parse(from), to: Date.parse(to) },
      { scope: 'FORWARD', strategy: 'squeeze_retest' },
      { scope: 'FORWARD', strategy: 'pattern_breakout' },
      { scope: 'BACKTEST_OOS' },
    ]);
  });

  it('are refused with 400 invalid_request when they do not match the contract', async () => {
    const reader = populated();
    const { get } = await setup(reader);
    const bad = [
      'overview?from=yesterday',
      'overview?from=2026-10-01',
      'overview?from=2026-10-01T00:00:00%2B05:30', // an offset: everything is UTC
      'overview?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z',
      'overview?strategy=nope',
      'overview?limit=5',
      'overview?scope=FORWARD&scope=BACKTEST_OOS',
      'monthly?months=0',
      'monthly?months=121',
      'monthly?months=1.5',
      'monthly?months=abc',
      'monthly?from=2026-10-01T00:00:00Z',
      'breakdown',
      'breakdown?by=colour',
      'failures?strategy=trend_pullback',
      'groups?from=2026-10-01T00:00:00Z',
      'score-calibration?strategy=trend_pullback',
      'equity?strategy=trend_pullback',
    ];
    for (const path of bad) {
      const reply = await get(`${BASE}/${path}`);
      expect(reply.status, path).toBe(400);
      expect(problemSchema.parse(reply.json()).code, path).toBe('invalid_request');
    }
    expect(reader.tradeCalls).toEqual([]);
  });

  it('accept a range with equal ends (an empty range) and the edges of the month count', async () => {
    const { get } = await setup(populated());
    const same = '2026-10-05T08:00:00Z';
    expect((await get(`${BASE}/overview?from=${same}&to=${same}`)).status).toBe(200);
    expect((await get(`${BASE}/monthly?months=1`)).status).toBe(200);
    expect((await get(`${BASE}/monthly?months=120`)).status).toBe(200);
  });

  it('give 12 months by default', async () => {
    const reader = new FakeReader();
    // 20 months of signals: one for each month
    reader.rows.FORWARD = Array.from({ length: 20 }, (_unused, index) =>
      row({ seq: index + 1, generatedAt: Date.UTC(2025, index, 15, 10) }),
    );
    const { get } = await setup(reader);
    const items = monthlyResponseSchema.parse((await get(`${BASE}/monthly`)).json()).items;
    expect(items).toHaveLength(12);
    expect(items[0]?.month).toBe('2025-09');
    expect(items.at(-1)?.month).toBe('2026-08');
    expect(
      monthlyResponseSchema.parse((await get(`${BASE}/monthly?months=20`)).json()).items,
    ).toHaveLength(20);
  });
});

describe('the months follow the display time zone of the settings', () => {
  const edge = Date.UTC(2026, 9, 31, 19, 0, 0); // 00:30 on 1 November in Kolkata, still 31 October in UTC
  const months = async (zone: unknown) => {
    const reader = new FakeReader();
    reader.rows.FORWARD = [row({ seq: 1, generatedAt: edge })];
    reader.zone = zone;
    const { get } = await setup(reader);
    const reply = await get(`${BASE}/monthly`);
    return { reply, items: (reply.json() as { items?: { month: string }[] }).items };
  };

  it('uses the saved zone, and Asia/Kolkata when none was saved', async () => {
    expect((await months('UTC')).items?.map((item) => item.month)).toEqual(['2026-10']);
    expect((await months('Asia/Kolkata')).items?.map((item) => item.month)).toEqual(['2026-11']);
    expect((await months('America/New_York')).items?.map((item) => item.month)).toEqual([
      '2026-10',
    ]);
    expect((await months(null)).items?.map((item) => item.month)).toEqual(['2026-11']);
  });

  it('is a plain 500 when the saved zone is no zone, with nothing of the cause in the answer', async () => {
    const { reply } = await months('Mars/Phobos');
    expect(reply.status).toBe(500);
    expect(problemSchema.parse(reply.json()).code).toBe('server_error');
    expect(reply.res.body).not.toContain('Mars');
  });
});

describe('the cache of 30 seconds', () => {
  it('answers the same request from the cache and reads the database once', async () => {
    const reader = populated();
    const { get, clock } = await setup(reader);
    const first = await get(`${BASE}/overview`);
    const second = await get(`${BASE}/overview`);
    expect(second.json()).toEqual(first.json());
    expect(reader.tradeCalls).toHaveLength(1);
    clock.advance(29_999);
    await get(`${BASE}/overview`);
    expect(reader.tradeCalls).toHaveLength(1);
    clock.advance(1);
    await get(`${BASE}/overview`);
    expect(reader.tradeCalls).toHaveLength(2);
  });

  it('serves the old answer until the 30 seconds are over, then the new one', async () => {
    const reader = new FakeReader();
    reader.rows.FORWARD = series('trend_pullback', 2, 2, 1);
    const { get, clock } = await setup(reader);
    expect((await get(`${BASE}/overview`)).json()).toMatchObject({ generated: 2 });
    reader.rows.FORWARD = series('trend_pullback', 3, 3, 1);
    clock.advance(15_000);
    expect((await get(`${BASE}/overview`)).json()).toMatchObject({ generated: 2 });
    clock.advance(15_000);
    expect((await get(`${BASE}/overview`)).json()).toMatchObject({ generated: 3 });
  });

  it('keeps an answer for each endpoint and each query', async () => {
    const reader = populated();
    const { get } = await setup(reader);
    const urls = [
      `${BASE}/overview`,
      `${BASE}/overview?scope=BACKTEST_OOS`,
      `${BASE}/overview?strategy=trend_pullback`,
      `${BASE}/overview?from=2026-10-01T00:00:00Z`,
      `${BASE}/equity`,
      `${BASE}/breakdown?by=side`,
      `${BASE}/breakdown?by=session`,
      `${BASE}/monthly`,
      `${BASE}/monthly?months=6`,
    ];
    for (const url of urls) await get(url);
    expect(reader.tradeCalls).toHaveLength(urls.length);
    for (const url of urls) await get(url);
    expect(reader.tradeCalls).toHaveLength(urls.length);
  });

  it('knows the same request however it is written: the default scope, the same instant, the order of the names', async () => {
    const reader = populated();
    const { get } = await setup(reader);
    await get(
      `${BASE}/overview?from=2026-10-01T00:00:00Z&to=2026-10-31T00:00:00Z&strategy=trend_pullback`,
    );
    await get(
      `${BASE}/overview?strategy=trend_pullback&to=2026-10-31T00:00:00.000Z&from=2026-10-01T00:00:00.000Z&scope=FORWARD`,
    );
    expect(reader.tradeCalls).toHaveLength(1);
  });

  it('does not keep a failed computation: the next request tries again, and nothing broken is served', async () => {
    const reader = populated();
    reader.failure = new Error('connect ECONNREFUSED 10.0.0.9:5432 password=hunter2');
    const { get } = await setup(reader);
    for (const path of ['overview', 'news-impact', 'drift']) {
      const reply = await get(`${BASE}/${path}`);
      expect(reply.status, path).toBe(500);
      expect(problemSchema.parse(reply.json()).code, path).toBe('server_error');
      expect(reply.res.body, path).not.toContain('ECONNREFUSED');
      expect(reply.res.body, path).not.toContain('hunter2');
    }
    const calls = reader.tradeCalls.length;
    reader.failure = null;
    expect((await get(`${BASE}/overview`)).status).toBe(200);
    expect(reader.tradeCalls.length).toBe(calls + 1);
    expect((await get(`${BASE}/news-impact`)).status).toBe(200);
    expect((await get(`${BASE}/drift`)).status).toBe(200);
  });

  it('shares one computation between the requests that come while it is running', async () => {
    const reader = populated();
    let release: () => void = () => undefined;
    reader.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { get } = await setup(reader);
    const pending = [1, 2, 3, 4].map(() => get(`${BASE}/overview`));
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    const replies = await Promise.all(pending);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200, 200]);
    expect(reader.tradeCalls).toHaveLength(1);
  });

  it('is bounded: many different queries never keep more than the limit', async () => {
    const reader = populated();
    const { get } = await setup(reader, { cacheEntries: 3 });
    for (let day = 1; day <= 10; day += 1) {
      await get(`${BASE}/overview?from=2026-10-${String(day).padStart(2, '0')}T00:00:00Z`);
    }
    expect(reader.tradeCalls).toHaveLength(10);
    // the newest answers are still there, the oldest are gone
    await get(`${BASE}/overview?from=2026-10-10T00:00:00Z`);
    expect(reader.tradeCalls).toHaveLength(10);
    await get(`${BASE}/overview?from=2026-10-01T00:00:00Z`);
    expect(reader.tradeCalls).toHaveLength(11);
  });

  it('can be set to another time', async () => {
    const reader = populated();
    const { get, clock } = await setup(reader, { cacheMs: 1000 });
    await get(`${BASE}/overview`);
    clock.advance(999);
    await get(`${BASE}/overview`);
    expect(reader.tradeCalls).toHaveLength(1);
    clock.advance(1);
    await get(`${BASE}/overview`);
    expect(reader.tradeCalls).toHaveLength(2);
  });
});

describe('AnswerCache', () => {
  const make = (ttlMs = 30_000, maxEntries = 3) => {
    const clock = { now: START };
    const cache = new AnswerCache({ ttlMs, maxEntries, now: () => clock.now });
    let computed = 0;
    const value = (text: string) => () => {
      computed += 1;
      return Promise.resolve(`${text}${String(computed)}`);
    };
    return { clock, cache, value, count: () => computed };
  };

  it('keeps an answer for exactly the time to live, counted from the start of its computation', async () => {
    const { clock, cache, value, count } = make();
    expect(await cache.get('a', value('a'))).toBe('a1');
    clock.now += 29_999;
    expect(await cache.get('a', value('a'))).toBe('a1');
    clock.now += 1;
    expect(await cache.get('a', value('a'))).toBe('a2');
    expect(count()).toBe(2);
  });

  it('counts the time from the start of the work, so a slow computation does not keep its answer longer', async () => {
    const { clock, cache } = make();
    const slow = async () => {
      clock.now += 20_000;
      return Promise.resolve('slow');
    };
    await cache.get('a', slow);
    // 20 s after it was done, 40 s after it began: it is over
    clock.now += 20_000;
    expect(await cache.get('a', () => Promise.resolve('fresh'))).toBe('fresh');
  });

  it('does not trust an answer from the future, the clock having moved back', async () => {
    const { clock, cache, value } = make();
    await cache.get('a', value('a'));
    clock.now -= 5000;
    expect(await cache.get('a', value('a'))).toBe('a2');
  });

  it('does not keep a failure, whether the computation rejects or throws, and does not stay stuck on it', async () => {
    const { cache, value } = make();
    await expect(cache.get('a', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(cache.size).toBe(0);
    await expect(
      cache.get('a', () => {
        throw new Error('thrown at once');
      }),
    ).rejects.toThrow('thrown at once');
    expect(cache.size).toBe(0);
    expect(await cache.get('a', value('a'))).toBe('a1');
    expect(cache.size).toBe(1);
  });

  it('shares the work of requests that come while it runs, a failure included, and then forgets it', async () => {
    const { cache } = make();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    let release: (text: string) => void = () => undefined;
    let runs = 0;
    const slow = () => {
      runs += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };
    const first = cache.get('a', slow);
    const second = cache.get('a', slow);
    await tick();
    release('done');
    expect(await Promise.all([first, second])).toEqual(['done', 'done']);
    expect(runs).toBe(1);

    let fail: (error: Error) => void = () => undefined;
    const failing = () =>
      new Promise<string>((_resolve, reject) => {
        fail = reject;
      });
    const one = cache.get('b', failing);
    const two = cache.get('b', failing);
    await tick();
    fail(new Error('boom'));
    await expect(one).rejects.toThrow('boom');
    await expect(two).rejects.toThrow('boom');
    expect(await cache.get('b', () => Promise.resolve('again'))).toBe('again');
  });

  it('keeps at most the limit, dropping the oldest answer first', async () => {
    const { cache, value, count } = make(30_000, 3);
    for (const key of ['a', 'b', 'c', 'd', 'e']) await cache.get(key, value(key));
    expect(cache.size).toBe(3);
    expect(count()).toBe(5);
    await cache.get('e', value('e'));
    await cache.get('d', value('d'));
    await cache.get('c', value('c'));
    expect(count()).toBe(5);
    await cache.get('a', value('a'));
    expect(count()).toBe(6);
  });

  it('drops the answers that are no good before it drops one that is, the oldest first among the good ones', async () => {
    const { clock, cache, value, count } = make(30_000, 2);
    await cache.get('good', value('good'));
    clock.now += 10_000;
    await cache.get('future', value('future'));
    clock.now -= 10_000; // the clock moved back: `future` is stamped in the future
    await cache.get('new', value('new'));
    expect(cache.size).toBe(2);
    expect(count()).toBe(3);
    // `good` was kept although it is the oldest
    await cache.get('good', value('good'));
    expect(count()).toBe(3);
  });

  it('answers a refresh of a key without growing', async () => {
    const { clock, cache, value } = make(10, 3);
    for (let round = 0; round < 10; round += 1) {
      await cache.get('a', value('a'));
      clock.now += 10;
    }
    expect(cache.size).toBe(1);
  });
});
