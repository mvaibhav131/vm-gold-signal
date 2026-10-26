import { describe, expect, it } from 'vitest';

import {
  candlesResponseSchema,
  marketSnapshotSchema,
  problemSchema,
  type ChartObject,
  type Level,
} from '@vmgs/contracts';
import { Ema, GATE_DEFAULTS, sessionAt, type Timeframe } from '@vmgs/core';
import { WORKER_ALIVE_MAX_AGE_MS } from '@vmgs/db';

import { makeHarness } from '../testing/harness';
import { computeOverlays, overlayWarmup, trustCandles } from './overlays';
import type { MarketFacts, MarketReader, StoredCandle } from './reader';
import { registerMarketRoutes, type ChartLayers } from './routes';
import { feedStateOf, snapshotOf, storedEngineOf } from './snapshot';

const NOW = Date.UTC(2026, 9, 26, 8, 5, 30);
const HOUR = 3_600_000;
const MIN = 60_000;

function facts(
  change: Partial<MarketFacts> = {},
  quoteChange: Partial<MarketFacts['quote'] & object> = {},
): MarketFacts {
  return {
    quote: {
      sourceAt: NOW - 1000,
      receivedAt: NOW - 400,
      bid: 4017.37,
      ask: 4017.55,
      ...quoteChange,
    },
    worker: { heartbeatAt: NOW - 5000, provider: 'biquote', feedState: 'LIVE' },
    engineDoc: { status: 'RUNNING' },
    engineStateDoc: {
      evaluatedAt: NOW - 3 * MIN,
      regime: 'TREND_UP',
      warmup: { ready: true, progressPct: 100, missingTimeframes: [] },
      waitReasons: [{ code: 'QUALITY_OK', label: 'Quality score 61.0 is below 65' }],
    },
    openStatuses: [],
    ...change,
  };
}

describe('snapshotOf', () => {
  it('shows a live market: the quote, its age, the session, the regime and the engine', () => {
    const snapshot = marketSnapshotSchema.parse(snapshotOf(facts(), NOW));
    expect(snapshot).toEqual({
      symbol: 'XAUUSD',
      bid: 4017.37,
      ask: 4017.55,
      mid: 4017.46,
      spread: 0.18,
      sourceAt: new Date(NOW - 1000).toISOString(),
      receivedAt: new Date(NOW - 400).toISOString(),
      ageMs: 1000,
      feedState: 'LIVE',
      session: sessionAt(NOW),
      regime: 'TREND_UP',
      mode: 'LIVE',
      engine: {
        status: 'RUNNING',
        openCount: 0,
        openRiskR: 0,
        warmup: { ready: true, progressPct: 100, missingTimeframes: [] },
        waitReasons: [{ code: 'QUALITY_OK', label: 'Quality score 61.0 is below 65' }],
        evaluatedAt: new Date(NOW - 3 * MIN).toISOString(),
      },
    });
  });

  it('rounds the mid half up to three decimals, and gives the spread without float noise', () => {
    const odd = snapshotOf(facts({}, { bid: 4017.373, ask: 4017.374 }), NOW);
    expect(odd.mid).toBe(4017.374);
    expect(odd.spread).toBe(0.001);
    const even = snapshotOf(facts({}, { bid: 4017.37, ask: 4017.38 }), NOW);
    expect(even.mid).toBe(4017.375);
    expect(snapshotOf(facts({}, { bid: 4017.1, ask: 4017.1 }), NOW).spread).toBe(0);
  });

  it('is a 503 no_quote when there is no tick: no price is made up', () => {
    expect(() => snapshotOf(facts({ quote: null }), NOW)).toThrow(
      expect.objectContaining({ status: 503, code: 'no_quote' }),
    );
  });

  it('never shows a negative age (a tick a moment ahead of the clock)', () => {
    expect(snapshotOf(facts({}, { sourceAt: NOW + 800 }), NOW).ageMs).toBe(0);
  });

  it('is SIMULATED for a replayed feed and LIVE for the real one', () => {
    const replay = facts({ worker: { heartbeatAt: NOW, provider: 'replay', feedState: 'LIVE' } });
    expect(snapshotOf(replay, NOW).mode).toBe('SIMULATED');
    const other = facts({ worker: { heartbeatAt: NOW, provider: null, feedState: 'LIVE' } });
    expect(snapshotOf(other, NOW).mode).toBe('LIVE');
  });
});

describe('the feed state of the snapshot', () => {
  const state = (change: Partial<MarketFacts['worker']>, age = 1000, warmedUp = true) =>
    feedStateOf(
      facts({
        worker: { heartbeatAt: NOW - 1000, provider: 'biquote', feedState: 'LIVE', ...change },
      }),
      age,
      NOW,
      warmedUp,
    );

  it('is what the feed monitor said, while the worker is alive', () => {
    expect(state({ feedState: 'LIVE' })).toBe('LIVE');
    expect(state({ feedState: 'STALE' })).toBe('STALE');
    expect(state({ feedState: 'DISCONNECTED' })).toBe('DISCONNECTED');
    expect(state({ feedState: 'MARKET_CLOSED' }, 3 * HOUR)).toBe('MARKET_CLOSED');
  });

  it('is DISCONNECTED when the worker has not been heard from: nothing it said is current', () => {
    expect(state({ heartbeatAt: null })).toBe('DISCONNECTED');
    expect(state({ heartbeatAt: NOW - WORKER_ALIVE_MAX_AGE_MS })).toBe('LIVE');
    expect(state({ heartbeatAt: NOW - WORKER_ALIVE_MAX_AGE_MS - 1 })).toBe('DISCONNECTED');
  });

  it('is STALE when the tick is older than the gate allows, whatever the last heartbeat said', () => {
    const limit = GATE_DEFAULTS.maxTickAgeSec * 1000 + 5000;
    expect(state({}, limit)).toBe('LIVE');
    expect(state({}, limit + 1)).toBe('STALE');
    // a market that is closed is closed, however old the tick
    expect(state({ feedState: 'MARKET_CLOSED' }, limit + 1)).toBe('MARKET_CLOSED');
  });

  it('is WARMING_UP while the engine lacks candles, and while the worker has not said what the feed does', () => {
    expect(state({}, 1000, false)).toBe('WARMING_UP');
    expect(state({ feedState: null })).toBe('WARMING_UP');
    expect(state({ feedState: 'SOMETHING_NEW' })).toBe('WARMING_UP');
    // a feed that is down stays down however far the warm-up is
    expect(state({ feedState: 'DISCONNECTED' }, 1000, false)).toBe('DISCONNECTED');
  });
});

describe('the engine block of the snapshot', () => {
  it('says why a signal cannot come while the feed is not live, first, in the words of the gates', () => {
    const dead = snapshotOf(
      facts({ worker: { heartbeatAt: null, provider: null, feedState: null } }),
      NOW,
    );
    expect(dead.feedState).toBe('DISCONNECTED');
    expect(dead.engine.waitReasons[0]).toEqual({
      code: 'DATA_FRESH',
      label: 'Feed disconnected: new signals are blocked',
    });
    const closed = snapshotOf(
      facts(
        { worker: { heartbeatAt: NOW, provider: 'biquote', feedState: 'MARKET_CLOSED' } },
        { sourceAt: NOW - 5 * HOUR },
      ),
      NOW,
    );
    expect(closed.engine.waitReasons[0]?.label).toBe(
      'Market closed: new signals wait for the reopening',
    );
  });

  it('drops a stale-feed reason of the last decision once the feed is live again, and keeps the others', () => {
    const snapshot = snapshotOf(
      facts({
        engineStateDoc: {
          evaluatedAt: NOW - MIN,
          regime: 'RANGE',
          warmup: { ready: true, progressPct: 100, missingTimeframes: [] },
          waitReasons: [
            { code: 'DATA_FRESH', label: 'No tick for 30 s: new signals are blocked' },
            { code: 'SPREAD_OK', label: 'Spread too high: 0.90 USD' },
          ],
        },
      }),
      NOW,
    );
    expect(snapshot.engine.waitReasons.map((reason) => reason.code)).toEqual(['SPREAD_OK']);
  });

  it('keeps the stale-feed reason of the last decision, once and as it was written, while the feed is still stale', () => {
    const snapshot = snapshotOf(
      facts(
        {
          engineStateDoc: {
            evaluatedAt: NOW - MIN,
            regime: 'RANGE',
            warmup: { ready: true, progressPct: 100, missingTimeframes: [] },
            waitReasons: [
              { code: 'DATA_FRESH', label: 'No tick for 38 s: new signals are blocked' },
              { code: 'SPREAD_OK', label: 'Spread too high: 0.90 USD' },
            ],
          },
        },
        { sourceAt: NOW - 41_000 },
      ),
      NOW,
    );
    expect(snapshot.feedState).toBe('STALE');
    // the decision's own words stay (it looked three seconds before this answer)
    expect(snapshot.engine.waitReasons).toEqual([
      { code: 'DATA_FRESH', label: 'No tick for 38 s: new signals are blocked' },
      { code: 'SPREAD_OK', label: 'Spread too high: 0.90 USD' },
    ]);
  });

  it('lists no missing timeframe for an engine that says it is ready (the contract has none for it)', () => {
    const snapshot = snapshotOf(
      facts({
        engineStateDoc: {
          evaluatedAt: NOW - MIN,
          regime: 'RANGE',
          warmup: { ready: true, progressPct: 100, missingTimeframes: ['1h'] },
          waitReasons: [],
        },
      }),
      NOW,
    );
    expect(snapshot.engine.warmup).toEqual({
      ready: true,
      progressPct: 100,
      missingTimeframes: [],
    });
  });

  it('is warming up with every timeframe missing before the engine has said anything', () => {
    const snapshot = snapshotOf(facts({ engineStateDoc: null }), NOW);
    expect(snapshot.feedState).toBe('WARMING_UP');
    expect(snapshot.regime).toBe('UNCERTAIN');
    expect(snapshot.engine.warmup).toEqual({
      ready: false,
      progressPct: 0,
      missingTimeframes: ['5m', '15m', '1h'],
    });
    expect(snapshot.engine.waitReasons).toEqual([
      { code: 'WARMUP_OK', label: 'Warming up: 5m, 15m and 1h candles are still missing' },
    ]);
    expect(snapshot.engine.evaluatedAt).toBe(new Date(NOW).toISOString());
  });

  it('takes the warm-up from the stored state, with no duplicate of its own reason', () => {
    const snapshot = snapshotOf(
      facts({
        engineStateDoc: {
          evaluatedAt: NOW - MIN,
          regime: null,
          warmup: { ready: false, progressPct: 40, missingTimeframes: ['1h'] },
          waitReasons: [{ code: 'WARMUP_OK', label: 'Warming up: 1h candles are still missing' }],
        },
      }),
      NOW,
    );
    expect(snapshot.engine.warmup).toEqual({
      ready: false,
      progressPct: 40,
      missingTimeframes: ['1h'],
    });
    expect(snapshot.engine.waitReasons).toHaveLength(1);
    expect(snapshot.regime).toBe('UNCERTAIN');
  });

  it('shows no regime and no reasons of a decision that is older than the state is kept, but keeps the warm-up', () => {
    const old = snapshotOf(
      facts({
        engineStateDoc: {
          evaluatedAt: NOW - 13 * HOUR,
          regime: 'TREND_UP',
          warmup: { ready: true, progressPct: 100, missingTimeframes: [] },
          waitReasons: [{ code: 'QUALITY_OK', label: 'Quality score 61.0 is below 65' }],
        },
      }),
      NOW,
    );
    expect(old.regime).toBe('UNCERTAIN');
    expect(old.engine.waitReasons).toEqual([]);
    expect(old.engine.warmup.ready).toBe(true);
    expect(old.feedState).toBe('LIVE');
    const edge = snapshotOf(
      facts({
        engineStateDoc: { ...(facts().engineStateDoc as object), evaluatedAt: NOW - 12 * HOUR },
      }),
      NOW,
    );
    expect(edge.regime).toBe('TREND_UP');
  });

  it('reads a state it does not understand as no state, and never as something wrong', () => {
    for (const doc of [
      {},
      'x',
      5,
      { evaluatedAt: 'soon' },
      { ...(facts().engineStateDoc as object), regime: 'SIDEWAYS' },
    ]) {
      const snapshot = snapshotOf(facts({ engineStateDoc: doc }), NOW);
      expect(snapshot.regime, JSON.stringify(doc)).toBe('UNCERTAIN');
      expect(snapshot.engine.warmup.ready).toBe(false);
    }
  });

  it('is paused while the pause lasts, and running when it has run out or cannot be read', () => {
    const since = new Date(NOW - 10 * MIN).toISOString();
    const endless = snapshotOf(
      facts({ engineDoc: { status: 'PAUSED', pausedSince: since, pausedUntil: null } }),
      NOW,
    );
    expect(endless.engine).toMatchObject({ status: 'PAUSED', pausedSince: since });
    const timed = (until: number) =>
      snapshotOf(
        facts({
          engineDoc: {
            status: 'PAUSED',
            pausedSince: since,
            pausedUntil: new Date(until).toISOString(),
          },
        }),
        NOW,
      );
    expect(timed(NOW + 1).engine.status).toBe('PAUSED');
    expect(timed(NOW).engine.status).toBe('RUNNING');
    expect(timed(NOW).engine).not.toHaveProperty('pausedSince');
    for (const doc of [null, {}, { status: 'PAUSED' }, 'PAUSED']) {
      expect(snapshotOf(facts({ engineDoc: doc }), NOW).engine.status, JSON.stringify(doc)).toBe(
        'RUNNING',
      );
    }
  });

  it('counts the open signals and what they still risk: one R until TP1, none after', () => {
    const snapshot = snapshotOf(facts({ openStatuses: ['ACTIVE', 'TP1_HIT', 'ACTIVE'] }), NOW);
    expect(snapshot.engine).toMatchObject({ openCount: 3, openRiskR: 2 });
  });
});

describe('storedEngineOf', () => {
  it('reads the pause the way the worker does', () => {
    expect(storedEngineOf({ status: 'RUNNING' })).toEqual({ status: 'RUNNING' });
    expect(
      storedEngineOf({
        status: 'PAUSED',
        pausedSince: '2026-10-26T08:00:00.000Z',
        pausedUntil: null,
      }),
    ).toEqual({ status: 'PAUSED', since: Date.UTC(2026, 9, 26, 8, 0, 0), until: null });
  });
});

describe('the overlays', () => {
  const candles = (count: number): StoredCandle[] =>
    Array.from({ length: count }, (_, i) => {
      const c = 4000 + Math.sin(i / 7) * 12 + i * 0.05;
      return { openTime: 1_700_000_000_000 + i * 300_000, o: c - 0.4, h: c + 1.2, l: c - 1.1, c };
    });

  it('needs three times the period of candles before it shows a value', () => {
    expect(trustCandles('ema20')).toBe(60);
    expect(trustCandles('ema50')).toBe(150);
    expect(trustCandles('ema200')).toBe(600);
    expect(trustCandles('supertrend')).toBe(30);
    expect(overlayWarmup([])).toBe(0);
    expect(overlayWarmup(['ema20', 'ema200'])).toBe(600);
  });

  it("gives one value per candle: null while the average is not trusted, then the engine's own average", () => {
    const series = candles(200);
    const { ema20 } = computeOverlays(series, ['ema20']);
    expect(ema20).toHaveLength(200);
    expect(ema20?.slice(0, 59).every((value) => value === null)).toBe(true);
    expect(ema20?.[59]).not.toBeNull();
    const reference = new Ema(20);
    const expected = series.map((candle) => reference.update(candle.c));
    for (let i = 59; i < 200; i += 1) {
      expect(ema20?.[i]).toBe(Math.round((expected[i] ?? 0) * 1000) / 1000);
    }
  });

  it('has no value of an average for fewer candles than it needs', () => {
    expect(computeOverlays(candles(599), ['ema200']).ema200?.every((value) => value === null)).toBe(
      true,
    );
    expect(computeOverlays(candles(600), ['ema200']).ema200?.at(-1)).not.toBeNull();
  });

  it('gives the supertrend line below the price in a rise and above it in a fall', () => {
    const rising = Array.from({ length: 80 }, (_, i): StoredCandle => ({
      openTime: i * 300_000,
      o: 4000 + i,
      h: 4001.5 + i,
      l: 3999.5 + i,
      c: 4001 + i,
    }));
    const { supertrend } = computeOverlays(rising, ['supertrend']);
    expect(supertrend?.slice(0, 29).every((value) => value === null)).toBe(true);
    const last = supertrend?.at(-1);
    expect(last).not.toBeNull();
    expect(last ?? 0).toBeLessThan(rising.at(-1)?.l ?? 0);
    const falling = rising.map((c, i): StoredCandle => ({
      openTime: c.openTime,
      o: 4100 - i,
      h: 4101.5 - i,
      l: 4099.5 - i,
      c: 4099 - i,
    }));
    expect(computeOverlays(falling, ['supertrend']).supertrend?.at(-1) ?? 0).toBeGreaterThan(
      falling.at(-1)?.h ?? 0,
    );
  });

  it('computes only what is asked, and nothing for an empty list', () => {
    expect(Object.keys(computeOverlays(candles(100), ['ema50']))).toEqual(['ema50']);
    expect(computeOverlays(candles(100), [])).toEqual({});
    expect(computeOverlays([], ['ema20']).ema20).toEqual([]);
  });
});

class FakeReader implements MarketReader {
  stored: StoredCandle[] = [];
  asked: { tf: Timeframe; count: number; before: number | null }[] = [];
  factsNow: MarketFacts = facts();
  factsAsked = 0;

  facts(): Promise<MarketFacts> {
    this.factsAsked += 1;
    return Promise.resolve(this.factsNow);
  }

  candles(tf: Timeframe, count: number, before: number | null): Promise<StoredCandle[]> {
    this.asked.push({ tf, count, before });
    return Promise.resolve(this.stored.slice(-count));
  }
}

class FakeLayers implements ChartLayers {
  levelCalls = 0;
  objectCalls: { kinds: readonly string[]; tf: Timeframe; now: number }[] = [];
  levelList: Level[] = [{ key: 'PDH', label: 'Previous day high', price: 4040.5 }];
  objectList: ChartObject[] = [];

  levels(): Promise<Level[]> {
    this.levelCalls += 1;
    return Promise.resolve(this.levelList);
  }

  objects(kinds: readonly string[], tf: Timeframe, now: number): Promise<ChartObject[]> {
    this.objectCalls.push({ kinds, tf, now });
    return Promise.resolve(this.objectList);
  }
}

async function setup() {
  const reader = new FakeReader();
  const layers = new FakeLayers();
  const h = await makeHarness({
    routes: (app, clock) => {
      clock.now = NOW;
      registerMarketRoutes(app, { reader, layers, now: () => clock.now });
    },
  });
  return { h, reader, layers, cookie: await h.login() };
}

const BASE = '/api/v1/market';

const series = (count: number): StoredCandle[] =>
  Array.from({ length: count }, (_, i) => ({
    openTime: Date.UTC(2026, 9, 20) + i * 300_000,
    o: 4000 + i * 0.1,
    h: 4001 + i * 0.1,
    l: 3999 + i * 0.1,
    c: 4000.5 + i * 0.1,
  }));

describe('GET /market/snapshot', () => {
  it('answers the snapshot of the clock of the service', async () => {
    const { h, reader, cookie } = await setup();
    reader.factsNow = facts();
    h.clock.now = NOW;
    const reply = await h.send({ url: `${BASE}/snapshot`, cookie });
    expect(reply.status).toBe(200);
    expect(marketSnapshotSchema.parse(reply.json())).toMatchObject({
      ageMs: 1000,
      feedState: 'LIVE',
    });
  });

  it('is 503 no_quote when there is no tick yet, and needs a session', async () => {
    const { h, reader, cookie } = await setup();
    reader.factsNow = facts({ quote: null });
    const reply = await h.send({ url: `${BASE}/snapshot`, cookie });
    expect(reply.status).toBe(503);
    expect(problemSchema.parse(reply.json()).code).toBe('no_quote');
    expect((await h.send({ url: `${BASE}/snapshot` })).status).toBe(401);
  });
});

describe('GET /market/candles', () => {
  it('answers the newest 500 candles of the 5m chart, oldest first, with levels and no objects', async () => {
    const { h, reader, layers, cookie } = await setup();
    reader.stored = series(800);
    const reply = await h.send({ url: `${BASE}/candles`, cookie });
    expect(reply.status).toBe(200);
    const body = candlesResponseSchema.parse(reply.json());
    expect(body.candles).toHaveLength(500);
    expect(body.candles[0]?.t).toBe(new Date(reader.stored[300]?.openTime ?? 0).toISOString());
    expect(body.candles.at(-1)?.t).toBe(new Date(reader.stored[799]?.openTime ?? 0).toISOString());
    expect(body.overlays).toEqual({});
    expect(body.levels).toEqual(layers.levelList);
    expect(body.objects).toEqual([]);
    expect(layers.objectCalls).toEqual([]);
    expect(reader.asked).toEqual([{ tf: '5m', count: 500, before: null }]);
  });

  it('loads the warm-up of the overlays in front of what is shown, and cuts it from the answer', async () => {
    const { h, reader, cookie } = await setup();
    reader.stored = series(900);
    const reply = await h.send({ url: `${BASE}/candles?limit=100&overlays=ema20,ema200`, cookie });
    const body = candlesResponseSchema.parse(reply.json());
    expect(reader.asked).toEqual([{ tf: '5m', count: 700, before: null }]);
    expect(body.candles).toHaveLength(100);
    expect(Object.keys(body.overlays).sort()).toEqual(['ema20', 'ema200']);
    expect(body.overlays.ema20).toHaveLength(100);
    expect(body.overlays.ema200).toHaveLength(100);
    expect(body.overlays.ema20?.every((value) => value !== null)).toBe(true);
    // 700 candles were read, the 200-average is trusted from the 600th: all 100 shown values are there
    expect(body.overlays.ema200?.every((value) => value !== null)).toBe(true);
  });

  it('shows null for an average that has too few candles behind it', async () => {
    const { h, reader, cookie } = await setup();
    reader.stored = series(200);
    const body = candlesResponseSchema.parse(
      (await h.send({ url: `${BASE}/candles?limit=100&overlays=ema50,ema200`, cookie })).json(),
    );
    expect(body.candles).toHaveLength(100);
    expect(body.overlays.ema200?.every((value) => value === null)).toBe(true);
    // 200 candles are there: the 50-average is trusted from the 150th, which is the 50th of the 100 shown
    expect(body.overlays.ema50?.filter((value) => value === null)).toHaveLength(49);
    expect(body.overlays.ema50?.[48]).toBeNull();
    expect(body.overlays.ema50?.[49]).not.toBeNull();
  });

  it('passes the timeframe and the page to the reader, and asks for the objects that were named', async () => {
    const { h, reader, layers, cookie } = await setup();
    reader.stored = series(50);
    layers.objectList = [
      {
        id: 'tl-1',
        type: 'trendline',
        tf: '1h',
        points: [
          { t: '2026-10-20T00:00:00Z', price: 4001 },
          { t: '2026-10-20T04:00:00Z', price: 4005 },
        ],
        meta: {},
      },
    ];
    const before = '2026-10-21T00:00:00.000Z';
    const reply = await h.send({
      url: `${BASE}/candles?tf=1h&limit=20&before=${before}&objects=trendlines,zones`,
      cookie,
    });
    expect(reply.status).toBe(200);
    expect(reader.asked).toEqual([{ tf: '1h', count: 20, before: Date.parse(before) }]);
    expect(layers.objectCalls).toEqual([{ kinds: ['trendlines', 'zones'], tf: '1h', now: NOW }]);
    expect(candlesResponseSchema.parse(reply.json()).objects).toHaveLength(1);
  });

  it('is an empty chart, not an error, when there are no candles', async () => {
    const { h, cookie } = await setup();
    const body = candlesResponseSchema.parse(
      (await h.send({ url: `${BASE}/candles?overlays=ema20`, cookie })).json(),
    );
    expect(body.candles).toEqual([]);
    expect(body.overlays).toEqual({ ema20: [] });
  });

  it('refuses a query that does not match the contract, and a request without a session', async () => {
    const { h, reader, cookie } = await setup();
    for (const query of [
      'limit=0',
      'limit=2001',
      'limit=ten',
      'tf=2m',
      'overlays=ema99',
      'objects=circles',
      'before=yesterday',
      'sort=asc',
    ]) {
      const reply = await h.send({ url: `${BASE}/candles?${query}`, cookie });
      expect(reply.status, query).toBe(400);
      expect(problemSchema.parse(reply.json()).code).toBe('invalid_request');
    }
    expect(reader.asked).toEqual([]);
    expect((await h.send({ url: `${BASE}/candles` })).status).toBe(401);
  });
});
