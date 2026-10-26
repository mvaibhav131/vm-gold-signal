import { describe, expect, it, vi } from 'vitest';

import { sessionAt } from '@vmgs/core';

import { StreamPublisher, type Health, type NewsPort } from './publisher';
import type { MarketFacts, MarketReader } from '../market/reader';
import type { DetailRecord, OpenRecord, QuoteFacts, SignalsReader } from '../signals/reader';
import { openRecord, signalRecord } from '../testing/signalFixtures';
import { EventHub, type Stamped } from './hub';

const NOW = Date.UTC(2026, 9, 23, 6, 16, 0);
const MIN = 60_000;
const ID_A = '0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e10';
const ID_B = '0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e11';
const KEY_OLD = '0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e21';
const KEY_FRESH = '0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e22';

function facts(change: Partial<MarketFacts> = {}): MarketFacts {
  return {
    quote: { sourceAt: NOW - 1000, receivedAt: NOW - 400, bid: 4017.37, ask: 4017.55 },
    worker: { heartbeatAt: NOW - 3000, provider: 'biquote', feedState: 'LIVE' },
    engineDoc: { status: 'RUNNING' },
    engineStateDoc: {
      evaluatedAt: NOW - 2 * MIN,
      regime: 'TREND_UP',
      warmup: { ready: true, progressPct: 100, missingTimeframes: [] },
      waitReasons: [{ code: 'QUALITY_OK', label: 'Quality score 61.0 is below 65' }],
    },
    openStatuses: [],
    ...change,
  };
}

class FakeMarket implements MarketReader {
  next: MarketFacts | Error = facts();
  calls = 0;
  gate: Promise<void> | null = null;
  async facts(): Promise<MarketFacts> {
    this.calls += 1;
    if (this.gate !== null) await this.gate;
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
  candles() {
    return Promise.resolve([]);
  }
}

class FakeSignals implements SignalsReader {
  items: OpenRecord[] = [];
  quote: QuoteFacts | null = { bid: 4020.1, ask: 4020.3, at: NOW - 1000 };
  failure: Error | null = null;
  details = new Map<string, DetailRecord>();
  opened = 0;
  /** Holds the next read of the open signals, as a slow database does (what it read is what it saw before). */
  gate: Promise<void> | null = null;
  open = async () => {
    this.opened += 1;
    if (this.failure !== null) throw this.failure;
    const seen = { items: this.items, quote: this.quote };
    if (this.gate !== null) {
      const held = this.gate;
      this.gate = null;
      await held;
    }
    return seen;
  };
  history() {
    return Promise.resolve([]);
  }
  summary() {
    return Promise.resolve({ generated: 0, closed: [] });
  }
  detail(id: string) {
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(this.details.get(id) ?? null);
  }
  snapshot() {
    return Promise.resolve(null);
  }
}

interface Rig {
  hub: EventHub;
  market: FakeMarket;
  signals: FakeSignals;
  publisher: StreamPublisher;
  clock: { now: number };
  logs: string[];
  listener: { got: Stamped[] };
}

function rig(
  options: {
    news?: NewsPort;
    health?: { read: (now: number) => Promise<Health> };
    listen?: boolean;
  } = {},
): Rig {
  const hub = new EventHub('b');
  const market = new FakeMarket();
  const signals = new FakeSignals();
  const clock = { now: NOW };
  const logs: string[] = [];
  const got: Stamped[] = [];
  if (options.listen !== false) hub.subscribe((stamped) => got.push(stamped));
  const publisher = new StreamPublisher({
    hub,
    market,
    signals,
    ...(options.news === undefined ? {} : { news: options.news }),
    ...(options.health === undefined ? {} : { health: options.health }),
    now: () => clock.now,
    log: (level, message) => logs.push(`${level}: ${message}`),
  });
  return { hub, market, signals, publisher, clock, logs, listener: { got } };
}

const kinds = (r: Rig) => r.listener.got.map((stamped) => stamped.event.event);
const ofKind = (r: Rig, kind: string) =>
  r.listener.got.filter((stamped) => stamped.event.event === kind);

describe('StreamPublisher: the market', () => {
  it('sends the quote every time, and the engine only when it changes', async () => {
    const r = rig();
    await r.publisher.pollMarket();
    await r.publisher.pollMarket();
    expect(kinds(r)).toEqual(['quote', 'engine', 'quote']);
    const quote = ofKind(r, 'quote')[0];
    expect(quote?.id).toBeNull();
    expect(quote?.event).toEqual({
      event: 'quote',
      data: { bid: 4017.37, ask: 4017.55, spread: 0.18, ageMs: 1000, feedState: 'LIVE' },
    });
    expect(ofKind(r, 'engine')[0]?.event).toEqual({
      event: 'engine',
      data: {
        status: 'RUNNING',
        waitReasons: [{ code: 'QUALITY_OK', label: 'Quality score 61.0 is below 65' }],
        regime: 'TREND_UP',
        session: sessionAt(NOW),
      },
    });
  });

  it('sends the engine again when the owner pauses, and when the regime or the reasons change', async () => {
    const r = rig();
    await r.publisher.pollMarket();
    r.market.next = facts({
      engineDoc: { status: 'PAUSED', pausedSince: new Date(NOW).toISOString(), pausedUntil: null },
    });
    await r.publisher.pollMarket();
    expect(
      ofKind(r, 'engine').map(
        (stamped) => (stamped.event as { data: { status: string } }).data.status,
      ),
    ).toEqual(['RUNNING', 'PAUSED']);
    r.market.next = facts({
      engineDoc: { status: 'PAUSED', pausedSince: new Date(NOW).toISOString(), pausedUntil: null },
      engineStateDoc: {
        evaluatedAt: NOW,
        regime: 'RANGE',
        warmup: { ready: true, progressPct: 100, missingTimeframes: [] },
        waitReasons: [],
      },
    });
    await r.publisher.pollMarket();
    expect(ofKind(r, 'engine')).toHaveLength(3);
  });

  it('sends no quote when nobody listens, but keeps the engine for the replay', async () => {
    const r = rig({ listen: false });
    await r.publisher.pollMarket();
    expect(r.hub.lastId).toBe('b:1');
    const late: Stamped[] = [];
    r.hub.subscribe((stamped) => late.push(stamped));
    await r.publisher.pollMarket();
    expect(late.map((stamped) => stamped.event.event)).toEqual(['quote']);
  });

  it('says nothing while there is no quote, and logs a database that cannot be read', async () => {
    const r = rig();
    r.market.next = facts({ quote: null });
    await r.publisher.pollMarket();
    expect(kinds(r)).toEqual([]);
    r.market.next = new Error('connection refused');
    await expect(r.publisher.pollMarket()).resolves.toBeUndefined();
    expect(r.logs).toEqual(['error: the market could not be read for the stream']);
  });

  it('does not start a look while the one before is still running', async () => {
    const r = rig();
    let release: () => void = () => undefined;
    r.market.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = r.publisher.pollMarket();
    await r.publisher.pollMarket();
    expect(r.market.calls).toBe(1);
    release();
    await first;
    r.market.gate = null;
    await r.publisher.pollMarket();
    expect(r.market.calls).toBe(2);
  });

  it('shows a feed that has stopped in the quote, as it is now', async () => {
    const r = rig();
    r.market.next = facts({ worker: { heartbeatAt: null, provider: null, feedState: null } });
    await r.publisher.pollMarket();
    expect(ofKind(r, 'quote')[0]?.event).toMatchObject({ data: { feedState: 'DISCONNECTED' } });
    expect(ofKind(r, 'engine')[0]?.event).toMatchObject({
      data: { waitReasons: [{ code: 'DATA_FRESH' }, { code: 'QUALITY_OK' }] },
    });
  });
});

describe('StreamPublisher: the open signals', () => {
  it('sends the numbers of each open signal once, and again only when they changed', async () => {
    const r = rig();
    r.signals.items = [openRecord('ACTIVE')];
    await r.publisher.pollSignals();
    await r.publisher.pollSignals();
    expect(ofKind(r, 'signal_update')).toHaveLength(1);
    expect(ofKind(r, 'signal_update')[0]?.event).toEqual({
      event: 'signal_update',
      data: { id: ID_A, status: 'ACTIVE', unrealisedR: 0.42, stop: 4010.9 },
    });
    r.signals.quote = { bid: 4021.1, ask: 4021.3, at: NOW };
    await r.publisher.pollSignals();
    expect(ofKind(r, 'signal_update')).toHaveLength(2);
    expect(ofKind(r, 'signal_update')[1]?.event).toMatchObject({ data: { unrealisedR: 0.58 } });
  });

  it('sends a change of the stop or of the status even when the result in R is the same', async () => {
    const r = rig();
    r.signals.items = [openRecord('ACTIVE')];
    await r.publisher.pollSignals();
    r.signals.items = [openRecord('ACTIVE', {})];
    r.signals.items = [
      { ...openRecord('ACTIVE'), state: { ...openRecord('ACTIVE').state, stopLossCurrent: 4012 } },
    ];
    await r.publisher.pollSignals();
    expect(ofKind(r, 'signal_update')).toHaveLength(2);
    expect(ofKind(r, 'signal_update')[1]?.event).toMatchObject({ data: { stop: 4012 } });
  });

  it('keeps a number for every signal, and starts afresh for one that was closed and has an id again', async () => {
    const r = rig();
    r.signals.items = [openRecord('ACTIVE'), openRecord('ACTIVE', { id: ID_B, seq: 43 })];
    await r.publisher.pollSignals();
    expect(ofKind(r, 'signal_update')).toHaveLength(2);
    r.signals.items = [openRecord('ACTIVE', { id: ID_B, seq: 43 })];
    await r.publisher.pollSignals();
    expect(ofKind(r, 'signal_update')).toHaveLength(2);
    r.signals.items = [openRecord('ACTIVE'), openRecord('ACTIVE', { id: ID_B, seq: 43 })];
    await r.publisher.pollSignals();
    expect(ofKind(r, 'signal_update')).toHaveLength(3);
  });

  it('does nothing when nobody listens, and when there is no price', async () => {
    const quiet = rig({ listen: false });
    quiet.signals.items = [openRecord('ACTIVE')];
    await quiet.publisher.pollSignals();
    expect(quiet.signals.opened).toBe(0);
    expect(quiet.hub.lastId).toBe('b:0');

    const r = rig();
    r.signals.items = [openRecord('ACTIVE')];
    r.signals.quote = null;
    await r.publisher.pollSignals();
    expect(kinds(r)).toEqual([]);
  });

  it('logs a database that cannot be read, and goes on', async () => {
    const r = rig();
    r.signals.failure = new Error('down');
    await expect(r.publisher.pollSignals()).resolves.toBeUndefined();
    expect(r.logs).toEqual(['error: the open signals could not be read for the stream']);
  });
});

describe('StreamPublisher: what the worker announces', () => {
  const payload = (id: string, change: string) => JSON.stringify({ id, change });

  it('turns a created signal into a signal event, with an id that is replayed', async () => {
    const r = rig();
    await r.publisher.notified(payload(ID_A, 'created'));
    expect(r.listener.got).toEqual([{ id: 'b:1', event: { event: 'signal', data: { id: ID_A } } }]);
  });

  it('turns a change of an open signal into its numbers', async () => {
    const r = rig();
    r.signals.items = [openRecord('TP1_HIT')];
    await r.publisher.notified(payload(ID_A, 'state'));
    expect(r.listener.got[0]?.event).toEqual({
      event: 'signal_update',
      data: { id: ID_A, status: 'TP1_HIT', unrealisedR: 0.71, stop: 4017.37 },
    });
    // the periodic look does not send them again
    await r.publisher.pollSignals();
    expect(ofKind(r, 'signal_update')).toHaveLength(1);
  });

  it('turns the end of a signal into CLOSED with the net R it made, and forgets it', async () => {
    const r = rig();
    r.signals.items = [openRecord('ACTIVE')];
    await r.publisher.pollSignals();
    r.signals.items = [];
    r.signals.details.set(ID_A, {
      signal: signalRecord(),
      state: null,
      events: [],
      outcome: {
        result: 'WIN',
        countsInStats: true,
        closedAt: NOW,
        exitPrice: 4030.31,
        exitReason: 'TP2',
        realizedRGross: 1.5,
        costR: 0.03,
        realizedRNet: 1.4749,
        durationS: 900,
        mfeR: 2.1,
        maeR: -0.4,
        tp1Hit: true,
        tp2Hit: true,
        ambiguous: false,
        isWin: true,
        meta: {},
      },
      autopsy: null,
    });
    await r.publisher.notified(payload(ID_A, 'closed'));
    expect(ofKind(r, 'signal_update').at(-1)?.event).toEqual({
      event: 'signal_update',
      data: { id: ID_A, status: 'CLOSED', unrealisedR: 1.47, stop: 4010.9 },
    });
  });

  it('says CLOSED with 0 R for a signal that has no net R (cancelled), and nothing for one that is not there', async () => {
    const r = rig();
    r.signals.details.set(ID_A, {
      signal: signalRecord(),
      state: null,
      events: [],
      outcome: {
        result: 'CANCELLED',
        countsInStats: false,
        closedAt: NOW,
        exitPrice: null,
        exitReason: 'STALE_BEFORE_ENTRY',
        realizedRGross: null,
        costR: 0,
        realizedRNet: null,
        durationS: 0,
        mfeR: null,
        maeR: null,
        tp1Hit: false,
        tp2Hit: false,
        ambiguous: false,
        isWin: false,
        meta: {},
      },
      autopsy: null,
    });
    await r.publisher.notified(payload(ID_A, 'review'));
    expect(ofKind(r, 'signal_update')[0]?.event).toMatchObject({
      data: { status: 'CLOSED', unrealisedR: 0 },
    });
    await r.publisher.notified(payload(ID_B, 'closed'));
    expect(ofKind(r, 'signal_update')).toHaveLength(1);
  });

  it('logs and drops a notification that is not what the worker sends', async () => {
    const r = rig();
    for (const bad of [
      '',
      'not json',
      '{}',
      JSON.stringify({ id: 'x', change: 'created' }),
      payload(ID_A, 'deleted'),
      JSON.stringify({ id: ID_A, change: 'created', extra: 1 }),
      'null',
      '[]',
    ]) {
      await r.publisher.notified(bad);
    }
    expect(r.listener.got).toEqual([]);
    expect(r.logs).toHaveLength(8);
  });

  it('logs a database that cannot be read, and goes on', async () => {
    const r = rig();
    r.signals.failure = new Error('down');
    await expect(r.publisher.notified(payload(ID_A, 'state'))).resolves.toBeUndefined();
    expect(r.logs).toEqual(['error: a change of a signal could not be sent to the stream']);
  });

  it('sends a look that began before a close before that close, so that a closed signal is never left open on a screen', async () => {
    const r = rig();
    r.signals.items = [openRecord('ACTIVE')];
    let release: () => void = () => undefined;
    r.signals.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const look = r.publisher.pollSignals(); // read while the signal was still open ...
    await vi.waitFor(() => {
      expect(r.signals.opened).toBe(1);
    });
    r.signals.items = []; // ... then the worker closed it and announced it
    r.signals.details.set(ID_A, {
      signal: signalRecord(),
      state: null,
      events: [],
      outcome: {
        result: 'CANCELLED',
        countsInStats: false,
        closedAt: NOW,
        exitPrice: null,
        exitReason: 'STALE_BEFORE_ENTRY',
        realizedRGross: null,
        costR: 0,
        realizedRNet: null,
        durationS: 0,
        mfeR: null,
        maeR: null,
        tp1Hit: false,
        tp2Hit: false,
        ambiguous: false,
        isWin: false,
        meta: {},
      },
      autopsy: null,
    });
    const announced = r.publisher.notified(payload(ID_A, 'closed'));
    // what is not held back by the look would be finished by now: it must wait for it instead
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ofKind(r, 'signal_update')).toEqual([]);
    release();
    await Promise.all([look, announced]);
    expect(
      ofKind(r, 'signal_update').map(
        (stamped) => (stamped.event.data as { status: string }).status,
      ),
    ).toEqual(['ACTIVE', 'CLOSED']);
  });

  it('goes on with the work of the signals after a step of it failed', async () => {
    const r = rig();
    r.signals.failure = new Error('down');
    await r.publisher.pollSignals();
    await r.publisher.notified(payload(ID_A, 'state'));
    r.signals.failure = null;
    r.signals.items = [openRecord('ACTIVE')];
    await r.publisher.pollSignals();
    expect(ofKind(r, 'signal_update')).toHaveLength(1);
  });
});

describe('StreamPublisher: news and health', () => {
  const macro = {
    id: ID_A,
    name: 'CPI m/m',
    scheduledAt: '2026-10-23T12:30:00.000Z',
    importance: 'high' as const,
    currency: 'USD',
    unit: null,
    actual: null,
    forecast: 0.3,
    previous: 0.2,
    revisedPrevious: null,
  };
  const headline = (key: string) => ({
    key,
    headline: {
      id: key,
      title: 'Fed holds rates',
      sources: [{ key: 'fxstreet', name: 'FXStreet' }],
      publishedAt: '2026-10-23T06:15:00.000Z',
      firstSeenAt: '2026-10-23T06:15:20.000Z',
      delayS: 20,
      topics: ['FED_RATES'],
      impact: 'HIGH',
      url: 'https://example.org/a',
      goldMoveSincePublish: null,
    },
  });

  function newsRig() {
    const state = {
      current: { state: 'CLEAR', next: null, newestHigh: null } as Awaited<
        ReturnType<NewsPort['read']>
      >,
      failure: null as Error | null,
    };
    const news: NewsPort = {
      read: () =>
        state.failure === null ? Promise.resolve(state.current) : Promise.reject(state.failure),
    };
    return { state, r: rig({ news }) };
  }

  it('sends the state of the window when it changes, not before', async () => {
    const { state, r } = newsRig();
    await r.publisher.pollNews();
    await r.publisher.pollNews();
    expect(ofKind(r, 'news')).toHaveLength(1);
    state.current = { state: 'IN_WINDOW', next: null, newestHigh: null };
    await r.publisher.pollNews();
    expect(
      ofKind(r, 'news').map((stamped) => (stamped.event as { data: { state: string } }).data.state),
    ).toEqual(['CLEAR', 'IN_WINDOW']);
  });

  it('sends every new HIGH-impact headline once, and not the one that was there when it began to look', async () => {
    const { state, r } = newsRig();
    state.current = { state: 'CLEAR', next: null, newestHigh: headline(KEY_OLD) } as never;
    await r.publisher.pollNews();
    expect(ofKind(r, 'news')).toHaveLength(1);
    expect((ofKind(r, 'news')[0]?.event as { data: object }).data).not.toHaveProperty('headline');
    state.current = { state: 'CLEAR', next: null, newestHigh: headline(KEY_FRESH) } as never;
    await r.publisher.pollNews();
    await r.publisher.pollNews();
    const news = ofKind(r, 'news');
    expect(news).toHaveLength(2);
    expect(news[1]?.event).toMatchObject({
      data: { state: 'CLEAR', headline: { id: KEY_FRESH, impact: 'HIGH' } },
    });
    state.current = { state: 'IN_WINDOW', next: macro, newestHigh: headline(KEY_FRESH) } as never;
    await r.publisher.pollNews();
    expect((ofKind(r, 'news')[2]?.event as { data: object }).data).not.toHaveProperty('headline');
  });

  it('logs a news that cannot be read, and does nothing without a port', async () => {
    const { state, r } = newsRig();
    state.failure = new Error('down');
    await r.publisher.pollNews();
    expect(r.logs).toEqual(['error: the news could not be read for the stream']);
    const none = rig();
    await none.publisher.pollNews();
    await none.publisher.pollHealth();
    expect(none.listener.got).toEqual([]);
  });

  it('sends the health map when it changes, and at least every 30 seconds', async () => {
    let map: Health = { feed: 'OK', worker: 'OK' };
    const r = rig({ health: { read: () => Promise.resolve(map) } });
    await r.publisher.pollHealth();
    await r.publisher.pollHealth();
    expect(ofKind(r, 'health')).toHaveLength(1);
    r.clock.now += 29_999;
    await r.publisher.pollHealth();
    expect(ofKind(r, 'health')).toHaveLength(1);
    r.clock.now += 1;
    await r.publisher.pollHealth();
    expect(ofKind(r, 'health')).toHaveLength(2);
    map = { feed: 'DEGRADED', worker: 'OK' };
    await r.publisher.pollHealth();
    expect(ofKind(r, 'health')).toHaveLength(3);
    expect(ofKind(r, 'health')[2]?.event).toEqual({
      event: 'health',
      data: { feed: 'DEGRADED', worker: 'OK' },
    });
  });

  it('looks at everything at once when asked', async () => {
    const { r } = newsRig();
    r.signals.items = [openRecord('ACTIVE')];
    await r.publisher.refresh();
    expect(new Set(kinds(r))).toEqual(new Set(['engine', 'quote', 'signal_update', 'news']));
  });
});

describe('StreamPublisher: the timers', () => {
  it('works on its own once started, faster while somebody listens, and stops when it is told', async () => {
    const hub = new EventHub('b');
    const market = new FakeMarket();
    const signals = new FakeSignals();
    const publisher = new StreamPublisher({
      hub,
      market,
      signals,
      now: () => NOW,
      intervals: { marketMs: 5, idleMs: 40, signalMs: 5, newsMs: 5, healthMs: 5 },
    });
    publisher.start();
    publisher.start(); // a second start changes nothing
    const got: Stamped[] = [];
    hub.subscribe((stamped) => got.push(stamped));
    await vi.waitFor(() => {
      expect(got.filter((stamped) => stamped.event.event === 'quote').length).toBeGreaterThan(3);
    }, 5000);
    publisher.stop();
    const calls = market.calls;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(market.calls).toBe(calls);
  });

  it('looks at the health every `healthMs` while somebody listens, and only every `idleMs` when nobody does', async () => {
    const reads = { listened: 0, alone: 0 };
    const start = (key: 'listened' | 'alone', listen: boolean): StreamPublisher => {
      const hub = new EventHub('b');
      if (listen) hub.subscribe(() => undefined);
      const publisher = new StreamPublisher({
        hub,
        market: new FakeMarket(),
        signals: new FakeSignals(),
        health: {
          read: () => {
            reads[key] += 1;
            return Promise.resolve({ feed: 'OK', worker: 'OK' });
          },
        },
        now: () => NOW,
        intervals: { marketMs: 1000, idleMs: 5000, signalMs: 1000, newsMs: 1000, healthMs: 10 },
      });
      publisher.start();
      return publisher;
    };
    const listened = start('listened', true);
    const alone = start('alone', false);
    await vi.waitFor(() => {
      expect(reads.listened).toBeGreaterThan(3);
    }, 3000);
    listened.stop();
    alone.stop();
    expect(reads.alone).toBe(0); // its first look is only after 5 s
  });

  it('goes on after a step that failed', async () => {
    const hub = new EventHub('b');
    const market = new FakeMarket();
    market.next = new Error('down');
    const publisher = new StreamPublisher({
      hub,
      market,
      signals: new FakeSignals(),
      now: () => NOW,
      intervals: { marketMs: 5, idleMs: 5, signalMs: 5, newsMs: 5, healthMs: 5 },
    });
    publisher.start();
    await vi.waitFor(() => {
      expect(market.calls).toBeGreaterThan(2);
    }, 5000);
    market.next = facts();
    await vi.waitFor(() => {
      expect(hub.lastId).toBe('b:1');
    }, 5000);
    publisher.stop();
  });
});
