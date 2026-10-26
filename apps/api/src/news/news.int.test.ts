import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  headlinesResponseSchema,
  marketMovesResponseSchema,
  newsEventsResponseSchema,
  newsStateResponseSchema,
  problemSchema,
} from '@vmgs/contracts';
import { surpriseOf } from '@vmgs/core';

import { startPgApi, type PgApi } from '../testing/pgApi';
import { T0 } from '../testing/harness';
import { CALENDAR_HEARTBEAT } from './reader';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TODAY = Date.UTC(2026, 9, 26);
const ISO = (ms: number): string => new Date(ms).toISOString();
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

let api: PgApi;

beforeAll(async () => {
  api = await startPgApi();
  // the ticks of the day of the tests need a partition
  await api.admin.query(
    `CREATE TABLE IF NOT EXISTS ticks_20261026 PARTITION OF ticks
       FOR VALUES FROM ('2026-10-26') TO ('2026-10-27')`,
  );
});

afterAll(async () => {
  await api.close();
});

beforeEach(async () => {
  api.clock.now = T0;
  await api.admin.query(
    `TRUNCATE news_impact_samples, news_topic_stats, news_items, news_sources, market_events,
              macro_events, ticks, candles, worker_heartbeats RESTART IDENTITY`,
  );
});

// ------------------------------------------------------------------------------------ seeds

interface EventSeed {
  id: string;
  at: number;
  name?: string;
  importance?: 'low' | 'medium' | 'high';
  currency?: string | null;
  unit?: string | null;
  multiplier?: string | null;
  actual?: number | null;
  forecast?: number | null;
  previous?: number | null;
  revised?: number | null;
  raw?: Record<string, unknown>;
}

let sourceEvents = 0;
async function addEvent(seed: EventSeed): Promise<void> {
  sourceEvents += 1;
  await api.admin.query(
    `INSERT INTO macro_events
       (id, source, source_event_id, scheduled_at, currency, name, importance, unit, multiplier,
        actual, forecast, previous, revised_previous, raw)
     VALUES ($1, 'biquote', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
    [
      seed.id,
      `ev-${String(sourceEvents)}`,
      new Date(seed.at),
      seed.currency === undefined ? 'USD' : seed.currency,
      seed.name ?? 'US CPI m/m',
      seed.importance ?? 'high',
      seed.unit ?? null,
      seed.multiplier ?? null,
      seed.actual ?? null,
      seed.forecast ?? null,
      seed.previous ?? null,
      seed.revised ?? null,
      JSON.stringify({ timeMode: 'exact', ...seed.raw }),
    ],
  );
}

async function beat(at: number | null): Promise<void> {
  await api.admin.query('DELETE FROM worker_heartbeats WHERE worker_name = $1', [
    CALENDAR_HEARTBEAT,
  ]);
  if (at === null) return;
  await api.admin.query(
    `INSERT INTO worker_heartbeats (worker_name, heartbeat_at, metadata) VALUES ($1, $2, '{}'::jsonb)`,
    [CALENDAR_HEARTBEAT, new Date(at)],
  );
}

interface CandleSeed {
  at: number;
  o: number;
  c: number;
  tf?: '1m' | '5m' | '15m';
  complete?: boolean;
  symbol?: string;
  range?: number;
}

async function addCandles(seeds: readonly CandleSeed[]): Promise<void> {
  for (const seed of seeds) {
    const half = (seed.range ?? 1) / 2;
    await api.admin.query(
      `INSERT INTO candles (symbol, tf, open_time, o, h, l, c, complete)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        seed.symbol ?? 'XAUUSD',
        seed.tf ?? '1m',
        new Date(seed.at),
        seed.o,
        Math.max(seed.o, seed.c) + half,
        Math.min(seed.o, seed.c) - half,
        seed.c,
        seed.complete ?? true,
      ],
    );
  }
}

/** 20 complete 5m candles that end at `until`, each with a range of 1, so that the ATR(14) is 1. */
function flatFives(until: number, range = 1): CandleSeed[] {
  return Array.from({ length: 20 }, (_, index) => ({
    at: until - (20 - index) * 5 * MIN,
    o: 4000,
    c: 4000,
    tf: '5m' as const,
    range,
  }));
}

/** Five complete 1m candles from `at`: the first opens at `open`, the last closes at `close`. */
function minutesFrom(at: number, open: number, close: number): CandleSeed[] {
  return [0, 1, 2, 3, 4].map((minute) => ({
    at: at + minute * MIN,
    o: minute === 0 ? open : 4000,
    c: minute === 4 ? close : 4000,
  }));
}

async function addSource(
  key: string,
  over: { name?: string; enabled?: boolean; okAt?: number | null; error?: string | null } = {},
): Promise<void> {
  await api.admin.query(
    `INSERT INTO news_sources (key, name, tier, enabled, last_ok_at, last_error)
     VALUES ($1, $2, 2, $3, $4, $5)`,
    [
      key,
      over.name ?? key.toUpperCase(),
      over.enabled ?? true,
      over.okAt === undefined || over.okAt === null ? null : new Date(over.okAt),
      over.error ?? null,
    ],
  );
}

interface ItemSeed {
  cluster: string;
  source: string;
  title: string;
  published: number | null;
  seen: number;
  impact?: 'LOW' | 'MEDIUM' | 'HIGH';
  score?: number;
  topics?: string[];
  url?: string;
}

let itemCount = 0;
async function addItem(seed: ItemSeed): Promise<void> {
  itemCount += 1;
  await api.admin.query(
    `INSERT INTO news_items
       (id, source_key, url_hash, title, url, published_at, first_seen_at, topics, impact,
        impact_score, cluster_id, classifier_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, '1.0.0')`,
    [
      uuid(0x5000 + itemCount),
      seed.source,
      `hash-${String(itemCount)}`,
      seed.title,
      seed.url ?? `https://example.com/story-${String(itemCount)}`,
      seed.published === null ? null : new Date(seed.published),
      new Date(seed.seen),
      seed.topics ?? ['FED_RATES'],
      seed.impact ?? 'MEDIUM',
      seed.score ?? 0.5,
      seed.cluster,
    ],
  );
}

const events = async (query = '') => {
  const reply = await api.send({ url: `/api/v1/news/events${query}` });
  expect(reply.status, reply.body).toBe(200);
  return newsEventsResponseSchema.parse(reply.json());
};
const state = async () => {
  const reply = await api.send({ url: '/api/v1/news/state' });
  expect(reply.status, reply.body).toBe(200);
  return newsStateResponseSchema.parse(reply.json());
};
const headlines = async (query = '') => {
  const reply = await api.send({ url: `/api/v1/news/headlines${query}` });
  expect(reply.status, reply.body).toBe(200);
  return headlinesResponseSchema.parse(reply.json());
};
const moves = async (query = '') => {
  const reply = await api.send({ url: `/api/v1/news/moves${query}` });
  expect(reply.status, reply.body).toBe(200);
  return marketMovesResponseSchema.parse(reply.json());
};

// ------------------------------------------------------------------------------------ state

describe('GET /news/state on Postgres', () => {
  it('is UNKNOWN on an empty database, and never CLEAR', async () => {
    expect(await state()).toEqual({ state: 'UNKNOWN', next: null, last: null, sourceAgeS: null });
  });

  it('is CLEAR with the next and the last event, however far away they are, and ignores events that do not count', async () => {
    await beat(T0 - 30_500);
    await addEvent({
      id: uuid(1),
      at: T0 - 5 * DAY,
      name: 'Old NFP',
      unit: 'none',
      multiplier: 'thousands',
      actual: 150,
      forecast: 140,
      previous: 120,
      revised: 125,
    });
    await addEvent({ id: uuid(2), at: T0 + 5 * DAY, name: 'FOMC', unit: 'percent' });
    // a nearer event that does not open the window: medium, another currency, none
    await addEvent({ id: uuid(3), at: T0 + 10 * MIN, importance: 'medium' });
    await addEvent({ id: uuid(4), at: T0 + 10 * MIN, currency: 'EUR' });
    await addEvent({ id: uuid(5), at: T0 - 10 * MIN, currency: null });
    await addEvent({ id: uuid(6), at: T0 - 10 * MIN, importance: 'low' });
    expect(await state()).toEqual({
      state: 'CLEAR',
      next: {
        id: uuid(2),
        name: 'FOMC',
        scheduledAt: ISO(T0 + 5 * DAY),
        importance: 'high',
        currency: 'USD',
        unit: '%',
        actual: null,
        forecast: null,
        previous: null,
        revisedPrevious: null,
      },
      last: {
        id: uuid(1),
        name: 'Old NFP',
        scheduledAt: ISO(T0 - 5 * DAY),
        importance: 'high',
        currency: 'USD',
        unit: 'K',
        actual: 150,
        forecast: 140,
        previous: 120,
        revisedPrevious: 125,
      },
      sourceAgeS: 30,
    });
  });

  it('has the window 45 minutes before to 20 minutes after a high USD event, both ends included', async () => {
    await beat(T0 - 1000);
    const at = async (offsetMs: number) => {
      await api.admin.query('DELETE FROM macro_events');
      await addEvent({ id: uuid(1), at: T0 + offsetMs });
      return (await state()).state;
    };
    expect(await at(45 * MIN)).toBe('IN_WINDOW');
    expect(await at(45 * MIN + 1)).toBe('CLEAR');
    expect(await at(0)).toBe('IN_WINDOW');
    expect(await at(-20 * MIN)).toBe('IN_WINDOW');
    expect(await at(-20 * MIN - 1)).toBe('CLEAR');
  });

  it('is UNKNOWN once the last good reading of the calendar is more than 15 minutes old, whatever the events say', async () => {
    await addEvent({ id: uuid(1), at: T0 + 10 * MIN });
    await addEvent({ id: uuid(2), at: T0 - 3 * HOUR });
    await beat(T0 - 15 * MIN);
    expect((await state()).state).toBe('IN_WINDOW');
    await beat(T0 - 15 * MIN - 1);
    const stale = await state();
    expect(stale).toMatchObject({ state: 'UNKNOWN', next: null, sourceAgeS: 15 * 60 });
    expect(stale.last?.id).toBe(uuid(2));
    await beat(null);
    expect(await state()).toMatchObject({ state: 'UNKNOWN', sourceAgeS: null });
  });

  it('breaks ties by id: the smaller is next, the larger is last, and an event at exactly now is the last', async () => {
    await beat(T0 - 1000);
    await addEvent({ id: uuid(0x20), at: T0 + 3 * HOUR });
    await addEvent({ id: uuid(0x10), at: T0 + 3 * HOUR });
    await addEvent({ id: uuid(0x30), at: T0 - 3 * HOUR });
    await addEvent({ id: uuid(0x40), at: T0 - 3 * HOUR });
    expect(await state()).toMatchObject({
      state: 'CLEAR',
      next: { id: uuid(0x10) },
      last: { id: uuid(0x40) },
    });
    await addEvent({ id: uuid(0x01), at: T0 });
    expect(await state()).toMatchObject({
      state: 'IN_WINDOW',
      next: { id: uuid(0x10) },
      last: { id: uuid(0x01) },
    });
  });
});

// ------------------------------------------------------------------------------------ events

describe('GET /news/events on Postgres', () => {
  it('is empty on an empty database, with no age of the calendar', async () => {
    expect(await events()).toEqual({ items: [], sourceAgeS: null });
  });

  it('covers the 14 days before today to the 8 days after it: the first moment included, the last one not', async () => {
    const from = TODAY - 14 * DAY;
    const to = TODAY + 8 * DAY;
    await addEvent({ id: uuid(1), at: from - 1 });
    await addEvent({ id: uuid(2), at: from });
    await addEvent({ id: uuid(3), at: TODAY + 17 * HOUR });
    await addEvent({ id: uuid(4), at: to - 1 });
    await addEvent({ id: uuid(5), at: to });
    expect((await events()).items.map((event) => event.id)).toEqual([uuid(2), uuid(3), uuid(4)]);
    // the range follows the clock, one day later
    api.clock.now = T0 + DAY;
    expect((await events()).items.map((event) => event.id)).toEqual([uuid(3), uuid(4), uuid(5)]);
  });

  it('takes a range with from included and to excluded, and an empty range is empty', async () => {
    const t = TODAY - 3 * DAY;
    await addEvent({ id: uuid(1), at: t - 1 });
    await addEvent({ id: uuid(2), at: t });
    await addEvent({ id: uuid(3), at: t + 1 });
    await addEvent({ id: uuid(4), at: t + 2 });
    const ids = async (query: string) => (await events(query)).items.map((event) => event.id);
    expect(await ids(`?from=${ISO(t)}&to=${ISO(t + 2)}`)).toEqual([uuid(2), uuid(3)]);
    expect(await ids(`?from=${ISO(t)}&to=${ISO(t)}`)).toEqual([]);
    expect(await ids(`?from=${ISO(t + 1)}&to=${ISO(t + 2)}`)).toEqual([uuid(3)]);
    expect(await ids(`?from=${ISO(t - 1)}&to=${ISO(t)}`)).toEqual([uuid(1)]);
    // a range wider than the default reaches what the default does not
    await addEvent({ id: uuid(9), at: TODAY - 40 * DAY });
    expect(await ids(`?from=${ISO(TODAY - 41 * DAY)}&to=${ISO(t)}`)).toEqual([uuid(9), uuid(1)]);
  });

  it('lists oldest first, a tie by id, with every figure as a number', async () => {
    const t = TODAY - DAY;
    await addEvent({ id: uuid(0x30), at: t + HOUR, name: 'Third' });
    await addEvent({ id: uuid(0x20), at: t, name: 'Second B' });
    await addEvent({ id: uuid(0x10), at: t, name: 'Second A' });
    await addEvent({
      id: uuid(0x05),
      at: t - HOUR,
      name: 'First',
      importance: 'low',
      currency: null,
      unit: 'percent',
      actual: 0.3,
      forecast: 0.25,
      previous: 0.2,
      revised: 0.15,
    });
    const { items } = await events();
    expect(items.map((event) => event.name)).toEqual(['First', 'Second A', 'Second B', 'Third']);
    expect(items[0]).toMatchObject({
      importance: 'low',
      currency: null,
      unit: '%',
      actual: 0.3,
      forecast: 0.25,
      previous: 0.2,
      revisedPrevious: 0.15,
    });
    expect(items[1]).toMatchObject({
      unit: null,
      actual: null,
      forecast: null,
      previous: null,
      revisedPrevious: null,
      surpriseSigma: null,
      goldMoveAfter: null,
    });
  });

  it('limits to events of exactly one importance', async () => {
    const t = TODAY - DAY;
    await addEvent({ id: uuid(1), at: t, importance: 'low' });
    await addEvent({ id: uuid(2), at: t + 1, importance: 'medium' });
    await addEvent({ id: uuid(3), at: t + 2, importance: 'high' });
    await addEvent({ id: uuid(4), at: t + 3, importance: 'medium' });
    const ids = async (importance: string) =>
      (await events(`?importance=${importance}`)).items.map((event) => event.id);
    expect(await ids('low')).toEqual([uuid(1)]);
    expect(await ids('medium')).toEqual([uuid(2), uuid(4)]);
    expect(await ids('high')).toEqual([uuid(3)]);
    expect((await events()).items).toHaveLength(4);
  });

  it('gives the age of the last successful fetch from the heartbeat of the calendar only', async () => {
    await api.admin.query(
      `INSERT INTO worker_heartbeats (worker_name, heartbeat_at, metadata) VALUES ('worker', $1, '{}'::jsonb)`,
      [new Date(T0 - 1000)],
    );
    expect((await events()).sourceAgeS).toBeNull();
    await beat(T0 - 192 * MIN - 400);
    expect((await events()).sourceAgeS).toBe(192 * 60);
    await beat(T0 + 5000);
    expect((await events()).sourceAgeS).toBe(0);
  });

  describe('the surprise', () => {
    const series = 'mql5:cpi';
    const SIX = [0.1, -0.1, 0.2, 0, 0.1, -0.2];
    let past = 0;
    async function history(
      surprises: number[],
      raw: Record<string, unknown> = { eventId: series },
    ) {
      for (const surprise of surprises) {
        past += 1;
        await addEvent({
          id: uuid(0x1000 + past),
          at: TODAY - 100 * DAY - past * DAY,
          actual: 0.3 + surprise,
          forecast: 0.3,
          raw,
        });
      }
    }
    const sigmaOf = async (id: string) =>
      (await events(`?from=${ISO(TODAY - 2 * DAY)}`)).items.find((event) => event.id === id)
        ?.surpriseSigma;

    it('is the surprise over the standard deviation of the past releases of the series in the database', async () => {
      await history(SIX);
      await addEvent({
        id: uuid(1),
        at: TODAY - DAY,
        actual: 0.6,
        forecast: 0.3,
        raw: { eventId: series },
      });
      expect(await sigmaOf(uuid(1))).toBe(2.04);
      await api.admin.query('UPDATE macro_events SET actual = 0.1 WHERE id = $1', [uuid(1)]);
      expect(await sigmaOf(uuid(1))).toBe(-1.36);
      await api.admin.query('UPDATE macro_events SET actual = 0.3 WHERE id = $1', [uuid(1)]);
      expect(await sigmaOf(uuid(1))).toBe(0);
    });

    it('uses only releases before the event, of the same series, that have both figures, and needs six', async () => {
      await history(SIX.slice(1));
      await addEvent({
        id: uuid(1),
        at: TODAY - DAY,
        actual: 0.6,
        forecast: 0.3,
        raw: { eventId: series },
      });
      expect(await sigmaOf(uuid(1))).toBeNull();
      // another series, a release without a forecast, a later release: none of them counts
      await history([0.5], { eventId: 'mql5:other' });
      await addEvent({
        id: uuid(0x300),
        at: TODAY - 200 * DAY,
        actual: 0.9,
        forecast: null,
        raw: { eventId: series },
      });
      await addEvent({
        id: uuid(0x301),
        at: TODAY - 201 * DAY,
        actual: null,
        forecast: 0.3,
        raw: { eventId: series },
      });
      await addEvent({
        id: uuid(0x302),
        at: TODAY - DAY + 5,
        actual: 0.7,
        forecast: 0.3,
        raw: { eventId: series },
      });
      expect(await sigmaOf(uuid(1))).toBeNull();
      // the sixth past release makes it six
      await addEvent({
        id: uuid(0x303),
        at: TODAY - 300 * DAY,
        actual: 0.5,
        forecast: 0.3,
        raw: { eventId: series },
      });
      expect(await sigmaOf(uuid(1))).not.toBeNull();
    });

    it('is null before the release, without a forecast, without a series, and when the past never varied', async () => {
      await history(SIX);
      await addEvent({
        id: uuid(1),
        at: TODAY - DAY,
        actual: null,
        forecast: 0.3,
        raw: { eventId: series },
      });
      await addEvent({
        id: uuid(2),
        at: TODAY - DAY + 1,
        actual: 0.6,
        forecast: null,
        raw: { eventId: series },
      });
      await addEvent({ id: uuid(3), at: TODAY - DAY + 2, actual: 0.6, forecast: 0.3, raw: {} });
      expect(await sigmaOf(uuid(1))).toBeNull();
      expect(await sigmaOf(uuid(2))).toBeNull();
      expect(await sigmaOf(uuid(3))).toBeNull();
      await history([0.1, 0.1, 0.1, 0.1, 0.1, 0.1], { eventId: 'mql5:flat' });
      await addEvent({
        id: uuid(4),
        at: TODAY - DAY + 3,
        actual: 0.6,
        forecast: 0.3,
        raw: { eventId: 'mql5:flat' },
      });
      expect(await sigmaOf(uuid(4))).toBeNull();
      // an event that is not released has none even when the worker stored one
      await addEvent({
        id: uuid(5),
        at: TODAY - DAY + 4,
        actual: null,
        forecast: 0.3,
        raw: { eventId: series, surprise: { sigma: 3, n: 8, std: 0.1 } },
      });
      expect(await sigmaOf(uuid(5))).toBeNull();
    });

    it('uses the standard deviation the worker stored with the release, on the figures that stand now', async () => {
      await addEvent({
        id: uuid(1),
        at: TODAY - DAY,
        actual: 0.4,
        forecast: 0.3,
        raw: { eventId: series, surprise: { sigma: 99, n: 8, std: 0.05 } },
      });
      expect(await sigmaOf(uuid(1))).toBe(2);
    });

    it('takes the newest 60 past releases at most', async () => {
      const recent = Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? 0.1 : -0.1));
      await history(recent);
      // older than all of them, with surprises that would change the standard deviation a lot
      await history([5, -5, 5, -5, 5]);
      await addEvent({
        id: uuid(1),
        at: TODAY - DAY,
        actual: 0.5,
        forecast: 0.3,
        raw: { eventId: series },
      });
      const wanted = surpriseOf(
        0.5,
        0.3,
        recent.map((surprise) => ({ actual: 0.3 + surprise, forecast: 0.3 })),
      );
      expect(wanted?.n).toBe(60);
      expect(await sigmaOf(uuid(1))).toBe(Math.round((wanted?.sigma ?? NaN) * 100) / 100);
    });
  });

  describe('gold after the release', () => {
    const E = Date.UTC(2026, 9, 24, 12, 30);
    const moveOf = async (id = uuid(1)) =>
      (await events(`?from=${ISO(E - HOUR)}&to=${ISO(E + HOUR)}`)).items.find((e) => e.id === id)
        ?.goldMoveAfter;
    const released = (over: Partial<EventSeed> = {}) =>
      addEvent({ id: uuid(1), at: E, actual: 0.4, forecast: 0.3, ...over });

    it('is the move from the open of the first minute to the close of the fifth, in USD and in ATR(5m) before the event', async () => {
      await released();
      await addCandles([...flatFives(E), ...minutesFrom(E, 4000.1, 4004.6)]);
      expect(await moveOf()).toEqual({ usd: 4.5, atr: 4.5 });
    });

    it('is signed, and the ATR is the one of the 15 closed 5m candles before the time, not of later or open ones', async () => {
      await released();
      await addCandles([
        // 20 closed candles with a range of 2 end at E - 5 min; what comes after them is not read
        ...flatFives(E - 5 * MIN, 2),
        { at: E - 5 * MIN, o: 4000, c: 4000, tf: '5m', range: 40, complete: false },
        { at: E, o: 4000, c: 4000, tf: '5m', range: 40 },
        { at: E - 30 * MIN, o: 4000, c: 4000, tf: '15m', range: 40 },
        ...minutesFrom(E, 4010, 4000),
      ]);
      expect(await moveOf()).toEqual({ usd: -10, atr: -5 });
    });

    it('is null before the release and with a time that is only a date', async () => {
      await addCandles([...flatFives(E), ...minutesFrom(E, 4000, 4004)]);
      await released({ actual: null });
      expect(await moveOf()).toBeNull();
      await api.admin.query('DELETE FROM macro_events');
      await released({ raw: { timeMode: 'date' } });
      expect(await moveOf()).toBeNull();
      await api.admin.query('DELETE FROM macro_events');
      await released();
      expect(await moveOf()).toEqual({ usd: 4, atr: 4 });
    });

    it('waits until the five minutes are over', async () => {
      // clock at T0: an event 5 minutes ago is measurable, one 4 minutes ago is not, although its candles are there
      const done = T0 - 5 * MIN;
      const young = T0 - 4 * MIN;
      await addEvent({ id: uuid(1), at: done, actual: 1, forecast: 1 });
      await addEvent({ id: uuid(2), at: young, actual: 1, forecast: 1 });
      await addCandles([
        ...flatFives(done),
        // 1m candles from T0 - 5 min to T0: both events have all the candles they need, and a rise at the end
        ...[0, 1, 2, 3, 4, 5].map((k) => ({
          at: done + k * MIN,
          o: 4000,
          c: k >= 4 ? 4003 : 4000,
        })),
      ]);
      const { items } = await events(`?from=${ISO(done)}&to=${ISO(T0)}`);
      expect(items.map((event) => event.goldMoveAfter)).toEqual([{ usd: 3, atr: 3 }, null]);
    });

    it('is null when the candles are missing: the first or the fifth minute, an incomplete one, or too few 5m candles for the ATR', async () => {
      await released();
      const minutes = minutesFrom(E, 4000, 4004);
      await addCandles(flatFives(E));
      await addCandles(minutes.slice(1));
      expect(await moveOf()).toBeNull();
      await addCandles(minutes.slice(0, 1));
      expect(await moveOf()).toEqual({ usd: 4, atr: 4 });
      await api.admin.query(
        `UPDATE candles SET complete = false WHERE tf = '1m' AND open_time = $1`,
        [new Date(E + 4 * MIN)],
      );
      expect(await moveOf()).toBeNull();
      await api.admin.query(`UPDATE candles SET complete = true WHERE tf = '1m'`);
      await api.admin.query(
        `UPDATE candles SET complete = false WHERE tf = '1m' AND open_time = $1`,
        [new Date(E)],
      );
      expect(await moveOf()).toBeNull();
      await api.admin.query(`UPDATE candles SET complete = true WHERE tf = '1m'`);
      // 13 closed 5m candles are not enough for ATR(14); the 14th is
      await api.admin.query(`DELETE FROM candles WHERE tf = '5m' AND open_time < $1`, [
        new Date(E - 14 * 5 * MIN),
      ]);
      expect(await moveOf()).toEqual({ usd: 4, atr: 4 });
      await api.admin.query(`DELETE FROM candles WHERE tf = '5m' AND open_time = $1`, [
        new Date(E - 14 * 5 * MIN),
      ]);
      expect(await moveOf()).toBeNull();
    });

    it('does not read the candles of another symbol, and gives a move for each of several events', async () => {
      const second = E + 2 * HOUR;
      await released();
      await addEvent({ id: uuid(2), at: second, actual: 1, forecast: 1 });
      await addCandles([
        ...flatFives(E),
        ...minutesFrom(E, 4000, 4004),
        ...minutesFrom(E, 1, 2).map((candle) => ({ ...candle, symbol: 'DXY' })),
        // ranges of 4: ATR 4
        ...flatFives(second, 4),
        ...minutesFrom(second, 4010, 4008),
      ]);
      const { items } = await events(`?from=${ISO(E - HOUR)}&to=${ISO(E + 3 * HOUR)}`);
      expect(items.map((event) => event.goldMoveAfter)).toEqual([
        { usd: 4, atr: 4 },
        { usd: -2, atr: -0.5 },
      ]);
    });
  });
});

// ------------------------------------------------------------------------------------ headlines

describe('GET /news/headlines on Postgres', () => {
  it('is empty with no feed at all, and says so with no source', async () => {
    expect(await headlines()).toEqual({ items: [], nextCursor: null, sources: [] });
  });

  it('makes one story of the items of a cluster the way the worker does', async () => {
    await addSource('bbc_world', { name: 'BBC News' });
    await addSource('fed_press', { name: 'Federal Reserve' });
    await addSource('al_jazeera', { name: 'Al Jazeera' });
    const c = uuid(0xc1);
    await addItem({
      cluster: c,
      source: 'bbc_world',
      title: 'Fed seen on hold',
      published: T0 - 30 * MIN,
      seen: T0 - 29 * MIN,
      impact: 'MEDIUM',
      score: 0.5,
      topics: ['INFLATION_JOBS', 'FED_RATES'],
      url: 'https://example.com/bbc',
    });
    await addItem({
      cluster: c,
      source: 'fed_press',
      title: 'Federal Reserve issues FOMC statement',
      published: T0 - 31 * MIN,
      seen: T0 - 28 * MIN,
      impact: 'HIGH',
      score: 0.9,
      topics: ['FED_RATES', 'USD_DOLLAR'],
      url: 'https://example.com/fed',
    });
    await addItem({
      cluster: c,
      source: 'al_jazeera',
      title: 'Fed holds',
      published: null,
      seen: T0 - 20 * MIN,
      impact: 'LOW',
      score: 0.2,
      topics: ['RISK_OFF'],
    });
    const { items } = await headlines();
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      id: c,
      // the strongest item gives the title and the link
      title: 'Federal Reserve issues FOMC statement',
      url: 'https://example.com/fed',
      // the outlets in the order they were seen
      sources: [
        { key: 'bbc_world', name: 'BBC News' },
        { key: 'fed_press', name: 'Federal Reserve' },
        { key: 'al_jazeera', name: 'Al Jazeera' },
      ],
      publishedAt: ISO(T0 - 31 * MIN),
      firstSeenAt: ISO(T0 - 29 * MIN),
      delayS: 120,
      // the strongest item's topics first, then the others'
      topics: ['FED_RATES', 'USD_DOLLAR', 'INFLATION_JOBS', 'RISK_OFF'],
      impact: 'HIGH',
      goldMoveSincePublish: null,
    });
  });

  it('lists newest first by the time of the story: published, else first seen; a tie by id, the larger first', async () => {
    await addSource('a');
    const base = T0 - 3 * HOUR;
    await addItem({
      cluster: uuid(1),
      source: 'a',
      title: 'Oldest',
      published: base - HOUR,
      seen: base - HOUR + MIN,
    });
    // no published time: its time is when it was first seen, which puts it between the others
    await addItem({
      cluster: uuid(2),
      source: 'a',
      title: 'Unpublished',
      published: null,
      seen: base - 30 * MIN,
    });
    await addItem({
      cluster: uuid(4),
      source: 'a',
      title: 'Tie small id',
      published: base,
      seen: base + MIN,
    });
    await addItem({
      cluster: uuid(5),
      source: 'a',
      title: 'Tie large id',
      published: base,
      seen: base + 5 * MIN,
    });
    // published long before it was seen: it sits at its published time
    await addItem({
      cluster: uuid(3),
      source: 'a',
      title: 'Newest',
      published: base + HOUR,
      seen: base + 2 * HOUR,
    });
    const { items } = await headlines();
    expect(items.map((item) => item.title)).toEqual([
      'Newest',
      'Tie large id',
      'Tie small id',
      'Unpublished',
      'Oldest',
    ]);
    expect(items.find((item) => item.title === 'Unpublished')).toMatchObject({
      publishedAt: null,
      delayS: null,
    });
  });

  it('pages with a cursor that holds its place: no repeat, no gap, also across a tie, and a story that arrives later does not shift it', async () => {
    await addSource('a');
    const times = [10, 9, 9, 9, 8, 7, 7, 5, 4, 3, 2, 1];
    for (const [index, hours] of times.entries()) {
      const at = T0 - hours * HOUR;
      await addItem({
        cluster: uuid(index + 1),
        source: 'a',
        title: `Story ${String(index + 1)}`,
        published: at,
        seen: at + MIN,
      });
    }
    const everything = (await headlines('?limit=200')).items.map((item) => item.id);
    // newest first; the stories of one time (2, 3, 4 and 6, 7) by id, the larger first
    expect(everything).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(uuid));
    for (const limit of [1, 2, 3, 5, 11, 12]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const query = `?limit=${String(limit)}${cursor === null ? '' : `&cursor=${cursor}`}`;
        const answer = await headlines(query);
        expect(answer.items.length).toBeLessThanOrEqual(limit);
        seen.push(...answer.items.map((item) => item.id));
        cursor = answer.nextCursor;
        if (cursor === null) break;
      }
      expect(seen, `limit ${String(limit)}`).toEqual(everything);
    }
    // exactly one full page has no cursor; one story more has
    expect((await headlines('?limit=12')).nextCursor).toBeNull();
    expect((await headlines('?limit=11')).nextCursor).not.toBeNull();

    // stories that come after the first page was read, newer ones and an older one, leave the rest as it was
    const first = await headlines('?limit=4');
    await addItem({
      cluster: uuid(0x90),
      source: 'a',
      title: 'Late news',
      published: T0 - MIN,
      seen: T0,
    });
    await addItem({
      cluster: uuid(0x91),
      source: 'a',
      title: 'Late old',
      published: T0 - 20 * HOUR,
      seen: T0,
    });
    const rest = await headlines(`?limit=200&cursor=${first.nextCursor ?? ''}`);
    expect(rest.items.map((item) => item.id)).toEqual([...everything.slice(4), uuid(0x91)]);
  });

  it('refuses a cursor that is not its own with a 400', async () => {
    for (const cursor of [
      'h5',
      'x',
      'e30',
      Buffer.from('{"v":1,"t":1,"i":"nope"}').toString('base64url'),
    ]) {
      const reply = await api.send({ url: `/api/v1/news/headlines?cursor=${cursor}` });
      expect(reply.status, cursor).toBe(400);
      expect(problemSchema.parse(reply.json()).code).toBe('invalid_cursor');
    }
  });

  it('filters by topic on the whole story, and by the highest impact of the story', async () => {
    await addSource('a');
    await addSource('b');
    const at = T0 - 5 * HOUR;
    // the topic is only on the weaker item, the impact only on the stronger one
    await addItem({
      cluster: uuid(1),
      source: 'a',
      title: 'Mixed',
      published: at,
      seen: at,
      impact: 'HIGH',
      score: 0.9,
      topics: ['FED_RATES'],
    });
    await addItem({
      cluster: uuid(1),
      source: 'b',
      title: 'Mixed weak',
      published: at,
      seen: at + MIN,
      impact: 'LOW',
      score: 0.2,
      topics: ['RISK_OFF', 'USD_DOLLAR'],
    });
    await addItem({
      cluster: uuid(2),
      source: 'a',
      title: 'Medium',
      published: at + HOUR,
      seen: at + HOUR,
      impact: 'MEDIUM',
      topics: ['RISK_OFF'],
    });
    await addItem({
      cluster: uuid(3),
      source: 'a',
      title: 'Low',
      published: at + 2 * HOUR,
      seen: at + 2 * HOUR,
      impact: 'LOW',
      topics: ['GOLD_DIRECT'],
    });
    await addItem({
      cluster: uuid(3),
      source: 'b',
      title: 'Low and medium',
      published: at + 2 * HOUR,
      seen: at + 2 * HOUR + MIN,
      impact: 'MEDIUM',
      score: 0.1,
      topics: ['GOLD_DIRECT'],
    });
    const titles = async (query: string) =>
      (await headlines(query)).items.map((item) => item.title);
    expect(await titles('?topic=RISK_OFF')).toEqual(['Medium', 'Mixed']);
    expect(await titles('?topic=USD_DOLLAR')).toEqual(['Mixed']);
    expect(await titles('?topic=FED_RATES')).toEqual(['Mixed']);
    expect(await titles('?topic=GEOPOLITICS_WAR')).toEqual([]);
    expect(await titles('?minImpact=HIGH')).toEqual(['Mixed']);
    expect(await titles('?minImpact=MEDIUM')).toEqual(['Low', 'Medium', 'Mixed']);
    expect(await titles('?minImpact=LOW')).toEqual(['Low', 'Medium', 'Mixed']);
    expect(await titles('?minImpact=MEDIUM&topic=RISK_OFF')).toEqual(['Medium', 'Mixed']);
    expect(await titles('?minImpact=HIGH&topic=GOLD_DIRECT')).toEqual([]);
    // both filters together
    expect(await titles('?topic=RISK_OFF&minImpact=HIGH')).toEqual(['Mixed']);
    // the impact of the story shows the highest of its items
    const { items } = await headlines('?limit=200');
    expect(Object.fromEntries(items.map((item) => [item.title, item.impact]))).toEqual({
      Mixed: 'HIGH',
      Medium: 'MEDIUM',
      Low: 'MEDIUM',
    });
  });

  it('takes a range of the time of the story: from included, to excluded, the earliest published time deciding', async () => {
    await addSource('a');
    await addSource('b');
    const t = T0 - 10 * HOUR;
    await addItem({ cluster: uuid(1), source: 'a', title: 'At t', published: t, seen: t + MIN });
    // the story's time is the earliest published time of its items: t + 1 min, not t + 2 min
    await addItem({
      cluster: uuid(2),
      source: 'a',
      title: 'Two items',
      published: t + 2 * MIN,
      seen: t + 2 * MIN,
    });
    await addItem({
      cluster: uuid(2),
      source: 'b',
      title: 'Two items b',
      published: t + MIN,
      seen: t + 3 * MIN,
    });
    await addItem({
      cluster: uuid(3),
      source: 'a',
      title: 'Unpublished',
      published: null,
      seen: t + 5 * MIN,
    });
    const titles = async (query: string) =>
      (await headlines(query)).items.map((item) => item.title);
    expect(await titles(`?from=${ISO(t)}&to=${ISO(t + 5 * MIN)}`)).toEqual(['Two items', 'At t']);
    expect(await titles(`?from=${ISO(t + MIN)}&to=${ISO(t + 5 * MIN + 1)}`)).toEqual([
      'Unpublished',
      'Two items',
    ]);
    expect(await titles(`?from=${ISO(t + MIN + 1)}`)).toEqual(['Unpublished']);
    expect(await titles(`?to=${ISO(t + MIN)}`)).toEqual(['At t']);
    expect(await titles(`?from=${ISO(t)}&to=${ISO(t)}`)).toEqual([]);
  });

  describe('gold since publication', () => {
    const sample = (
      cluster: string,
      over: { atr5?: number; move10m?: number | null; at?: number } = {},
    ) =>
      api.admin.query(
        `INSERT INTO news_impact_samples
           (cluster_id, topics, impact, published_at, session, atr5, move_2m, move_5m, move_10m, max_abs_10m)
         VALUES ($1, '{FED_RATES}', 'HIGH', $2, 'LONDON', $3, 1, 1, $4, 3)`,
        [
          cluster,
          new Date(over.at ?? T0 - 2 * HOUR),
          over.atr5 ?? 1.25,
          over.move10m === undefined ? -2.5 : over.move10m,
        ],
      );
    const only = async (query = '') =>
      (await headlines(query)).items.map((item) => item.goldMoveSincePublish);

    it('is the move the worker measured, in ATR(5m) of the time, signed', async () => {
      await addSource('a');
      const at = T0 - 2 * HOUR;
      await addItem({
        cluster: uuid(1),
        source: 'a',
        title: 'Fall',
        published: at,
        seen: at + MIN,
      });
      await addItem({
        cluster: uuid(2),
        source: 'a',
        title: 'Rise',
        published: at - HOUR,
        seen: at - HOUR + MIN,
      });
      await addItem({
        cluster: uuid(3),
        source: 'a',
        title: 'Not measured',
        published: at - 2 * HOUR,
        seen: at - 2 * HOUR,
      });
      await sample(uuid(1), { atr5: 1.25, move10m: -2.5 });
      await sample(uuid(2), { atr5: 0.4, move10m: 1.2 });
      expect(await only()).toEqual([{ usd: -2.5, atr: -2 }, { usd: 1.2, atr: 3 }, null]);
    });

    it('is null for a sample without a move or without an ATR, and a story with no sample that is too old for a live reading', async () => {
      await addSource('a');
      const at = T0 - 2 * HOUR;
      await addItem({ cluster: uuid(1), source: 'a', title: 'No move', published: at, seen: at });
      await addItem({
        cluster: uuid(2),
        source: 'a',
        title: 'No atr',
        published: at - HOUR,
        seen: at - HOUR,
      });
      await addItem({
        cluster: uuid(3),
        source: 'a',
        title: 'Old',
        published: at - 2 * HOUR,
        seen: at - 2 * HOUR,
      });
      await sample(uuid(1), { move10m: null });
      await sample(uuid(2), { atr5: 0, move10m: 1 });
      // ticks and candles are there, but the story is 2 hours old and the worker did not measure it
      await addCandles(flatFives(at - 2 * HOUR));
      await api.admin.query(
        `INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES ($1, $1, 'XAUUSD', 4000, 4000.2), ($2, $2, 'XAUUSD', 4005, 4005.2)`,
        [new Date(at - 2 * HOUR - 5000), new Date(at - 2 * HOUR + 10 * MIN - 1000)],
      );
      expect(await only()).toEqual([null, null, null]);
    });

    it('is measured from the ticks for a story too young to have a sample, up to now', async () => {
      await addSource('a');
      const at = T0 - 3 * MIN;
      await addItem({
        cluster: uuid(1),
        source: 'a',
        title: 'Young',
        published: at,
        seen: at + 10_000,
      });
      await addCandles(flatFives(at, 2));
      await api.admin.query(
        `INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES
           ($1, $1, 'XAUUSD', 3999.9, 4000.1), ($2, $2, 'XAUUSD', 4001.9, 4002.1), ($3, $3, 'XAUUSD', 4100, 4100.2)`,
        [new Date(at - 5000), new Date(T0 - 10_000), new Date(T0 + 5000)],
      );
      // from 4000.0 to 4002.0 (the tick after now is not used), ATR(5m) 2
      expect(await only()).toEqual([{ usd: 2, atr: 1 }]);
    });

    it('is cut at the 10 minutes for a story whose sample is not there yet, and null without a tick near its time', async () => {
      await addSource('a');
      const at = T0 - 12 * MIN;
      await addItem({
        cluster: uuid(1),
        source: 'a',
        title: 'Ten minutes',
        published: at,
        seen: at + 1000,
      });
      await addItem({
        cluster: uuid(2),
        source: 'a',
        title: 'No ticks',
        published: at + MIN,
        seen: at + MIN,
      });
      await addCandles(flatFives(at - 5 * MIN, 1));
      await api.admin.query(
        `INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES
           ($1, $1, 'XAUUSD', 3999.9, 4000.1), ($2, $2, 'XAUUSD', 4003.9, 4004.1), ($3, $3, 'XAUUSD', 4020, 4020.2)`,
        [new Date(at - 2000), new Date(at + 10 * MIN - 5000), new Date(at + 11 * MIN)],
      );
      expect(await only()).toEqual([null, { usd: 4, atr: 4 }]);
    });

    it('reads only closed, complete 5m candles that ended before the story for the ATR of a live reading', async () => {
      await addSource('a');
      const at = T0 - 3 * MIN;
      await addItem({ cluster: uuid(1), source: 'a', title: 'Young', published: at, seen: at });
      await addCandles([
        ...flatFives(at - 5 * MIN, 2),
        // one that is not complete, and one that was still open when the story came
        { at: at - 5 * MIN, o: 4000, c: 4000, tf: '5m', range: 40, complete: false },
        { at: at - 2 * MIN, o: 4000, c: 4000, tf: '5m', range: 40 },
      ]);
      await api.admin.query(
        `INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES
           ($1, $1, 'XAUUSD', 3999.9, 4000.1), ($2, $2, 'XAUUSD', 4001.9, 4002.1)`,
        [new Date(at - 5000), new Date(T0 - 10_000)],
      );
      expect(await only()).toEqual([{ usd: 2, atr: 1 }]);
    });

    it('measures live only while the story is at most 15 minutes old', async () => {
      await addSource('a');
      const at = T0 - 15 * MIN;
      await addItem({ cluster: uuid(1), source: 'a', title: 'Fifteen', published: at, seen: at });
      await addItem({
        cluster: uuid(2),
        source: 'a',
        title: 'Just older',
        published: at - 1,
        seen: at - 1,
      });
      await addCandles(flatFives(at - 5 * MIN, 1));
      await api.admin.query(
        `INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES
           ($1, $1, 'XAUUSD', 3999.9, 4000.1), ($2, $2, 'XAUUSD', 4002.9, 4003.1)`,
        [new Date(at - 1000), new Date(at + 10 * MIN - 1000)],
      );
      expect(await only()).toEqual([{ usd: 3, atr: 3 }, null]);
    });

    it('is null for a story that is dated in the future', async () => {
      await addSource('a');
      const at = T0 + 5 * MIN;
      await addItem({ cluster: uuid(1), source: 'a', title: 'Ahead', published: at, seen: T0 });
      await addCandles(flatFives(at - 5 * MIN, 1));
      await api.admin.query(
        `INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES
           ($1, $1, 'XAUUSD', 3999.9, 4000.1), ($2, $2, 'XAUUSD', 4002.9, 4003.1)`,
        [new Date(T0 - 1000), new Date(T0 + 4000)],
      );
      const [headline] = (await headlines()).items;
      expect([headline?.goldMoveSincePublish, headline?.delayS]).toEqual([null, 0]);
    });
  });

  it('reports every feed as the worker left it: enabled, last good poll, last error', async () => {
    await addSource('bbc_world', { name: 'BBC News', okAt: T0 - MIN });
    await addSource('fed_press', {
      name: 'Federal Reserve',
      okAt: T0 - 3 * HOUR,
      error: 'HTTP 503',
    });
    await addSource('biquote_news', { name: 'Biquote news', enabled: false, okAt: T0 - 2 * DAY });
    await addSource('al_jazeera', { name: 'Al Jazeera' });
    await addSource('cnbc', { name: 'CNBC', okAt: T0 - 11 * MIN, error: '   ' });
    expect((await headlines()).sources).toEqual([
      { key: 'al_jazeera', name: 'Al Jazeera', enabled: true, lastOkAt: null, lastError: null },
      {
        key: 'bbc_world',
        name: 'BBC News',
        enabled: true,
        lastOkAt: ISO(T0 - MIN),
        lastError: null,
      },
      {
        key: 'biquote_news',
        name: 'Biquote news',
        enabled: false,
        lastOkAt: ISO(T0 - 2 * DAY),
        lastError: null,
      },
      {
        key: 'cnbc',
        name: 'CNBC',
        enabled: true,
        lastOkAt: ISO(T0 - 11 * MIN),
        lastError: 'Unknown error',
      },
      {
        key: 'fed_press',
        name: 'Federal Reserve',
        enabled: true,
        lastOkAt: ISO(T0 - 3 * HOUR),
        lastError: 'HTTP 503',
      },
    ]);
    // the same list of feeds on every answer, also on one with no story in it
    expect((await headlines('?topic=RISK_OFF')).sources).toHaveLength(5);
  });
});

// ------------------------------------------------------------------------------------ moves

describe('GET /news/moves on Postgres', () => {
  interface MoveSeed {
    at: number;
    kind?: 'SPIKE_UP' | 'SPIKE_DOWN';
    usd?: number;
    atr?: number;
    spread?: number | null;
    headlines?: unknown[];
    windowS?: number;
  }
  const addMove = (seed: MoveSeed) =>
    api.admin.query(
      `INSERT INTO market_events (kind, detected_at, window_s, move_usd, move_atr, spread, headlines)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        seed.kind ?? 'SPIKE_UP',
        new Date(seed.at),
        seed.windowS ?? 300,
        seed.usd ?? 9.8,
        seed.atr ?? 2.8,
        seed.spread === undefined ? 0.35 : seed.spread,
        JSON.stringify(seed.headlines ?? []),
      ],
    );
  const ids = async (query = '') => (await moves(query)).items.map((move) => move.id);

  it('is empty on an empty database', async () => {
    expect(await moves()).toEqual({ items: [] });
  });

  it('lists the moves newest first, a tie by id, as numbers, with the frozen headlines as stored', async () => {
    const frozen = [
      {
        title: 'Missile strike near a shipping lane',
        sources: ['BBC News', 'Al Jazeera'],
        publishedAt: ISO(T0 - 20 * MIN),
        impact: 'HIGH',
        topics: ['GEOPOLITICS_WAR'],
        url: 'https://example.com/a',
        classified: true,
      },
      {
        title: 'Council approves a harbour project',
        sources: ['BBC News'],
        publishedAt: null,
        impact: null,
        topics: [],
        url: 'https://example.com/b',
        classified: false,
      },
    ];
    await addMove({
      at: T0 - 5 * HOUR,
      kind: 'SPIKE_DOWN',
      usd: 7.25,
      atr: 2.1,
      spread: null,
      windowS: 60,
    });
    await addMove({ at: T0 - 2 * HOUR, headlines: frozen });
    await addMove({ at: T0 - 2 * HOUR, usd: 4.1, atr: 3.2 });
    await addMove({ at: T0 - HOUR });
    expect(await ids()).toEqual([4, 3, 2, 1]);
    const { items } = await moves();
    expect(items[2]).toEqual({
      id: 2,
      detectedAt: ISO(T0 - 2 * HOUR),
      kind: 'SPIKE_UP',
      windowS: 300,
      moveUsd: 9.8,
      moveAtr: 2.8,
      spread: 0.35,
      headlines: frozen,
    });
    expect(items[3]).toEqual({
      id: 1,
      detectedAt: ISO(T0 - 5 * HOUR),
      kind: 'SPIKE_DOWN',
      windowS: 60,
      moveUsd: 7.25,
      moveAtr: 2.1,
      spread: null,
      headlines: [],
    });
  });

  it('covers the last 30 days when there is no from: the first moment included', async () => {
    await addMove({ at: T0 - 30 * DAY - 1 });
    await addMove({ at: T0 - 30 * DAY });
    await addMove({ at: T0 - 29 * DAY });
    await addMove({ at: T0 + HOUR });
    expect(await ids()).toEqual([4, 3, 2]);
    api.clock.now = T0 + 1;
    expect(await ids()).toEqual([4, 3]);
    api.clock.now = T0;
    // an explicit from reaches further back
    expect(await ids(`?from=${ISO(T0 - 31 * DAY)}`)).toEqual([4, 3, 2, 1]);
  });

  it('takes a range with from included and to excluded, and a to alone keeps the 30 days', async () => {
    const t = T0 - 3 * DAY;
    await addMove({ at: t - 1 });
    await addMove({ at: t });
    await addMove({ at: t + 1 });
    await addMove({ at: t + 2 });
    expect(await ids(`?from=${ISO(t)}&to=${ISO(t + 2)}`)).toEqual([3, 2]);
    expect(await ids(`?from=${ISO(t)}&to=${ISO(t)}`)).toEqual([]);
    expect(await ids(`?to=${ISO(t + 1)}`)).toEqual([2, 1]);
    expect(await ids(`?from=${ISO(t + 1)}`)).toEqual([4, 3]);
  });
});

describe('the news routes with the rights of the api role', () => {
  it('need a session', async () => {
    for (const path of ['state', 'events', 'headlines', 'moves']) {
      const reply = await api.anonymous(`/api/v1/news/${path}`);
      expect(reply.status, path).toBe(401);
    }
  });

  it('reads every table it needs with SELECT and none that it could change', async () => {
    const { rows } = await api.admin.query<{ table_name: string; read: boolean; write: boolean }>(
      `SELECT t AS table_name,
              has_table_privilege('vmgs_api', t, 'SELECT') AS read,
              has_table_privilege('vmgs_api', t, 'INSERT')
                OR has_table_privilege('vmgs_api', t, 'UPDATE')
                OR has_table_privilege('vmgs_api', t, 'DELETE') AS write
         FROM unnest(ARRAY['macro_events', 'news_items', 'news_sources', 'market_events',
                           'news_impact_samples', 'candles', 'ticks', 'worker_heartbeats']) AS t`,
    );
    expect(rows).toHaveLength(8);
    expect(rows.filter((row) => !row.read)).toEqual([]);
    expect(rows.filter((row) => row.write)).toEqual([]);
  });

  it('answer every route without a permission error', async () => {
    for (const path of ['state', 'events', 'headlines', 'moves']) {
      expect((await api.send({ url: `/api/v1/news/${path}` })).status, path).toBe(200);
    }
  });
});
