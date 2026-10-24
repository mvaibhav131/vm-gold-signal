import { ApiError } from '../api/client';
import { NEWS_TOPICS } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import {
  CALENDAR_OUTAGE_S,
  HEADLINE_OUTAGE_MS,
  NEWS_SOURCES,
  headlinesAt,
  marketMovesAt,
  newsEventsAt,
  newsStateAt,
  type HeadlinesFilter,
} from './news';

// The preview started on a Friday at 12:00 UTC.
const NOW = Date.parse('2026-10-23T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const all: HeadlinesFilter = { limit: 50 };

describe('the news state', () => {
  it('puts the next event 22 minutes away inside the news window and 4 hours away when it is clear', () => {
    const inWindow = newsStateAt('IN_WINDOW', NOW);
    expect(inWindow.state).toBe('IN_WINDOW');
    expect(inWindow.next).toMatchObject({
      id: '00000000-0000-4000-8000-00000000e001',
      name: 'US CPI (simulated)',
      scheduledAt: '2026-10-23T12:22:00.000Z',
      importance: 'high',
      actual: null,
      forecast: 0.3,
      previous: 0.4,
    });
    expect(newsStateAt('CLEAR', NOW).next?.scheduledAt).toBe('2026-10-23T16:00:00.000Z');
  });

  it('knows the last event that was released, not the one whose value has not arrived', () => {
    // the newest event (50 minutes ago) has no value yet, so the last released one is the PPI of yesterday
    expect(newsStateAt('CLEAR', NOW).last).toMatchObject({
      name: 'US PPI m/m (simulated)',
      scheduledAt: '2026-10-22T12:30:00.000Z',
      actual: 0.2,
      forecast: 0.3,
      previous: 0.1,
      revisedPrevious: 0.2,
    });
  });

  it('cannot say what comes next while the calendar feed is down, and says how old its last fetch is', () => {
    const unknown = newsStateAt('UNKNOWN', NOW);
    expect(unknown).toMatchObject({ state: 'UNKNOWN', next: null, sourceAgeS: CALENDAR_OUTAGE_S });
    expect(CALENDAR_OUTAGE_S).toBe(11_520);
    expect(newsStateAt('CLEAR', NOW).sourceAgeS).toBe(45);
  });

  it('has the same next event in the calendar as in the state', () => {
    for (const state of ['CLEAR', 'IN_WINDOW'] as const) {
      const next = newsStateAt(state, NOW).next;
      const upcoming = newsEventsAt(state, NOW, { from: new Date(NOW).toISOString() }).items[0];
      expect(upcoming?.id).toBe(next?.id);
      expect(upcoming?.scheduledAt).toBe(next?.scheduledAt);
    }
  });
});

describe('the calendar', () => {
  const events = (state: 'CLEAR' | 'IN_WINDOW' | 'UNKNOWN' = 'CLEAR', query = {}) =>
    newsEventsAt(state, NOW, query);

  it('has ten events in the past and eight to come, oldest first', () => {
    const { items } = events();
    expect(items).toHaveLength(18);
    const times = items.map((event) => Date.parse(event.scheduledAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(items.filter((event) => Date.parse(event.scheduledAt) < NOW)).toHaveLength(10);
    expect(items.filter((event) => Date.parse(event.scheduledAt) >= NOW)).toHaveLength(8);
    expect(items[0]?.scheduledAt).toBe('2026-10-10T12:30:00.000Z');
    expect(items.at(-1)?.scheduledAt).toBe('2026-10-29T14:00:00.000Z');
  });

  it('keeps every event of the past before now and every event to come after it, so the page can split them', () => {
    for (const state of ['CLEAR', 'IN_WINDOW', 'UNKNOWN'] as const) {
      for (const event of events(state).items) {
        const at = Date.parse(event.scheduledAt);
        const released = event.actual !== null;
        // an event that has a value was released, and a released event is in the past
        if (released) expect(at, event.name).toBeLessThan(NOW);
      }
    }
  });

  it('has no surprise and no move for an event that is still to come, and for one whose value has not arrived', () => {
    for (const event of events().items.filter((e) => e.actual === null)) {
      expect([event.surpriseSigma, event.goldMoveAfter, event.revisedPrevious], event.name).toEqual(
        [null, null, null],
      );
    }
    // the durable goods orders of 50 minutes ago: it has happened, its value has not been delivered
    const waiting = events().items.find((e) => e.id.endsWith('e014'));
    expect(waiting).toMatchObject({
      name: 'US durable goods orders m/m (simulated)',
      scheduledAt: '2026-10-23T11:10:00.000Z',
      actual: null,
      forecast: 0.5,
    });
  });

  it('measures the surprise and the move of gold for the events that were released', () => {
    const payrolls = events().items.find((e) => e.id.endsWith('e01b'));
    expect(payrolls).toMatchObject({
      name: 'US non-farm payrolls (simulated)',
      scheduledAt: '2026-10-14T12:30:00.000Z',
      importance: 'high',
      unit: 'K',
      actual: 212,
      forecast: 185,
      previous: 142,
      revisedPrevious: 156,
      surpriseSigma: 1.8,
      goldMoveAfter: { usd: -7.3, atr: -1.6 },
    });
    // a released event can lack a surprise (no history to measure it) and a move (no candles)
    const gdp = events().items.find((e) => e.id.endsWith('e01d'));
    expect([gdp?.actual, gdp?.surpriseSigma, gdp?.goldMoveAfter]).toEqual([3.1, null, null]);
  });

  it('has no event to come while the calendar feed is down, only the stored past', () => {
    const { items, sourceAgeS } = events('UNKNOWN');
    expect(items).toHaveLength(10);
    expect(items.every((event) => Date.parse(event.scheduledAt) < NOW)).toBe(true);
    expect(sourceAgeS).toBe(CALENDAR_OUTAGE_S);
  });

  it('can be limited to one importance and to a range (from included, to excluded)', () => {
    const high = events('CLEAR', { importance: 'high' }).items;
    expect(high).toHaveLength(7);
    expect(high.every((event) => event.importance === 'high')).toBe(true);
    expect(events('CLEAR', { importance: 'low' }).items.map((e) => e.name)).toEqual([
      'US industrial production m/m (simulated)',
      'US consumer sentiment (simulated)',
    ]);
    const iso = new Date(NOW).toISOString();
    expect(events('CLEAR', { from: iso }).items).toHaveLength(8);
    expect(events('CLEAR', { to: iso }).items).toHaveLength(10);
    const second = events().items[1]?.scheduledAt;
    expect(events('CLEAR', { from: second, to: second }).items).toEqual([]);
  });

  it('covers 14 days back and 8 days ahead by default, and keeps older and later events that only an explicit range returns', () => {
    const today = Math.floor(NOW / DAY) * DAY;
    const iso = (days: number) => new Date(today + days * DAY).toISOString();
    const defaults = events().items;
    expect(defaults).toEqual(events('CLEAR', { from: iso(-14), to: iso(8) }).items);
    const wide = events('CLEAR', { from: iso(-20), to: iso(20) }).items;
    const outside = wide.filter((event) => !defaults.some((d) => d.id === event.id));
    expect(outside.map((event) => event.name)).toEqual([
      'US trade balance (simulated)',
      'US durable goods orders m/m, final (simulated)',
    ]);
    expect(outside.map((event) => event.scheduledAt)).toEqual([
      '2026-10-08T13:30:00.000Z',
      '2026-10-31T12:30:00.000Z',
    ]);
  });
});

describe('the headlines', () => {
  it('lists 14 headlines, newest first, each saying that it is simulated', () => {
    const { items } = headlinesAt(NOW, all);
    expect(items).toHaveLength(14);
    const published = items.map((item) => Date.parse(item.publishedAt ?? ''));
    expect([...published].sort((a, b) => b - a)).toEqual(published);
    expect(items.every((item) => item.title.startsWith('Simulated headline'))).toBe(true);
    expect(items.every((item) => item.url.startsWith('https://example.com/'))).toBe(true);
    // the three newest are the ones of the dashboard
    expect(items.slice(0, 3).map((item) => item.impact)).toEqual(['MEDIUM', 'LOW', 'HIGH']);
  });

  it('has seen each headline some seconds after it was published', () => {
    for (const item of headlinesAt(NOW, all).items) {
      const delay = Date.parse(item.firstSeenAt) - Date.parse(item.publishedAt ?? '');
      expect(delay / 1000, item.title).toBe(item.delayS ?? 0);
    }
    expect(headlinesAt(NOW, all).items[0]).toMatchObject({
      publishedAt: '2026-10-23T11:48:00.000Z',
      firstSeenAt: '2026-10-23T11:50:00.000Z',
      delayS: 120,
      goldMoveSincePublish: { usd: 1.2, atr: 0.3 },
    });
  });

  it('can lack the delay and the move of gold, and says so with null', () => {
    const bank = headlinesAt(NOW, all).items.find((item) =>
      item.topics.includes('CENTRAL_BANK_GOLD'),
    );
    expect([bank?.delayS, bank?.goldMoveSincePublish]).toEqual([null, null]);
  });

  it('keeps only the headlines of the minimum impact and above', () => {
    const count = (minImpact: 'LOW' | 'MEDIUM' | 'HIGH') =>
      headlinesAt(NOW, { ...all, minImpact }).items.length;
    expect([count('LOW'), count('MEDIUM'), count('HIGH')]).toEqual([14, 11, 4]);
    expect(
      headlinesAt(NOW, { ...all, minImpact: 'HIGH' }).items.every((i) => i.impact === 'HIGH'),
    ).toBe(true);
  });

  it('keeps only the headlines of one topic, also when it is one of several', () => {
    const count = (topic: string) => headlinesAt(NOW, { ...all, topic }).items.length;
    expect([count('FED_RATES'), count('GEOPOLITICS_WAR'), count('USD_DOLLAR')]).toEqual([3, 3, 3]);
    // every topic of the list appears on at least one headline
    for (const topic of NEWS_TOPICS) expect(count(topic), topic).toBeGreaterThan(0);
    expect(headlinesAt(NOW, { ...all, topic: 'RISK_OFF', minImpact: 'HIGH' }).items).toHaveLength(
      2,
    );
    expect(headlinesAt(NOW, { ...all, topic: 'NOT_A_TOPIC' }).items).toEqual([]);
  });

  it('limits by the time the headline was first seen: from included, to excluded', () => {
    const seen = headlinesAt(NOW, all).items.map((item) => item.firstSeenAt);
    const fourth = seen[3] ?? '';
    expect(headlinesAt(NOW, { ...all, from: fourth }).items).toHaveLength(4);
    expect(headlinesAt(NOW, { ...all, to: fourth }).items).toHaveLength(10);
    expect(headlinesAt(NOW, { ...all, from: fourth, to: fourth }).items).toEqual([]);
  });

  it('pages with a cursor, without a repeat and without a gap', () => {
    const first = headlinesAt(NOW, { limit: 5 });
    expect(first.nextCursor).toBe('h5');
    const second = headlinesAt(NOW, { limit: 5, cursor: first.nextCursor ?? '' });
    const third = headlinesAt(NOW, { limit: 5, cursor: second.nextCursor ?? '' });
    expect(third.nextCursor).toBeNull();
    const paged = [...first.items, ...second.items, ...third.items];
    expect(paged.map((item) => item.id)).toEqual(
      headlinesAt(NOW, all).items.map((item) => item.id),
    );
    expect(third.items).toHaveLength(4);
    // exactly one page, no cursor
    expect(headlinesAt(NOW, { limit: 14 }).nextCursor).toBeNull();
    expect(headlinesAt(NOW, { limit: 13 }).nextCursor).toBe('h13');
  });

  it('refuses a cursor that is not its own', () => {
    expect(() => headlinesAt(NOW, { limit: 5, cursor: 'x9' })).toThrow(ApiError);
    expect(() => headlinesAt(NOW, { limit: 5, cursor: 'h' })).toThrow(/cursor/);
  });

  it('reports the three feeds as working, each polled a minute or two ago', () => {
    const { sources } = headlinesAt(NOW, all);
    expect(sources.map((s) => s.key)).toEqual(NEWS_SOURCES.map((s) => s.key));
    for (const source of sources) {
      expect([source.enabled, source.lastError], source.key).toEqual([true, null]);
      expect(NOW - Date.parse(source.lastOkAt ?? ''), source.key).toBe(MINUTE);
    }
    // every outlet that a headline names is one of the sources
    const known = new Set(sources.map((s) => s.key));
    for (const item of headlinesAt(NOW, all).items) {
      for (const source of item.sources) expect(known.has(source.key), item.title).toBe(true);
    }
  });

  describe('while the feeds are down', () => {
    it('lists only what was stored before the outage, and every feed reports its error', () => {
      const { items, sources } = headlinesAt(NOW, all, 'UNKNOWN');
      expect(items).toHaveLength(11);
      for (const item of items) {
        expect(NOW - Date.parse(item.firstSeenAt), item.title).toBeGreaterThanOrEqual(
          HEADLINE_OUTAGE_MS,
        );
      }
      for (const source of sources) {
        expect(source.lastError, source.key).toBe('Timed out after 20 s');
        expect(NOW - Date.parse(source.lastOkAt ?? ''), source.key).toBe(HEADLINE_OUTAGE_MS);
      }
    });

    it('can have nothing to show for a filter, while the feeds are down', () => {
      const none = headlinesAt(NOW, { ...all, topic: 'USD_DOLLAR', minImpact: 'HIGH' }, 'UNKNOWN');
      expect(none.items.map((i) => i.topics)).toEqual([['INFLATION_JOBS', 'USD_DOLLAR']]);
      expect(
        headlinesAt(NOW, { ...all, topic: 'GOLD_DIRECT', minImpact: 'MEDIUM' }, 'UNKNOWN').items,
      ).toEqual([]);
    });
  });
});

describe('the market moves', () => {
  const moves = (query = {}) => marketMovesAt(NOW, query).items;

  it('lists five moves, newest first, with their size, window and spread', () => {
    expect(moves().map((m) => m.id)).toEqual([5, 4, 3, 2, 1]);
    expect(moves()[0]).toMatchObject({
      kind: 'SPIKE_UP',
      windowS: 300,
      moveUsd: 9.8,
      moveAtr: 2.8,
      spread: 0.35,
      detectedAt: '2026-10-23T09:20:00.000Z',
    });
    expect(moves().at(-1)?.spread).toBeNull();
  });

  it('only has moves that reach the detection threshold: 2 ATR in 5 minutes, 3 ATR in 1 minute', () => {
    for (const move of moves()) {
      const limit = move.windowS === 60 ? 3.0 : 2.0;
      expect(move.moveAtr, `move ${String(move.id)}`).toBeGreaterThanOrEqual(limit);
    }
    expect(new Set(moves().map((m) => m.windowS))).toEqual(new Set([60, 300]));
    expect(new Set(moves().map((m) => m.kind))).toEqual(new Set(['SPIKE_UP', 'SPIKE_DOWN']));
  });

  it('freezes the headlines of the 30 minutes before the move, each published before it', () => {
    for (const move of moves()) {
      for (const headline of move.headlines) {
        const before = Date.parse(move.detectedAt) - Date.parse(headline.publishedAt ?? '');
        expect(before, headline.title).toBeGreaterThan(0);
        expect(before, headline.title).toBeLessThanOrEqual(30 * MINUTE);
      }
    }
  });

  it('has the three cases the page must show: classified and timing-only headlines, only timing-only ones, none at all', () => {
    const byId = new Map(moves().map((m) => [m.id, m]));
    expect(byId.get(5)?.headlines.map((h) => h.classified)).toEqual([true, true, false]);
    expect(byId.get(3)?.headlines).toEqual([]);
    expect(byId.get(1)?.headlines.every((h) => !h.classified)).toBe(true);
    expect(byId.get(1)?.headlines).toHaveLength(2);
    // an unclassified headline has no impact and no topics
    for (const move of moves()) {
      for (const headline of move.headlines.filter((h) => !h.classified)) {
        expect([headline.impact, headline.topics]).toEqual([null, []]);
      }
    }
  });

  it('can be limited to a range', () => {
    const day = new Date(NOW - DAY).toISOString();
    expect(moves({ from: day }).map((m) => m.id)).toEqual([5]);
    expect(moves({ from: new Date(NOW - 3 * DAY).toISOString() }).map((m) => m.id)).toEqual([
      5, 4, 3,
    ]);
    expect(moves({ to: new Date(NOW - 3 * DAY).toISOString() }).map((m) => m.id)).toEqual([2, 1]);
    expect(moves({ from: new Date(NOW + HOUR).toISOString() })).toEqual([]);
  });

  it('covers the last 30 days by default, and keeps an older move that only an explicit range returns', () => {
    expect(moves()).toEqual(moves({ from: new Date(NOW - 30 * DAY).toISOString() }));
    expect(moves({ from: new Date(NOW - 40 * DAY).toISOString() }).map((m) => m.id)).toEqual([
      5, 4, 3, 2, 1, 6,
    ]);
  });
});
