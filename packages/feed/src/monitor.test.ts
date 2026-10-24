import { isWeekendClosure, type TickInput } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MONITOR,
  FeedMonitor,
  SKEW_RECOVER_FRACTION,
  type MonitorOptions,
} from './monitor';
import type { FeedIncidentEvent, MonitorEvent } from './types';

/** A Wednesday, so that the weekly closure is never in the way. */
const T = Date.parse('2026-10-21T12:00:00Z');
const SAT = Date.parse('2026-10-24T12:00:00Z');
const SEC = 1000;
const never = () => false;

function make(options: Partial<MonitorOptions> = {}) {
  return new FeedMonitor({ isScheduledClosed: never, ...options });
}

/** A gold tick; by default it is received one second after its source time, like the live feed. */
function tick(ts: number, change: Partial<TickInput> = {}): TickInput {
  return { ts, rxAt: ts + SEC, symbol: 'XAUUSD', bid: 4000, ask: 4000.18, ...change };
}

const states = (events: readonly MonitorEvent[]) =>
  events.flatMap((e) => (e.type === 'state' ? [e.state] : []));

const incidents = (events: readonly MonitorEvent[]) =>
  events.flatMap((e) => (e.type === 'incident' ? [{ phase: e.phase, ...e.incident }] : []));

type Seen = { phase: 'OPEN' | 'CLOSE' } & FeedIncidentEvent;
const first = (events: readonly MonitorEvent[]): Seen => {
  const found = incidents(events)[0];
  if (!found) throw new Error('no incident in the events');
  return found;
};

/** A monitor that is connected and has a fresh tick at `T + 1 s`. */
function live(options: Partial<MonitorOptions> = {}) {
  const monitor = make(options);
  monitor.onConnection(true, T);
  monitor.onTick(tick(T));
  return monitor;
}

/** For tests about one kind of incident: data never gets old, so that no loss of data gets in the way. */
const QUIET: Partial<MonitorOptions> = { maxTickAgeMs: 3_600_000, incidentGraceMs: 3_600_000 };
const plainMake = make;

describe('the state', () => {
  it('starts by reporting where it is, with no previous state', () => {
    const monitor = make();
    expect(monitor.currentState).toBeNull();
    expect(monitor.onConnection(false, T)).toEqual([
      { type: 'state', state: 'DISCONNECTED', previous: null, at: T },
    ]);
    expect(monitor.currentState).toBe('DISCONNECTED');
  });

  it('is LIVE with a connection and a tick that is not older than 10 s, and STALE one millisecond later', () => {
    const monitor = live();
    expect(monitor.currentState).toBe('LIVE');
    expect(monitor.evaluate(T + 10_000)).toEqual([]);
    expect(monitor.snapshot(T + 10_000).state).toBe('LIVE');
    expect(states(monitor.evaluate(T + 10_001))).toEqual(['STALE']);
    expect(monitor.snapshot(T + 10_001).state).toBe('STALE');
  });

  it('judges the age by the source time of the tick, not by when it was received', () => {
    const monitor = make();
    monitor.onConnection(true, T);
    // received now, but stamped 11 s ago: not fresh
    monitor.onTick(tick(T - 11_000, { rxAt: T }));
    expect(monitor.currentState).toBe('STALE');
    monitor.onTick(tick(T - 10_000, { rxAt: T, bid: 4001, ask: 4001.18 }));
    expect(monitor.currentState).toBe('LIVE');
  });

  it('is STALE when connected and nothing has come yet', () => {
    const monitor = make();
    expect(states(monitor.onConnection(true, T))).toEqual(['STALE']);
  });

  it('is DISCONNECTED as soon as the connection is lost, however fresh the last tick is', () => {
    const monitor = live();
    const events = monitor.onConnection(false, T + 2_000, 'closed by the server');
    expect(events).toEqual([
      { type: 'state', state: 'DISCONNECTED', previous: 'LIVE', at: T + 2_000 },
    ]);
  });

  it('is LIVE again when the connection returns and the last tick is still fresh', () => {
    const monitor = live();
    monitor.onConnection(false, T + 2_000);
    expect(states(monitor.onConnection(true, T + 5_000))).toEqual(['LIVE']);
  });

  it('stays STALE after a reconnect until a fresh tick comes', () => {
    const monitor = live();
    monitor.onConnection(false, T + 2_000);
    expect(states(monitor.onConnection(true, T + 30_000))).toEqual(['STALE']);
    expect(states(monitor.onTick(tick(T + 30_000)))).toEqual(['LIVE']);
  });

  it('reports a state only when it changes', () => {
    const monitor = live();
    expect(monitor.onTick(tick(T + SEC, { bid: 4000.1, ask: 4000.28 }))).toEqual([]);
    expect(monitor.onConnection(true, T + 2_000)).toEqual([]);
    expect(monitor.evaluate(T + 3_000)).toEqual([]);
  });

  it('ignores the ticks of other symbols', () => {
    const monitor = make();
    monitor.onConnection(true, T);
    expect(monitor.onTick(tick(T, { symbol: 'DXY' }))).toEqual([]);
    expect(monitor.snapshot(T + 1_000).newestTickTs).toBeNull();
    expect(monitor.currentState).toBe('STALE');
  });

  it('can judge another symbol', () => {
    const monitor = make({ symbol: 'XAGUSD' });
    monitor.onConnection(true, T);
    monitor.onTick(tick(T, { symbol: 'XAUUSD' }));
    expect(monitor.currentState).toBe('STALE');
    monitor.onTick(tick(T, { symbol: 'XAGUSD' }));
    expect(monitor.currentState).toBe('LIVE');
  });

  it('is not moved back by a tick that is older than the newest', () => {
    const monitor = live();
    monitor.onTick(tick(T + 10_000, { bid: 4001, ask: 4001.18 }));
    monitor.onTick(tick(T + 9_000, { bid: 4002, ask: 4002.18 }));
    expect(monitor.snapshot(T + 12_000).newestTickTs).toBe(T + 10_000);
  });

  it('takes the later quote of the same second as the newest (the feed sends several per second)', () => {
    const monitor = make();
    monitor.onConnection(true, T);
    monitor.onTick(tick(T, { rxAt: T + 1_000, bid: 4000, ask: 4000.1 }));
    monitor.onTick(tick(T, { rxAt: T + 1_400, bid: 4000.5, ask: 4000.9 }));
    expect(monitor.snapshot(T + 2_000).spread).toBe(0.4);
  });

  it('takes the limit from the options', () => {
    const monitor = live({ maxTickAgeMs: 3_000 });
    expect(monitor.snapshot(T + 3_000).state).toBe('LIVE');
    expect(monitor.snapshot(T + 3_001).state).toBe('STALE');
  });
});

describe('a loss of data is one incident', () => {
  it('opens a STALE incident when the silence is noticed, dated from the last tick received', () => {
    const monitor = live();
    const events = monitor.evaluate(T + 10_001);
    expect(states(events)).toEqual(['STALE']);
    expect(incidents(events)).toEqual([
      {
        phase: 'OPEN',
        localId: 1,
        kind: 'STALE',
        startedAt: T + SEC,
        endedAt: null,
        details: { disconnected: false },
      },
    ]);
  });

  it('closes it with the time of the first fresh tick', () => {
    const monitor = live();
    monitor.evaluate(T + 20_000);
    const events = monitor.onTick(tick(T + 25_000));
    expect(states(events)).toEqual(['LIVE']);
    expect(incidents(events)).toEqual([
      {
        phase: 'CLOSE',
        localId: 1,
        kind: 'STALE',
        startedAt: T + SEC,
        endedAt: T + 26_000,
        details: { disconnected: false },
      },
    ]);
  });

  it('announces a lost connection only after 5 seconds, dated from the loss', () => {
    const monitor = live();
    monitor.onConnection(false, T + 2_000, 'closed by the server');
    expect(monitor.evaluate(T + 6_999)).toEqual([]);
    const events = monitor.evaluate(T + 7_000);
    expect(incidents(events)).toEqual([
      {
        phase: 'OPEN',
        localId: 1,
        kind: 'DISCONNECT',
        startedAt: T + 2_000,
        endedAt: null,
        details: { reason: 'closed by the server' },
      },
    ]);
    expect(monitor.evaluate(T + 8_000)).toEqual([]);
  });

  it('says nothing about a connection that came back within the grace time', () => {
    const monitor = live();
    const lost = monitor.onConnection(false, T + 2_000);
    const back = monitor.onConnection(true, T + 6_999);
    expect(incidents([...lost, ...back])).toEqual([]);
    expect(monitor.evaluate(T + 9_000)).toEqual([]);
  });

  it('counts the grace time from the loss, and a loss of exactly 5 seconds is an incident', () => {
    const monitor = live();
    monitor.onConnection(false, T + 2_000);
    const back = monitor.onConnection(true, T + 7_000);
    expect(incidents(back).map((i) => i.phase)).toEqual(['OPEN', 'CLOSE']);
  });

  it('opens and closes together when a loss ends before it was noticed but lasted longer than the grace time', () => {
    const monitor = live();
    monitor.onConnection(false, T + 2_000, 'timeout');
    const events = monitor.onConnection(true, T + 9_000);
    expect(states(events)).toEqual(['LIVE']);
    expect(incidents(events)).toEqual([
      {
        phase: 'OPEN',
        localId: 1,
        kind: 'DISCONNECT',
        startedAt: T + 2_000,
        endedAt: null,
        details: { reason: 'timeout' },
      },
      {
        phase: 'CLOSE',
        localId: 1,
        kind: 'DISCONNECT',
        startedAt: T + 2_000,
        endedAt: T + 9_000,
        details: { reason: 'timeout' },
      },
    ]);
  });

  it('keeps one incident when a stall turns into a lost connection, and notes it', () => {
    const monitor = live();
    const open = monitor.evaluate(T + 20_000);
    expect(first(open).kind).toBe('STALE');
    const lost = monitor.onConnection(false, T + 25_000, 'boom');
    expect(states(lost)).toEqual(['DISCONNECTED']);
    expect(incidents(lost)).toEqual([]);
    monitor.onConnection(true, T + 40_000);
    const closed = monitor.onTick(tick(T + 40_000));
    expect(incidents(closed)).toEqual([
      {
        phase: 'CLOSE',
        localId: 1,
        kind: 'STALE',
        startedAt: T + SEC,
        endedAt: T + 41_000,
        details: { disconnected: true, reason: 'boom' },
      },
    ]);
  });

  it('keeps one incident while a lost connection is back but no fresh data has come yet', () => {
    const monitor = live();
    monitor.onConnection(false, T + 2_000, 'closed');
    monitor.evaluate(T + 8_000);
    const back = monitor.onConnection(true, T + 30_000);
    expect(states(back)).toEqual(['STALE']);
    expect(incidents(back)).toEqual([]);
    const fresh = monitor.onTick(tick(T + 30_000));
    expect(incidents(fresh)).toEqual([
      {
        phase: 'CLOSE',
        localId: 1,
        kind: 'DISCONNECT',
        startedAt: T + 2_000,
        endedAt: T + 31_000,
        details: { reason: 'closed' },
      },
    ]);
  });

  it('opens an incident for a feed that never connected, and says why', () => {
    const monitor = make();
    monitor.onConnection(false, T, 'cannot connect: HTTP 503');
    const events = monitor.evaluate(T + 5_000);
    expect(incidents(events)).toEqual([
      {
        phase: 'OPEN',
        localId: 1,
        kind: 'DISCONNECT',
        startedAt: T,
        endedAt: null,
        details: { reason: 'cannot connect: HTTP 503' },
      },
    ]);
  });

  it('keeps the reason of the last failed attempt', () => {
    const monitor = make();
    monitor.onConnection(false, T, 'first');
    monitor.onConnection(false, T + 1_000, 'second');
    expect(first(monitor.evaluate(T + 5_000)).details).toEqual({ reason: 'second' });
  });

  it('uses another grace time when asked', () => {
    const monitor = live({ incidentGraceMs: 1_000 });
    monitor.onConnection(false, T + 2_000);
    expect(monitor.evaluate(T + 2_999)).toEqual([]);
    expect(incidents(monitor.evaluate(T + 3_000))).toHaveLength(1);
  });

  it('numbers the incidents one after another', () => {
    const monitor = live();
    monitor.evaluate(T + 20_000);
    monitor.onTick(tick(T + 20_000));
    monitor.onConnection(false, T + 25_000);
    const second = monitor.evaluate(T + 31_000);
    expect(first(second).localId).toBe(2);
  });
});

describe('a closed market is not a fault', () => {
  it('is MARKET_CLOSED when the provider says closed, with an incident that says why', () => {
    const monitor = make();
    monitor.onConnection(true, T);
    const events = monitor.onMarket('CLOSED', T + 100);
    expect(states(events)).toEqual(['MARKET_CLOSED']);
    expect(incidents(events)).toEqual([
      {
        phase: 'OPEN',
        localId: 1,
        kind: 'MARKET_STATE',
        startedAt: T + 100,
        endedAt: null,
        details: { reason: 'provider', weekend: false },
      },
    ]);
  });

  it('closes the incident when the market opens, and the loss of data starts then', () => {
    const monitor = make();
    monitor.onConnection(true, T);
    monitor.onMarket('CLOSED', T + 100);
    const events = monitor.onMarket('OPEN', T + 3_600_000);
    expect(states(events)).toEqual(['STALE']);
    expect(incidents(events)).toEqual([
      {
        phase: 'CLOSE',
        localId: 1,
        kind: 'MARKET_STATE',
        startedAt: T + 100,
        endedAt: T + 3_600_000,
        details: { reason: 'provider', weekend: false },
      },
    ]);
    const stale = monitor.evaluate(T + 3_605_000);
    expect(first(stale)).toMatchObject({ kind: 'STALE', startedAt: T + 3_600_000 });
  });

  it('does not call a lost connection a fault while the market is closed', () => {
    const monitor = make();
    monitor.onConnection(false, T);
    monitor.onMarket('CLOSED', T + 1);
    expect(monitor.evaluate(T + 100_000)).toEqual([]);
    // the provider is asked every 30 s and says the same: nothing changes
    expect(monitor.onMarket('CLOSED', T + 3_600_000)).toEqual([]);
    expect(monitor.currentState).toBe('MARKET_CLOSED');
    const open = monitor.onMarket('OPEN', T + 7_200_000);
    expect(states(open)).toEqual(['DISCONNECTED']);
    expect(first(monitor.evaluate(T + 7_205_000))).toMatchObject({
      kind: 'DISCONNECT',
      startedAt: T + 7_200_000,
    });
  });

  it('goes LIVE at once when ticks arrive, whatever the provider said last (the news of the opening is late)', () => {
    const monitor = make();
    monitor.onConnection(true, T);
    monitor.onMarket('CLOSED', T);
    const events = monitor.onTick(tick(T + 60_000));
    expect(states(events)).toEqual(['LIVE']);
    expect(incidents(events).map((i) => [i.phase, i.kind])).toEqual([['CLOSE', 'MARKET_STATE']]);
  });

  it('believes the provider for 120 s, and not longer', () => {
    const monitor = make();
    monitor.onConnection(true, T);
    monitor.onMarket('CLOSED', T);
    expect(monitor.evaluate(T + 120_000)).toEqual([]);
    expect(monitor.snapshot(T + 120_000).state).toBe('MARKET_CLOSED');
    expect(states(monitor.evaluate(T + 120_001))).toEqual(['STALE']);
  });

  it('is not closed because of an "unknown" answer', () => {
    const monitor = make();
    monitor.onConnection(true, T);
    monitor.onMarket('UNKNOWN', T);
    expect(monitor.currentState).toBe('STALE');
  });

  it('follows the weekly schedule when the provider has said nothing', () => {
    const monitor = new FeedMonitor();
    const events = monitor.onConnection(false, SAT);
    expect(states(events)).toEqual(['MARKET_CLOSED']);
    expect(incidents(events)).toEqual([
      {
        phase: 'OPEN',
        localId: 1,
        kind: 'MARKET_STATE',
        startedAt: SAT,
        endedAt: null,
        details: { reason: 'schedule', weekend: true },
      },
    ]);
  });

  it('keeps the weekend closed even when the provider says open and no tick comes', () => {
    const monitor = new FeedMonitor();
    monitor.onConnection(true, SAT);
    expect(monitor.onMarket('OPEN', SAT + 1)).toEqual([]);
    expect(monitor.currentState).toBe('MARKET_CLOSED');
  });

  it('says that the provider closed the market, also on a weekend, and that it is a weekend', () => {
    const monitor = new FeedMonitor();
    const events = monitor.onMarket('CLOSED', SAT);
    expect(first(events).details).toEqual({ reason: 'provider', weekend: true });
    expect(monitor.onConnection(true, SAT)).toEqual([]);
  });

  it('stays closed after the schedule says open while the provider says closed (Sunday evening)', () => {
    const monitor = new FeedMonitor();
    const sunday = Date.parse('2026-10-25T21:30:00Z');
    monitor.onConnection(true, sunday);
    monitor.onMarket('CLOSED', sunday);
    expect(monitor.currentState).toBe('MARKET_CLOSED');
    expect(monitor.snapshot(sunday + 60_000).state).toBe('MARKET_CLOSED');
  });

  it('uses the weekly closure of the core package by default', () => {
    expect(DEFAULT_MONITOR.isScheduledClosed).toBe(isWeekendClosure);
  });
});

describe('the numbers of the Health tab', () => {
  it('has nothing known before anything has happened', () => {
    expect(make().snapshot(T)).toEqual({
      state: 'DISCONNECTED',
      connected: false,
      marketState: 'UNKNOWN',
      newestTickTs: null,
      tickAgeMs: null,
      ticksPerSecond: null,
      clockSkewMs: null,
      providerStale: null,
      spread: null,
    });
  });

  it('describes a live feed', () => {
    const monitor = live();
    expect(monitor.snapshot(T + 3_500)).toEqual({
      state: 'LIVE',
      connected: true,
      marketState: 'OPEN',
      newestTickTs: T,
      tickAgeMs: 3_500,
      ticksPerSecond: 0.3,
      clockSkewMs: null,
      providerStale: null,
      spread: 0.18,
    });
  });

  it('gives an age of 0 for a tick stamped ahead of the clock, never a negative one', () => {
    const monitor = make();
    monitor.onConnection(true, T);
    monitor.onTick(tick(T + 5_000, { rxAt: T }));
    expect(monitor.snapshot(T).tickAgeMs).toBe(0);
  });

  it('takes the stale flag of the provider from its last answer about the market', () => {
    const monitor = live();
    monitor.onMarket('OPEN', T + 2_000, true);
    expect(monitor.snapshot(T + 2_000).providerStale).toBe(true);
    monitor.onMarket('OPEN', T + 3_000, false);
    expect(monitor.snapshot(T + 3_000).providerStale).toBe(false);
    monitor.onMarket('OPEN', T + 4_000);
    expect(monitor.snapshot(T + 4_000).providerStale).toBeNull();
  });

  it('says that the market is open when the provider says so even without a tick, and closed when it is', () => {
    const monitor = make();
    monitor.onConnection(true, T);
    monitor.onMarket('OPEN', T);
    expect(monitor.snapshot(T + 1_000).marketState).toBe('OPEN');
    monitor.onMarket('CLOSED', T + 2_000);
    expect(monitor.snapshot(T + 2_000).marketState).toBe('CLOSED');
  });

  describe('ticks per second', () => {
    it('counts the ticks of the last 30 seconds and divides by the time since the connection, at least one second', () => {
      const monitor = make();
      monitor.onConnection(true, T);
      for (let i = 1; i <= 20; i += 1)
        monitor.onTick(
          tick(T + i * 500 - SEC, {
            rxAt: T + i * 500,
            bid: 4000 + i / 100,
            ask: 4000.2 + i / 100,
          }),
        );
      // 20 ticks in 10 seconds
      expect(monitor.snapshot(T + 10_000).ticksPerSecond).toBe(2);
    });

    it('divides by at least one second, so that the first moments do not give a wild rate', () => {
      const monitor = make();
      monitor.onConnection(true, T);
      monitor.onTick(tick(T - 900, { rxAt: T + 100 }));
      expect(monitor.snapshot(T + 200).ticksPerSecond).toBe(1);
      monitor.onTick(tick(T - 800, { rxAt: T + 300, bid: 4001, ask: 4001.18 }));
      expect(monitor.snapshot(T + 300).ticksPerSecond).toBe(2);
      expect(monitor.snapshot(T + 2_000).ticksPerSecond).toBe(1);
    });

    it('leaves out a tick that is exactly as old as the window', () => {
      const monitor = make({ rateWindowMs: 10_000 });
      monitor.onConnection(true, T);
      monitor.onTick(tick(T, { rxAt: T + 1_000 }));
      monitor.onTick(tick(T + 4_000, { rxAt: T + 5_000, bid: 4001, ask: 4001.18 }));
      expect(monitor.snapshot(T + 10_999).ticksPerSecond).toBe(0.2);
      expect(monitor.snapshot(T + 11_000).ticksPerSecond).toBe(0.1);
    });

    it('does not start counting again when "connected" is said twice', () => {
      const monitor = make();
      monitor.onConnection(true, T);
      monitor.onTick(tick(T + 4_000));
      monitor.onConnection(true, T + 6_000);
      expect(monitor.snapshot(T + 10_000).ticksPerSecond).toBe(0.1);
    });

    it('divides by the whole window once the connection is older than the window', () => {
      const monitor = make();
      monitor.onConnection(true, T);
      for (let i = 0; i < 30; i += 1) {
        monitor.onTick(
          tick(T + i * SEC, { rxAt: T + i * SEC + 1, bid: 4000 + i / 100, ask: 4000.2 + i / 100 }),
        );
      }
      expect(monitor.snapshot(T + 60_000).ticksPerSecond).toBe(0);
      // at T + 30 s the 30 ticks at T+1 ... T+29001 are all inside the window of 30 s
      expect(monitor.snapshot(T + 30_000).ticksPerSecond).toBe(1);
      // a tick exactly 30 s old is outside the window
      expect(monitor.snapshot(T + 30_001).ticksPerSecond).toBe(1);
      expect(monitor.snapshot(T + 31_000).ticksPerSecond).toBe(1);
      expect(monitor.snapshot(T + 44_000).ticksPerSecond).toBe(0.5);
    });

    it('is null while disconnected and 0 when connected without ticks', () => {
      const monitor = make();
      expect(monitor.snapshot(T).ticksPerSecond).toBeNull();
      monitor.onConnection(true, T);
      expect(monitor.snapshot(T + 5_000).ticksPerSecond).toBe(0);
      monitor.onConnection(false, T + 6_000);
      expect(monitor.snapshot(T + 7_000).ticksPerSecond).toBeNull();
    });

    it('starts counting again from a new connection', () => {
      const monitor = live();
      monitor.onConnection(false, T + 2_000);
      monitor.onConnection(true, T + 20_000);
      expect(monitor.snapshot(T + 21_000).ticksPerSecond).toBe(0);
    });

    it('counts only the ticks of the judged symbol', () => {
      const monitor = make();
      monitor.onConnection(true, T);
      monitor.onTick(tick(T, { symbol: 'DXY' }));
      monitor.onTick(tick(T, { symbol: 'XAGUSD' }));
      expect(monitor.snapshot(T + 1_000).ticksPerSecond).toBe(0);
    });
  });
});

describe('the clock', () => {
  const make = (options: Partial<MonitorOptions> = {}) => plainMake({ ...QUIET, ...options });
  const samples = (monitor: FeedMonitor, skews: readonly number[], start = 0) => {
    const events: MonitorEvent[] = [];
    skews.forEach((skew, i) => {
      const ts = T + (start + i) * SEC;
      events.push(
        ...monitor.onTick(
          tick(ts, {
            rxAt: ts + skew,
            bid: 4000 + (start + i) / 100,
            ask: 4000.2 + (start + i) / 100,
          }),
        ),
      );
    });
    return events;
  };

  it('is not judged before 5 ticks have been seen', () => {
    const monitor = make();
    monitor.onConnection(true, T);
    samples(monitor, [1_000, 1_000, 1_000, 1_000]);
    expect(monitor.snapshot(T + 5_000).clockSkewMs).toBeNull();
    samples(monitor, [1_000], 4);
    expect(monitor.snapshot(T + 5_000).clockSkewMs).toBe(1_000);
  });

  it('is the median of the receive time minus the source time, so one odd tick does not matter', () => {
    const monitor = make();
    monitor.onConnection(true, T);
    samples(monitor, [1_000, 1_100, 900, 46_000_000, 1_000]);
    expect(monitor.snapshot(T + 5_000).clockSkewMs).toBe(1_000);
  });

  it('is the middle of the two middle values for an even number of ticks', () => {
    const monitor = make({ skewMinSamples: 4, skewSamples: 4 });
    monitor.onConnection(true, T);
    samples(monitor, [1_000, 2_000, 3_000, 4_000]);
    expect(monitor.snapshot(T + 5_000).clockSkewMs).toBe(2_500);
  });

  it('looks at the latest ticks only', () => {
    const monitor = make();
    monitor.onConnection(true, T);
    samples(
      monitor,
      Array.from({ length: 30 }, () => 9_000),
    );
    samples(
      monitor,
      Array.from({ length: 16 }, () => 1_000),
      30,
    );
    expect(monitor.snapshot(T + 60_000).clockSkewMs).toBe(1_000);
  });

  it('opens an incident when the skew reaches 5 s, and not at 4999 ms', () => {
    const calm = make();
    calm.onConnection(true, T);
    expect(incidents(samples(calm, [4_999, 4_999, 4_999, 4_999, 4_999]))).toEqual([]);

    const monitor = make();
    monitor.onConnection(true, T);
    const events = samples(monitor, [5_000, 5_000, 5_000, 5_000, 5_000]);
    expect(incidents(events).filter((i) => i.kind === 'CLOCK_SKEW')).toEqual([
      {
        phase: 'OPEN',
        localId: 1,
        kind: 'CLOCK_SKEW',
        startedAt: T + 4_000 + 5_000,
        endedAt: null,
        details: { skewMs: 5_000 },
      },
    ]);
  });

  it('also opens one for a skew in the other direction', () => {
    const monitor = make();
    monitor.onConnection(true, T);
    const events = samples(monitor, [-6_000, -6_000, -6_000, -6_000, -6_000]);
    expect(incidents(events).find((i) => i.kind === 'CLOCK_SKEW')?.details).toEqual({
      skewMs: -6_000,
    });
  });

  it('does not open a second one while the skew stays bad', () => {
    const monitor = make();
    monitor.onConnection(true, T);
    samples(monitor, [5_000, 5_000, 5_000, 5_000, 5_000]);
    expect(incidents(samples(monitor, [5_000, 7_000, 7_000], 5))).toEqual([]);
  });

  it('closes it when the skew is under half the limit, and keeps it open at exactly half', () => {
    const monitor = make({ skewSamples: 5 });
    monitor.onConnection(true, T);
    samples(monitor, [5_000, 5_000, 5_000, 5_000, 5_000]);
    expect(SKEW_RECOVER_FRACTION).toBe(0.5);
    // the window is now [5000, 5000, 2500, 2500, 2500]: the median is exactly half the limit
    expect(incidents(samples(monitor, [2_500, 2_500, 2_500], 5))).toEqual([]);
    expect(incidents(samples(monitor, [2_499], 8))).toEqual([]);
    expect(incidents(samples(monitor, [2_499], 9))).toEqual([]);
    const closed = incidents(samples(monitor, [2_499], 10));
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      phase: 'CLOSE',
      kind: 'CLOCK_SKEW',
      details: { skewMs: 5_000, peakSkewMs: 5_000 },
    });
  });

  it('remembers the worst skew of the incident', () => {
    const monitor = make({ skewSamples: 5 });
    monitor.onConnection(true, T);
    samples(monitor, [5_000, 5_000, 5_000, 5_000, 5_000]);
    samples(monitor, [8_000, 8_000, 8_000, 8_000, 8_000], 5);
    const closed = incidents(samples(monitor, [1_000, 1_000, 1_000, 1_000, 1_000], 10));
    expect(closed).toHaveLength(1);
    expect(closed[0]?.details).toEqual({ skewMs: 5_000, peakSkewMs: 8_000 });
  });

  it('keeps the sign of the worst skew', () => {
    const monitor = make({ skewSamples: 5 });
    monitor.onConnection(true, T);
    samples(monitor, [-5_000, -5_000, -5_000, -5_000, -5_000]);
    samples(monitor, [-9_000, -9_000, -9_000], 5);
    const closed = incidents(samples(monitor, [0, 0, 0, 0, 0], 8));
    expect(closed[0]?.details).toMatchObject({ peakSkewMs: -9_000 });
  });

  it('is not an incident when the limit is raised', () => {
    const monitor = make({ maxClockSkewMs: 20_000 });
    monitor.onConnection(true, T);
    expect(incidents(samples(monitor, [9_000, 9_000, 9_000, 9_000, 9_000]))).toEqual([]);
  });
});

describe('the spread', () => {
  const live = (options: Partial<MonitorOptions> = {}) => {
    const monitor = plainMake({ ...QUIET, ...options });
    monitor.onConnection(true, T);
    monitor.onTick(tick(T));
    return monitor;
  };
  const wide = (monitor: FeedMonitor, spread: number, at: number) =>
    monitor.onTick(tick(at - SEC, { rxAt: at, bid: 4000, ask: 4000 + spread }));

  it('opens a spike at 1 USD and not at 0.999', () => {
    const quiet = live();
    expect(incidents(wide(quiet, 0.999, T + 2_000))).toEqual([]);

    const monitor = live();
    expect(incidents(wide(monitor, 1, T + 2_000))).toEqual([
      {
        phase: 'OPEN',
        localId: 1,
        kind: 'SPREAD_SPIKE',
        startedAt: T + 2_000,
        endedAt: null,
        details: { peakSpread: 1 },
      },
    ]);
  });

  it('does not open a second one while the spike lasts, and remembers the widest spread', () => {
    const monitor = live();
    wide(monitor, 1.2, T + 2_000);
    expect(incidents(wide(monitor, 1.9, T + 3_000))).toEqual([]);
    expect(incidents(wide(monitor, 1.4, T + 4_000))).toEqual([]);
    const closed = incidents(monitor.evaluate(T + 14_000));
    expect(closed).toEqual([
      {
        phase: 'CLOSE',
        localId: 1,
        kind: 'SPREAD_SPIKE',
        startedAt: T + 2_000,
        endedAt: T + 4_000,
        details: { peakSpread: 1.9 },
      },
    ]);
  });

  it('ends 10 seconds after the last wide spread, dated at that spread', () => {
    const monitor = live();
    wide(monitor, 1.5, T + 2_000);
    expect(incidents(monitor.evaluate(T + 11_999))).toEqual([]);
    const closed = incidents(monitor.evaluate(T + 12_000));
    expect(closed[0]).toMatchObject({ phase: 'CLOSE', endedAt: T + 2_000 });
  });

  it('ends when a normal tick arrives after the calm time', () => {
    const monitor = live();
    wide(monitor, 1.5, T + 2_000);
    const events = monitor.onTick(tick(T + 12_000, { rxAt: T + 13_000, bid: 4001, ask: 4001.18 }));
    expect(incidents(events).map((i) => i.phase)).toEqual(['CLOSE']);
  });

  it('does not end while the spread is wide again within the calm time', () => {
    const monitor = live();
    wide(monitor, 1.5, T + 2_000);
    wide(monitor, 1.5, T + 11_000);
    expect(incidents(monitor.evaluate(T + 20_999))).toEqual([]);
    expect(incidents(monitor.evaluate(T + 21_000))).toHaveLength(1);
  });

  it('opens a new one after the first has ended', () => {
    const monitor = live();
    wide(monitor, 1.5, T + 2_000);
    monitor.evaluate(T + 13_000);
    expect(first(wide(monitor, 2, T + 20_000))).toMatchObject({ phase: 'OPEN', localId: 2 });
  });

  it('uses the limit and the calm time from the options', () => {
    const monitor = live({ spreadSpikeUsd: 0.5, spreadCalmMs: 1_000 });
    expect(incidents(wide(monitor, 0.5, T + 2_000))).toHaveLength(1);
    expect(incidents(monitor.evaluate(T + 3_000))).toHaveLength(1);
  });

  it('is the spread of the newest tick in the snapshot, rounded to a thousandth', () => {
    const monitor = live();
    monitor.onTick(tick(T + 1_000, { bid: 4000.001, ask: 4000.203 }));
    expect(monitor.snapshot(T + 3_000).spread).toBe(0.202);
  });
});

describe('the options', () => {
  it('are the numbers of the documents', () => {
    expect({ ...DEFAULT_MONITOR, isScheduledClosed: null }).toEqual({
      symbol: 'XAUUSD',
      maxTickAgeMs: 10_000,
      maxClockSkewMs: 5_000,
      spreadSpikeUsd: 1,
      spreadCalmMs: 10_000,
      incidentGraceMs: 5_000,
      rateWindowMs: 30_000,
      skewSamples: 30,
      skewMinSamples: 5,
      marketInfoMaxAgeMs: 120_000,
      isScheduledClosed: null,
    });
  });
});
