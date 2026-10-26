import { describe, expect, it } from 'vitest';

import {
  headlinesResponseSchema,
  marketMovesResponseSchema,
  newsEventsResponseSchema,
  newsStateResponseSchema,
  problemSchema,
  type CalendarEvent,
  type MarketMove,
} from '@vmgs/contracts';
import type { HeadlineCluster, StatCandle, TickPoint } from '@vmgs/core';

import { ProblemError } from '../http/problem';
import { makeHarness, T0, type Clock } from '../testing/harness';
import {
  NEWS_WINDOW,
  calendarEventOf,
  canMeasureMove,
  decodeCursor,
  deriveNewsState,
  encodeCursor,
  eventsRange,
  goldMoveAfterOf,
  headlineOf,
  liveMove,
  macroEventOf,
  movesFrom,
  roundTo,
  sampleMove,
  signedAtr,
  sourceAgeS,
  surpriseSigmaOf,
  unitText,
  type EventsFacts,
  type EventsRead,
  type HeadlinesFacts,
  type HeadlinesRead,
  type MovesRead,
  type NewsReader,
  type StateFacts,
  type StoredEvent,
} from './reader';
import { registerNewsRoutes } from './routes';

const MIN = 60_000;
const DAY = 86_400_000;
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const stored = (over: Partial<StoredEvent> = {}): StoredEvent => ({
  id: uuid(1),
  name: 'US CPI m/m',
  scheduledAt: T0 + 30 * MIN,
  importance: 'high',
  currency: 'USD',
  unit: '%',
  actual: null,
  forecast: 0.3,
  previous: 0.4,
  revisedPrevious: null,
  seriesId: 'mql5:1',
  timeMode: 'exact',
  surprise: null,
  ...over,
});

const cluster = (over: Partial<HeadlineCluster> = {}): HeadlineCluster => ({
  id: uuid(0x100),
  title: 'Fed holds rates steady',
  url: 'https://example.com/fed',
  sources: [{ key: 'bbc_world', name: 'BBC News' }],
  topics: ['FED_RATES'],
  impact: 'HIGH',
  publishedAt: T0 - 5 * MIN,
  firstSeenAt: T0 - 4 * MIN,
  ...over,
});

const move = (over: Partial<MarketMove> = {}): MarketMove => ({
  id: 7,
  detectedAt: new Date(T0 - 3 * MIN).toISOString(),
  kind: 'SPIKE_UP',
  windowS: 300,
  moveUsd: 9.8,
  moveAtr: 2.8,
  spread: 0.35,
  headlines: [],
  ...over,
});

class FakeReader implements NewsReader {
  state: StateFacts = { events: [], calendarOkAt: null };
  events_: EventsFacts = { items: [], calendarOkAt: null };
  headlines_: HeadlinesFacts = { items: [], next: null, sources: [] };
  moves_: MarketMove[] = [];
  failure: Error | null = null;
  stateCalls: number[] = [];
  eventCalls: EventsRead[] = [];
  headlineCalls: HeadlinesRead[] = [];
  moveCalls: MovesRead[] = [];

  private check(): void {
    if (this.failure !== null) throw this.failure;
  }
  stateFacts(now: number): Promise<StateFacts> {
    this.stateCalls.push(now);
    this.check();
    return Promise.resolve(this.state);
  }
  events(read: EventsRead): Promise<EventsFacts> {
    this.eventCalls.push(read);
    this.check();
    return Promise.resolve(this.events_);
  }
  headlines(read: HeadlinesRead): Promise<HeadlinesFacts> {
    this.headlineCalls.push(read);
    this.check();
    return Promise.resolve(this.headlines_);
  }
  moves(read: MovesRead): Promise<MarketMove[]> {
    this.moveCalls.push(read);
    this.check();
    return Promise.resolve(this.moves_);
  }
}

async function harness(reader: FakeReader) {
  let clock: Clock | null = null;
  const h = await makeHarness({
    routes: (app, c) => {
      clock = c;
      registerNewsRoutes(app, { reader, now: () => c.now });
    },
  });
  const cookie = await h.login();
  return { h, cookie, clock: clock as unknown as Clock };
}

const ISO = (ms: number): string => new Date(ms).toISOString();

describe('the news routes', () => {
  const urls = [
    '/api/v1/news/state',
    '/api/v1/news/events',
    '/api/v1/news/headlines',
    '/api/v1/news/moves',
  ];

  it('need a session: no cookie is a 401 and the reader is never asked', async () => {
    const reader = new FakeReader();
    const { h } = await harness(reader);
    for (const url of urls) {
      const reply = await h.send({ url });
      expect(reply.status, url).toBe(401);
      expect(problemSchema.parse(reply.json()).code).toBe('unauthenticated');
    }
    expect(reader.stateCalls.length + reader.eventCalls.length).toBe(0);
    expect(reader.headlineCalls.length + reader.moveCalls.length).toBe(0);
  });

  it('answer with no-store and show nothing of a failure of the database', async () => {
    const reader = new FakeReader();
    reader.failure = new Error(
      'password authentication failed for user "vmgs_api" in SELECT raw FROM macro_events',
    );
    const { h, cookie } = await harness(reader);
    for (const url of urls) {
      const reply = await h.send({ url, cookie });
      expect(reply.status, url).toBe(500);
      expect(problemSchema.parse(reply.json()).code).toBe('server_error');
      expect(reply.res.body).not.toMatch(/password|macro_events|vmgs_api|SELECT/);
      expect(reply.res.headers['cache-control']).toBe('no-store');
    }
  });

  describe('GET /news/state', () => {
    it('answers the state of the core with the next and the last event and the age of the calendar', async () => {
      const reader = new FakeReader();
      const { h, cookie, clock } = await harness(reader);
      reader.state = {
        events: [
          stored({ id: uuid(2), scheduledAt: clock.now - 5 * MIN, actual: 0.4 }),
          stored({ id: uuid(3), scheduledAt: clock.now + 30 * MIN }),
        ],
        calendarOkAt: clock.now - 45_500,
      };
      const reply = await h.send({ url: '/api/v1/news/state', cookie });
      expect(reply.status).toBe(200);
      const body = newsStateResponseSchema.parse(reply.json());
      expect(body.state).toBe('IN_WINDOW');
      expect(body.next?.id).toBe(uuid(3));
      expect(body.last).toMatchObject({ id: uuid(2), actual: 0.4 });
      expect(body.sourceAgeS).toBe(45);
      expect(reader.stateCalls).toEqual([clock.now]);
    });

    it('is UNKNOWN with no calendar reading at all, and the age is null', async () => {
      const reader = new FakeReader();
      const { h, cookie } = await harness(reader);
      const body = newsStateResponseSchema.parse(
        (await h.send({ url: '/api/v1/news/state', cookie })).json(),
      );
      expect(body).toEqual({ state: 'UNKNOWN', next: null, last: null, sourceAgeS: null });
    });

    it('takes no query', async () => {
      const { h, cookie } = await harness(new FakeReader());
      const reply = await h.send({ url: '/api/v1/news/state?from=2026-10-01T00:00:00Z', cookie });
      expect(reply.status).toBe(400);
      expect(problemSchema.parse(reply.json()).code).toBe('invalid_request');
    });
  });

  describe('GET /news/events', () => {
    it('asks for the 14 days before today to the 8 days after it when no range is given', async () => {
      const reader = new FakeReader();
      const { h, cookie, clock } = await harness(reader);
      const reply = await h.send({ url: '/api/v1/news/events', cookie });
      expect(reply.status).toBe(200);
      expect(newsEventsResponseSchema.parse(reply.json())).toEqual({ items: [], sourceAgeS: null });
      expect(reader.eventCalls).toEqual([
        {
          from: Date.UTC(2026, 9, 12),
          to: Date.UTC(2026, 10, 3),
          importance: null,
          now: clock.now,
        },
      ]);
    });

    it('passes a range and an importance, and gives the age of the last fetch', async () => {
      const reader = new FakeReader();
      const { h, cookie, clock } = await harness(reader);
      const event: CalendarEvent = calendarEventOf(
        stored({ actual: 0.4, scheduledAt: T0 - 2 * DAY }),
        1.8,
        { usd: -7.3, atr: -1.6 },
      );
      reader.events_ = { items: [event], calendarOkAt: clock.now - 192 * 60_000 - 400 };
      const reply = await h.send({
        url: '/api/v1/news/events?from=2026-10-01T00:00:00Z&to=2026-10-20T12:30:00.500Z&importance=high',
        cookie,
      });
      expect(reply.status).toBe(200);
      expect(newsEventsResponseSchema.parse(reply.json())).toEqual({
        items: [event],
        sourceAgeS: 192 * 60,
      });
      expect(reader.eventCalls[0]).toEqual({
        from: Date.UTC(2026, 9, 1),
        to: Date.UTC(2026, 9, 20, 12, 30, 0, 500),
        importance: 'high',
        now: clock.now,
      });
    });

    it('fills in only the bound that is missing', async () => {
      const reader = new FakeReader();
      const { h, cookie } = await harness(reader);
      await h.send({ url: '/api/v1/news/events?from=2026-10-26T00:00:00Z', cookie });
      await h.send({ url: '/api/v1/news/events?to=2026-10-26T00:00:00Z', cookie });
      expect(reader.eventCalls.map(({ from, to }) => [ISO(from), ISO(to)])).toEqual([
        ['2026-10-26T00:00:00.000Z', '2026-11-03T00:00:00.000Z'],
        ['2026-10-12T00:00:00.000Z', '2026-10-26T00:00:00.000Z'],
      ]);
    });

    it('refuses what the contract refuses', async () => {
      const reader = new FakeReader();
      const { h, cookie } = await harness(reader);
      for (const query of [
        'importance=critical',
        'importance=High',
        'from=yesterday',
        'from=2026-10-26',
        'from=2026-10-26T00:00:00%2B05:30',
        'to=1',
        'from=2026-10-27T00:00:00Z&to=2026-10-26T00:00:00Z',
        'limit=10',
        'cursor=abc',
        'importance=low&importance=high',
      ]) {
        const reply = await h.send({ url: `/api/v1/news/events?${query}`, cookie });
        expect(reply.status, query).toBe(400);
        expect(problemSchema.parse(reply.json()).code, query).toBe('invalid_request');
      }
      expect(reader.eventCalls).toEqual([]);
      // an empty range is a valid, empty one
      const same = '2026-10-26T00:00:00Z';
      expect(
        (await h.send({ url: `/api/v1/news/events?from=${same}&to=${same}`, cookie })).status,
      ).toBe(200);
    });
  });

  describe('GET /news/headlines', () => {
    const items = [
      headlineOf(cluster(), { usd: 1.2, atr: 0.3 }),
      headlineOf(cluster({ id: uuid(0x101), publishedAt: null, topics: ['RISK_OFF'] }), null),
    ];
    const sources = [
      {
        key: 'bbc_world',
        name: 'BBC News',
        enabled: true,
        lastOkAt: ISO(T0 - MIN),
        lastError: null,
      },
    ];

    it('answers a page with the contract, the default page size and no range', async () => {
      const reader = new FakeReader();
      reader.headlines_ = { items, next: null, sources };
      const { h, cookie, clock } = await harness(reader);
      const reply = await h.send({ url: '/api/v1/news/headlines', cookie });
      expect(reply.status).toBe(200);
      expect(headlinesResponseSchema.parse(reply.json())).toEqual({
        items,
        nextCursor: null,
        sources,
      });
      expect(reader.headlineCalls).toEqual([
        {
          from: null,
          to: null,
          minImpact: null,
          topic: null,
          limit: 50,
          after: null,
          now: clock.now,
        },
      ]);
    });

    it('passes the filters, and a cursor of its own comes back as the position it was made from', async () => {
      const reader = new FakeReader();
      const position = { at: T0 - 5 * MIN, id: uuid(0x100) };
      reader.headlines_ = { items: items.slice(0, 1), next: position, sources };
      const { h, cookie } = await harness(reader);
      const first = headlinesResponseSchema.parse(
        (
          await h.send({
            url: '/api/v1/news/headlines?limit=1&minImpact=MEDIUM&topic=FED_RATES&from=2026-10-25T00:00:00Z&to=2026-10-27T00:00:00Z',
            cookie,
          })
        ).json(),
      );
      expect(first.nextCursor).toBe(encodeCursor(position));
      expect(reader.headlineCalls[0]).toMatchObject({
        from: Date.UTC(2026, 9, 25),
        to: Date.UTC(2026, 9, 27),
        minImpact: 'MEDIUM',
        topic: 'FED_RATES',
        limit: 1,
      });
      reader.headlines_ = { items: items.slice(1), next: null, sources };
      const second = await h.send({
        url: `/api/v1/news/headlines?limit=1&cursor=${first.nextCursor ?? ''}`,
        cookie,
      });
      expect(headlinesResponseSchema.parse(second.json()).nextCursor).toBeNull();
      expect(reader.headlineCalls[1]?.after).toEqual(position);
    });

    it('refuses a cursor that is not its own, and the values the contract refuses', async () => {
      const reader = new FakeReader();
      const { h, cookie } = await harness(reader);
      const forged = Buffer.from(JSON.stringify({ v: 1, t: 1, i: 'not-an-id' })).toString(
        'base64url',
      );
      for (const query of [
        'cursor=h5',
        'cursor=%25%25',
        `cursor=${forged}`,
        'limit=0',
        'limit=201',
        'limit=abc',
        'limit=1.5',
        'minImpact=URGENT',
        'minImpact=high',
        'topic=SPORT',
        'topic=fed_rates',
        'from=2026-10-27T00:00:00Z&to=2026-10-26T00:00:00Z',
        'sort=asc',
      ]) {
        const reply = await h.send({ url: `/api/v1/news/headlines?${query}`, cookie });
        expect(reply.status, query).toBe(400);
        const code = query.startsWith('cursor=') ? 'invalid_cursor' : 'invalid_request';
        expect(problemSchema.parse(reply.json()).code, query).toBe(code);
      }
      expect(reader.headlineCalls).toEqual([]);
      expect((await h.send({ url: '/api/v1/news/headlines?limit=200', cookie })).status).toBe(200);
      expect((await h.send({ url: '/api/v1/news/headlines?limit=1', cookie })).status).toBe(200);
    });
  });

  describe('GET /news/moves', () => {
    it('asks for the last 30 days when there is no from, and no upper limit', async () => {
      const reader = new FakeReader();
      const moves = [move(), move({ id: 6, spread: null, headlines: [] })];
      reader.moves_ = moves;
      const { h, cookie, clock } = await harness(reader);
      const reply = await h.send({ url: '/api/v1/news/moves', cookie });
      expect(reply.status).toBe(200);
      expect(marketMovesResponseSchema.parse(reply.json())).toEqual({ items: moves });
      expect(reader.moveCalls).toEqual([{ from: clock.now - 30 * DAY, to: null }]);
    });

    it('passes a range, and refuses the wrong ones', async () => {
      const reader = new FakeReader();
      const { h, cookie } = await harness(reader);
      expect(
        (
          await h.send({
            url: '/api/v1/news/moves?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z',
            cookie,
          })
        ).status,
      ).toBe(200);
      expect(reader.moveCalls).toEqual([{ from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 9, 1) }]);
      for (const query of [
        'from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z',
        'from=nope',
        'limit=5',
        'kind=SPIKE_UP',
      ]) {
        const reply = await h.send({ url: `/api/v1/news/moves?${query}`, cookie });
        expect(reply.status, query).toBe(400);
      }
      expect(reader.moveCalls).toHaveLength(1);
    });
  });
});

describe('deriveNewsState', () => {
  const NOW = T0;
  const facts = (events: StoredEvent[], okAt: number | null = NOW - 30_000): StateFacts => ({
    events,
    calendarOkAt: okAt,
  });

  it('has a window of 45 minutes before to 20 minutes after a high USD event, both ends included', () => {
    expect(NEWS_WINDOW).toMatchObject({
      before: 45,
      after: 20,
      impact: ['high'],
      currency: ['USD'],
    });
    const state = (at: number) => deriveNewsState(facts([stored({ scheduledAt: at })]), NOW).state;
    expect(state(NOW + 45 * MIN)).toBe('IN_WINDOW');
    expect(state(NOW + 45 * MIN + 1)).toBe('CLEAR');
    expect(state(NOW)).toBe('IN_WINDOW');
    expect(state(NOW - 20 * MIN)).toBe('IN_WINDOW');
    expect(state(NOW - 20 * MIN - 1)).toBe('CLEAR');
  });

  it('gives the next event after now and the last one at or before it', () => {
    const before = stored({ id: uuid(5), scheduledAt: NOW - 3 * 60 * MIN });
    const at = stored({ id: uuid(6), scheduledAt: NOW });
    const after = stored({ id: uuid(7), scheduledAt: NOW + 3 * 60 * MIN });
    const state = deriveNewsState(facts([before, at, after]), NOW);
    expect(state.last?.id).toBe(uuid(6));
    expect(state.next?.id).toBe(uuid(7));
    expect(state.state).toBe('IN_WINDOW');
    const quiet = deriveNewsState(facts([before, after]), NOW);
    expect(quiet).toMatchObject({ state: 'CLEAR', last: { id: uuid(5) }, next: { id: uuid(7) } });
  });

  it('breaks a tie of two events at one time by id: the smaller is next, the larger is last', () => {
    const a = stored({ id: uuid(9), scheduledAt: NOW + 3 * 60 * MIN });
    const b = stored({ id: uuid(8), scheduledAt: NOW + 3 * 60 * MIN });
    expect(deriveNewsState(facts([a, b]), NOW).next?.id).toBe(uuid(8));
    expect(deriveNewsState(facts([b, a]), NOW).next?.id).toBe(uuid(8));
    const c = stored({ id: uuid(9), scheduledAt: NOW - 3 * 60 * MIN });
    const d = stored({ id: uuid(8), scheduledAt: NOW - 3 * 60 * MIN });
    expect(deriveNewsState(facts([c, d]), NOW).last?.id).toBe(uuid(9));
  });

  it('counts only the impact and the currency of the window', () => {
    const near = NOW + 10 * MIN;
    const others = [
      stored({ id: uuid(2), importance: 'medium', scheduledAt: near }),
      stored({ id: uuid(3), importance: 'low', scheduledAt: near }),
      stored({ id: uuid(4), currency: 'EUR', scheduledAt: near }),
      stored({ id: uuid(5), currency: null, scheduledAt: near }),
    ];
    expect(deriveNewsState(facts(others), NOW)).toMatchObject({
      state: 'CLEAR',
      next: null,
      last: null,
    });
  });

  it('is UNKNOWN when the calendar was not read for more than 15 minutes, never CLEAR, and gives no next event', () => {
    const events = [
      stored({ id: uuid(2), scheduledAt: NOW - 3 * 60 * MIN, actual: 0.1 }),
      stored({ id: uuid(3), scheduledAt: NOW + 3 * 60 * MIN }),
    ];
    expect(deriveNewsState(facts(events, NOW - 15 * MIN), NOW).state).toBe('CLEAR');
    const stale = deriveNewsState(facts(events, NOW - 15 * MIN - 1), NOW);
    expect(stale.state).toBe('UNKNOWN');
    expect(stale.next).toBeNull();
    expect(stale.last?.id).toBe(uuid(2));
    expect(stale.sourceAgeS).toBe(15 * 60);
    const never = deriveNewsState(facts(events, null), NOW);
    expect([never.state, never.sourceAgeS]).toEqual(['UNKNOWN', null]);
    // an event in the window does not turn a stale calendar into a known state
    const inside = [stored({ scheduledAt: NOW + 10 * MIN })];
    expect(deriveNewsState(facts(inside, null), NOW).state).toBe('UNKNOWN');
  });

  it('answers the events in the shape of the contract', () => {
    const event = stored({ id: uuid(2), scheduledAt: NOW + 10 * MIN, unit: 'K', previous: 142 });
    const { next } = deriveNewsState(facts([event]), NOW);
    expect(next).toEqual(macroEventOf(event));
    expect(next).toEqual({
      id: uuid(2),
      name: 'US CPI m/m',
      scheduledAt: ISO(NOW + 10 * MIN),
      importance: 'high',
      currency: 'USD',
      unit: 'K',
      actual: null,
      forecast: 0.3,
      previous: 142,
      revisedPrevious: null,
    });
  });
});

describe('the calendar helpers', () => {
  it('takes today as the UTC day of now for the default range', () => {
    const range = (now: number) => {
      const { from, to } = eventsRange({}, now);
      return [ISO(from), ISO(to)];
    };
    expect(range(Date.UTC(2026, 9, 26, 6))).toEqual([
      '2026-10-12T00:00:00.000Z',
      '2026-11-03T00:00:00.000Z',
    ]);
    expect(range(Date.UTC(2026, 9, 26, 23, 59, 59, 999))).toEqual(range(Date.UTC(2026, 9, 26, 0)));
    expect(range(Date.UTC(2026, 9, 27))[0]).toBe('2026-10-13T00:00:00.000Z');
    expect(eventsRange({ from: '2026-01-01T00:00:00Z' }, T0).from).toBe(Date.UTC(2026, 0, 1));
    expect(movesFrom(T0)).toBe(T0 - 30 * DAY);
  });

  it('writes the unit the way the alerts do', () => {
    expect(unitText('percent', 'none')).toBe('%');
    expect(unitText('percent', null)).toBe('%');
    expect(unitText('percent', 'thousands')).toBe('%');
    expect(unitText('none', 'thousands')).toBe('K');
    expect(unitText('none', 'millions')).toBe('M');
    expect(unitText(null, 'billions')).toBe('B');
    expect(unitText('none', 'trillions')).toBe('T');
    expect(unitText('none', 'none')).toBeNull();
    expect(unitText(null, null)).toBeNull();
    expect(unitText('currency', 'weird')).toBeNull();
  });

  it('gives the age of the calendar in whole seconds, never negative', () => {
    expect(sourceAgeS(null, T0)).toBeNull();
    expect(sourceAgeS(T0 - 45_999, T0)).toBe(45);
    expect(sourceAgeS(T0, T0)).toBe(0);
    expect(sourceAgeS(T0 + 5000, T0)).toBe(0);
  });

  it('rounds half away from zero and never gives -0', () => {
    expect(roundTo(2.5, 0)).toBe(3);
    expect(roundTo(-2.5, 0)).toBe(-3);
    expect(roundTo(1.2349, 3)).toBe(1.235);
    expect(Object.is(roundTo(-0.0004, 3), 0)).toBe(true);
    expect(signedAtr(-3.3, 1.1)).toBe(-3);
    expect(signedAtr(2.5, 1)).toBe(2.5);
    expect(signedAtr(1, null)).toBeNull();
    expect(signedAtr(1, 0)).toBeNull();
    expect(signedAtr(1, -2)).toBeNull();
  });

  it('keeps the surprise and the move after of an event that is not released at null', () => {
    const open = calendarEventOf(stored({ actual: null }), 2.1, { usd: 1, atr: 1 });
    expect([open.surpriseSigma, open.goldMoveAfter]).toEqual([null, null]);
    const done = calendarEventOf(stored({ actual: 0.4 }), 2.1, { usd: 1, atr: 1 });
    expect([done.surpriseSigma, done.goldMoveAfter]).toEqual([2.1, { usd: 1, atr: 1 }]);
    const unmeasured = calendarEventOf(stored({ actual: 0.4 }), null, null);
    expect([unmeasured.surpriseSigma, unmeasured.goldMoveAfter]).toEqual([null, null]);
  });
});

describe('surpriseSigmaOf', () => {
  const past = (surprises: number[]) =>
    surprises.map((surprise) => ({ forecast: 0.3, actual: 0.3 + surprise }));
  const SIX = [0.1, -0.1, 0.2, 0, 0.1, -0.2];

  it('is the surprise over the standard deviation of at least six past ones of the series', () => {
    // mean 0.01667, sample standard deviation 0.1472: (0.4 - 0.3) / 0.1472
    expect(surpriseSigmaOf({ actual: 0.6, forecast: 0.3, surprise: null }, past(SIX))).toBe(2.04);
    expect(surpriseSigmaOf({ actual: 0.1, forecast: 0.3, surprise: null }, past(SIX))).toBe(-1.36);
    expect(surpriseSigmaOf({ actual: 0.3, forecast: 0.3, surprise: null }, past(SIX))).toBe(0);
    expect(
      surpriseSigmaOf({ actual: 0.6, forecast: 0.3, surprise: null }, past(SIX.slice(1))),
    ).toBeNull();
  });

  it('is null without an actual or a forecast, and when the past surprises never varied', () => {
    expect(surpriseSigmaOf({ actual: null, forecast: 0.3, surprise: null }, past(SIX))).toBeNull();
    expect(surpriseSigmaOf({ actual: 0.4, forecast: null, surprise: null }, past(SIX))).toBeNull();
    expect(
      surpriseSigmaOf(
        { actual: 0.4, forecast: 0.3, surprise: null },
        past([0.1, 0.1, 0.1, 0.1, 0.1, 0.1]),
      ),
    ).toBeNull();
  });

  it('uses the standard deviation the worker kept, on the figures as they stand, before the archive', () => {
    const kept = { sigma: 9, n: 8, std: 0.05 };
    expect(surpriseSigmaOf({ actual: 0.4, forecast: 0.3, surprise: kept }, [])).toBe(2);
    // the actual was revised after the alert: the old sigma is not shown
    expect(surpriseSigmaOf({ actual: 0.2, forecast: 0.3, surprise: kept }, [])).toBe(-2);
    // a kept value that cannot be used falls back to the archive
    for (const bad of [
      { std: 0 },
      { std: 1e-12 },
      { std: -1 },
      { std: 'x' },
      { std: null },
      'text',
      5,
      [],
      null,
    ]) {
      expect(
        surpriseSigmaOf({ actual: 0.6, forecast: 0.3, surprise: bad }, past(SIX)),
        JSON.stringify(bad),
      ).toBe(2.04);
      expect(surpriseSigmaOf({ actual: 0.6, forecast: 0.3, surprise: bad }, [])).toBeNull();
    }
  });
});

describe('gold after a release', () => {
  const at = Date.UTC(2026, 9, 20, 12, 30);
  const bar = (minute: number, o: number, c: number): StatCandle => ({
    openTime: at + minute * MIN,
    o,
    h: Math.max(o, c) + 1,
    l: Math.min(o, c) - 1,
    c,
  });
  const window = [
    bar(0, 4000.1, 4001),
    bar(1, 4001, 4002),
    bar(2, 4002, 4001),
    bar(3, 4001, 4004),
    bar(4, 4004, 4003.4),
  ];

  it('is the open of the first minute to the close of the fifth, in USD and in ATR(5m)', () => {
    expect(goldMoveAfterOf(at, window, 1.1)).toEqual({ usd: 3.3, atr: 3 });
    expect(goldMoveAfterOf(at, [bar(0, 4010, 4009), bar(4, 4003, 4000)], 2)).toEqual({
      usd: -10,
      atr: -5,
    });
    expect(goldMoveAfterOf(at, [bar(0, 4000, 4001), bar(4, 4000, 4000)], 1)).toEqual({
      usd: 0,
      atr: 0,
    });
  });

  it('needs the first and the fifth minute, and a known ATR; a minute after the window is not used', () => {
    expect(goldMoveAfterOf(at, window.slice(1), 1)).toBeNull();
    expect(goldMoveAfterOf(at, window.slice(0, 4), 1)).toBeNull();
    expect(goldMoveAfterOf(at, [bar(0, 1, 1), bar(5, 1, 9)], 1)).toBeNull();
    expect(goldMoveAfterOf(at, [], 1)).toBeNull();
    expect(goldMoveAfterOf(at, window, null)).toBeNull();
    expect(goldMoveAfterOf(at, window, 0)).toBeNull();
  });

  it('is measured only for a released event with a time of the day, on a whole minute, once the five minutes are over', () => {
    const event = stored({ actual: 0.4, scheduledAt: at });
    const done = at + 5 * MIN;
    expect(canMeasureMove(event, done)).toBe(true);
    expect(canMeasureMove(event, done - 1)).toBe(false);
    expect(canMeasureMove({ ...event, actual: null }, done)).toBe(false);
    expect(canMeasureMove({ ...event, timeMode: 'date' }, done)).toBe(false);
    expect(canMeasureMove({ ...event, timeMode: 'tentative' }, done)).toBe(true);
    expect(canMeasureMove({ ...event, timeMode: null }, done)).toBe(true);
    expect(canMeasureMove({ ...event, scheduledAt: at + 30_000 }, done + 30_000)).toBe(false);
  });
});

describe('gold since a headline', () => {
  const at = T0;
  const tick = (ms: number, mid: number): TickPoint => ({
    ts: at + ms,
    bid: mid - 0.1,
    ask: mid + 0.1,
  });

  it('takes the stored measure of the 10 minutes, signed, in the ATR of the time', () => {
    expect(sampleMove(1.25, -2.5)).toEqual({ usd: -2.5, atr: -2 });
    expect(sampleMove(0.5, 0.4)).toEqual({ usd: 0.4, atr: 0.8 });
    expect(sampleMove(1.25, null)).toBeNull();
    expect(sampleMove(0, 1)).toBeNull();
  });

  it('measures a young story from the ticks up to now, and an older one up to its 10 minutes', () => {
    const ticks = [
      tick(-10_000, 4000),
      tick(120_000, 4001.5),
      tick(590_000, 4002),
      tick(660_000, 4010),
    ];
    expect(liveMove(ticks, at, at + 130_000, 0.5)).toEqual({ usd: 1.5, atr: 3 });
    expect(liveMove(ticks, at, at + 12 * MIN, 0.5)).toEqual({ usd: 2, atr: 4 });
    expect(liveMove(ticks, at, at + 12 * MIN, null)).toBeNull();
  });

  it('is null without a tick near the story or after it', () => {
    expect(liveMove([tick(-31_000, 4000), tick(60_000, 4001)], at, at + 90_000, 1)).toBeNull();
    expect(liveMove([tick(-1000, 4000)], at, at + 90_000, 1)).toBeNull();
    expect(liveMove([], at, at + 90_000, 1)).toBeNull();
    expect(liveMove([tick(-1000, 4000), tick(10_000, 4001)], at, at + 20_000, 1)).toEqual({
      usd: 1,
      atr: 1,
    });
  });
});

describe('headlineOf', () => {
  it('shows the story as the contract wants it', () => {
    const headline = headlineOf(
      cluster({
        sources: [
          { key: 'a', name: 'A' },
          { key: 'b', name: 'B' },
        ],
      }),
      { usd: 1.2, atr: 0.3 },
    );
    expect(headline).toEqual({
      id: uuid(0x100),
      title: 'Fed holds rates steady',
      sources: [
        { key: 'a', name: 'A' },
        { key: 'b', name: 'B' },
      ],
      publishedAt: ISO(T0 - 5 * MIN),
      firstSeenAt: ISO(T0 - 4 * MIN),
      delayS: 60,
      topics: ['FED_RATES'],
      impact: 'HIGH',
      url: 'https://example.com/fed',
      goldMoveSincePublish: { usd: 1.2, atr: 0.3 },
    });
  });

  it('has no delay when no feed gave a time, and never a negative one', () => {
    const none = headlineOf(cluster({ publishedAt: null }), null);
    expect([none.publishedAt, none.delayS, none.goldMoveSincePublish]).toEqual([null, null, null]);
    expect(headlineOf(cluster({ publishedAt: T0, firstSeenAt: T0 - 5000 }), null).delayS).toBe(0);
    expect(headlineOf(cluster({ publishedAt: T0, firstSeenAt: T0 + 90_400 }), null).delayS).toBe(
      90,
    );
    expect(headlineOf(cluster({ publishedAt: T0, firstSeenAt: T0 + 90_600 }), null).delayS).toBe(
      91,
    );
    expect(headlineOf(cluster({ publishedAt: T0, firstSeenAt: T0 }), null).delayS).toBe(0);
  });
});

describe('the cursor', () => {
  const position = { at: Date.UTC(2026, 9, 26, 5, 55, 0, 123), id: uuid(0xabc) };

  it('is opaque and comes back as the position', () => {
    const cursor = encodeCursor(position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain(position.id);
    expect(decodeCursor(cursor)).toEqual(position);
    expect(encodeCursor({ at: 0, id: uuid(1) }).length).toBeLessThan(512);
  });

  it('refuses anything that was not made by encodeCursor, with a 400 that tells nothing of the text', () => {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const bad = [
      '',
      'h5',
      '%%',
      'a b',
      b64(null),
      b64([]),
      b64({}),
      b64({ v: 2, t: 1, i: uuid(1) }),
      b64({ v: 1, t: 1 }),
      b64({ v: 1, t: -1, i: uuid(1) }),
      b64({ v: 1, t: 1.5, i: uuid(1) }),
      b64({ v: 1, t: '1', i: uuid(1) }),
      b64({ v: 1, t: 1, i: 'nope' }),
      b64({ v: 1, t: 1, i: uuid(1), extra: true }),
      b64({ v: 1, t: 8_640_000_000_000_001, i: uuid(1) }),
      Buffer.from('{not json').toString('base64url'),
    ];
    for (const cursor of bad) {
      let caught: unknown;
      try {
        decodeCursor(cursor);
      } catch (error) {
        caught = error;
      }
      expect(caught, cursor).toBeInstanceOf(ProblemError);
      expect(caught).toMatchObject({ status: 400, code: 'invalid_cursor' });
      expect((caught as Error).message).toBe('The cursor is not valid.');
    }
  });
});
