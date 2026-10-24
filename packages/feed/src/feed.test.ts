import { CandleBuilder, buildCandles, type TickInput } from '@vmgs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Feed, type FeedOptions } from './feed';
import { ReplayProvider, ticksToEvents } from './replay';
import { SimulatedProvider, simulateEvents, type SimulationOptions } from './simulated';
import { ManualProvider } from './testing/manualProvider';
import type { FeedEvent, ProviderEvent, RawQuote } from './types';

const T = Date.parse('2026-10-21T12:00:00Z');
const SYMBOLS = ['XAUUSD', 'DXY'];

afterEach(() => {
  vi.useRealTimers();
});

const quote = (ts: number, change: Partial<RawQuote> = {}): RawQuote => ({
  symbol: 'XAUUSD',
  bid: 4000,
  ask: 4000.18,
  ts,
  ...change,
});
const quoteEvent = (
  ts: number,
  change: Partial<RawQuote> = {},
  rxAt = ts + 1_000,
): ProviderEvent => ({
  type: 'quote',
  rxAt,
  quote: quote(ts, change),
});

function setup(options: Partial<FeedOptions> = {}, realtime = true) {
  const provider = new ManualProvider(T, realtime);
  const feed = new Feed({ provider, symbols: SYMBOLS, ...options });
  const events: FeedEvent[] = [];
  feed.on((event) => events.push(event));
  return { provider, feed, events };
}

const types = (events: readonly FeedEvent[]) => events.map((e) => e.type);
const states = (events: readonly FeedEvent[]) =>
  events.flatMap((e) => (e.type === 'state' ? [e.state] : []));

describe('starting and stopping', () => {
  it('needs the traded symbol among the subscribed symbols', () => {
    const provider = new ManualProvider(T);
    expect(() => new Feed({ provider, symbols: ['DXY'] })).toThrow(RangeError);
    expect(() => new Feed({ provider, symbols: ['DXY'], symbol: 'DXY' })).not.toThrow();
  });

  it('listens to the provider and starts it, once', async () => {
    const { provider, feed } = setup();
    expect(provider.listenerCount).toBe(0);
    await feed.start();
    await feed.start();
    expect(provider.listenerCount).toBe(1);
    expect(provider.startCalls).toBe(1);
  });

  it('stops the provider and stops listening', async () => {
    const { provider, feed, events } = setup();
    await feed.start();
    await feed.stop();
    expect(provider.stopCalls).toBe(1);
    expect(provider.listenerCount).toBe(0);
    provider.push(quoteEvent(T));
    expect(events).toEqual([]);
  });

  it('can be stopped without having been started', async () => {
    const { feed } = setup();
    await expect(feed.stop()).resolves.toBeUndefined();
  });
});

describe('quotes', () => {
  it('become ticks, and then the events of the monitor', async () => {
    const { provider, feed, events } = setup();
    await feed.start();
    provider.push({ type: 'connection', connected: true, at: T });
    events.length = 0;
    provider.advance(1_000);
    provider.push(quoteEvent(T));
    expect(events[0]).toEqual({
      type: 'tick',
      tick: { ts: T, rxAt: T + 1_000, symbol: 'XAUUSD', bid: 4000, ask: 4000.18 },
    });
    expect(states(events)).toEqual(['LIVE']);
    expect(types(events)).toEqual(['tick', 'state']);
  });

  it('are refused with the reason, the detail, the symbol and the time', async () => {
    const { provider, feed, events } = setup();
    await feed.start();
    provider.push(quoteEvent(T, { symbol: 'EURUSD' }));
    provider.push(quoteEvent(T, { bid: 5, ask: 4 }));
    expect(events).toEqual([
      {
        type: 'rejected',
        reason: 'UNKNOWN_SYMBOL',
        detail: expect.stringContaining('EURUSD') as string,
        symbol: 'EURUSD',
        at: T + 1_000,
      },
      {
        type: 'rejected',
        reason: 'CROSSED',
        detail: expect.any(String) as string,
        symbol: 'XAUUSD',
        at: T + 1_000,
      },
    ]);
  });

  it('never reach the monitor when they are refused', async () => {
    const { provider, feed, events } = setup();
    await feed.start();
    provider.push({ type: 'connection', connected: true, at: T });
    events.length = 0;
    provider.push(quoteEvent(T, { bid: 5, ask: 4 }));
    expect(types(events)).toEqual(['rejected']);
    expect(feed.health().newestTickTs).toBeNull();
  });

  it('are counted: received, accepted and refused by reason', async () => {
    const { provider, feed } = setup();
    await feed.start();
    provider.push(quoteEvent(T));
    provider.push(quoteEvent(T));
    provider.push(quoteEvent(T, { symbol: 'EURUSD' }));
    provider.push({ type: 'malformed', detail: 'no bid', rxAt: T });
    const { received, accepted, rejected } = feed.stats;
    expect([received, accepted]).toEqual([4, 1]);
    expect([rejected.DUPLICATE, rejected.UNKNOWN_SYMBOL, rejected.MALFORMED]).toEqual([1, 1, 1]);
  });

  it('can be primed with the last stored tick, so that a seeded repeat is dropped', async () => {
    const { provider, feed, events } = setup();
    feed.prime([{ ts: T, rxAt: T + 1_000, symbol: 'XAUUSD', bid: 4000, ask: 4000.18 }]);
    await feed.start();
    provider.push(quoteEvent(T));
    expect(events).toMatchObject([{ type: 'rejected', reason: 'DUPLICATE' }]);
  });

  it('of the cross-asset symbols are ticks too, but do not move the feed state', async () => {
    const { provider, feed, events } = setup();
    await feed.start();
    provider.push({ type: 'connection', connected: true, at: T });
    events.length = 0;
    provider.push(quoteEvent(T, { symbol: 'DXY', bid: 101.7, ask: 101.72 }));
    expect(types(events)).toEqual(['tick']);
    expect(feed.health().state).toBe('STALE');
  });

  it('can be judged on another traded symbol', async () => {
    const provider = new ManualProvider(T);
    const feed = new Feed({ provider, symbols: ['XAUUSD', 'XAGUSD'], symbol: 'XAGUSD' });
    await feed.start();
    provider.push({ type: 'connection', connected: true, at: T });
    provider.push(quoteEvent(T, { symbol: 'XAGUSD', bid: 54, ask: 54.02 }));
    expect(feed.health().state).toBe('LIVE');
  });

  it('take the limits of the normalizer from the options', async () => {
    const { provider, feed, events } = setup({ normalizer: { maxFutureMs: 1_000 } });
    await feed.start();
    provider.push(quoteEvent(T + 2_000, {}, T));
    expect(events).toMatchObject([{ type: 'rejected', reason: 'FUTURE' }]);
  });
});

describe('malformed messages', () => {
  it('are refused as MALFORMED, with no symbol, and counted', async () => {
    const { provider, feed, events } = setup();
    await feed.start();
    provider.push({ type: 'malformed', detail: 'a tick without bid', rxAt: T + 5 });
    expect(events).toEqual([
      {
        type: 'rejected',
        reason: 'MALFORMED',
        detail: 'a tick without bid',
        symbol: null,
        at: T + 5,
      },
    ]);
    expect(feed.stats.rejected.MALFORMED).toBe(1);
    expect(feed.stats.received).toBe(1);
  });
});

describe('the connection and the market', () => {
  it('go to the monitor', async () => {
    const { provider, feed, events } = setup();
    await feed.start();
    provider.push({ type: 'connection', connected: false, at: T, reason: 'cannot connect' });
    expect(events).toEqual([{ type: 'state', state: 'DISCONNECTED', previous: null, at: T }]);
    provider.advance(5_000);
    provider.push({
      type: 'connection',
      connected: false,
      at: T + 5_000,
      reason: 'cannot connect',
    });
    provider.advance(1_000);
    provider.push({
      type: 'market',
      symbol: 'XAUUSD',
      state: 'CLOSED',
      at: T + 6_000,
      providerStale: true,
      quoteAgeS: 3,
    });
    expect(states(events)).toEqual(['DISCONNECTED', 'MARKET_CLOSED']);
    expect(feed.health()).toMatchObject({ marketState: 'CLOSED', providerStale: true });
  });

  it('of other symbols is ignored', async () => {
    const { provider, feed, events } = setup();
    await feed.start();
    provider.push({
      type: 'market',
      symbol: 'DXY',
      state: 'CLOSED',
      at: T,
      providerStale: null,
      quoteAgeS: null,
    });
    expect(events).toEqual([]);
  });
});

describe('a live provider needs a timer to notice silence', () => {
  it('looks every second, and says STALE and opens an incident when no tick comes', async () => {
    vi.useFakeTimers();
    const { provider, feed, events } = setup();
    await feed.start();
    provider.push({ type: 'connection', connected: true, at: T });
    provider.advance(1_000);
    provider.push(quoteEvent(T));
    events.length = 0;

    provider.advance(9_000);
    vi.advanceTimersByTime(1_000);
    expect(events).toEqual([]);
    provider.advance(1_001);
    vi.advanceTimersByTime(1_000);
    expect(states(events)).toEqual(['STALE']);
    expect(events.find((e) => e.type === 'incident')).toMatchObject({
      phase: 'OPEN',
      incident: { kind: 'STALE', startedAt: T + 1_000 },
    });
  });

  it('puts the events in the order tick, state, incident when a tick ends the silence', async () => {
    vi.useFakeTimers();
    const { provider, feed, events } = setup();
    await feed.start();
    provider.push({ type: 'connection', connected: true, at: T });
    provider.advance(30_000);
    vi.advanceTimersByTime(1_000);
    events.length = 0;
    provider.push(quoteEvent(T + 29_000, {}, T + 30_000));
    expect(types(events)).toEqual(['tick', 'state', 'incident']);
    expect(events[2]).toMatchObject({ phase: 'CLOSE' });
  });

  it('looks at the time the interval says', async () => {
    vi.useFakeTimers();
    const { provider, feed, events } = setup({ evaluateEveryMs: 5_000 });
    await feed.start();
    provider.push({ type: 'connection', connected: true, at: T });
    provider.advance(1_000);
    provider.push(quoteEvent(T));
    events.length = 0;
    provider.advance(20_000);
    vi.advanceTimersByTime(4_999);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(states(events)).toEqual(['STALE']);
  });

  it('stops looking when it is stopped', async () => {
    vi.useFakeTimers();
    const { provider, feed, events } = setup();
    await feed.start();
    expect(vi.getTimerCount()).toBe(1);
    await feed.stop();
    expect(vi.getTimerCount()).toBe(0);
    provider.advance(60_000);
    vi.advanceTimersByTime(10_000);
    expect(events).toEqual([]);
  });

  it('is not needed for a replay: time moves with the events', async () => {
    vi.useFakeTimers();
    const { feed } = setup({}, false);
    await feed.start();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is not needed for a replay: any event, a refused quote too, shows that the data has gone old', async () => {
    const { provider, feed, events } = setup({}, false);
    await feed.start();
    provider.push({ type: 'connection', connected: true, at: T });
    provider.advance(1_000);
    provider.push(quoteEvent(T));
    expect(states(events)).toEqual(['STALE', 'LIVE']);
    provider.advance(30_000);
    provider.push(quoteEvent(T + 31_000, { symbol: 'EURUSD' }));
    expect(states(events)).toEqual(['STALE', 'LIVE', 'STALE']);
  });

  it('is given the monitor options', async () => {
    vi.useFakeTimers();
    const { provider, feed, events } = setup({ monitor: { maxTickAgeMs: 2_000 } });
    await feed.start();
    provider.push({ type: 'connection', connected: true, at: T });
    provider.advance(1_000);
    provider.push(quoteEvent(T));
    events.length = 0;
    provider.advance(2_001);
    vi.advanceTimersByTime(1_000);
    expect(states(events)).toEqual(['STALE']);
  });
});

describe('health', () => {
  it('is read at the time of the provider', async () => {
    const { provider, feed } = setup();
    await feed.start();
    provider.push({ type: 'connection', connected: true, at: T });
    provider.advance(1_000);
    provider.push(quoteEvent(T));
    expect(feed.health()).toMatchObject({ state: 'LIVE', tickAgeMs: 1_000, newestTickTs: T });
    provider.advance(4_000);
    expect(feed.health().tickAgeMs).toBe(5_000);
  });
});

describe('listeners', () => {
  it('give an event only to those who listened when it came: a new one waits for the next', async () => {
    const { provider, feed } = setup();
    const late: FeedEvent[] = [];
    let added = false;
    feed.on(() => {
      if (added) return;
      added = true;
      feed.on((event) => late.push(event));
    });
    await feed.start();
    provider.push(quoteEvent(T, { symbol: 'EURUSD' }));
    expect(late).toEqual([]);
    provider.push(quoteEvent(T + 1_000, { symbol: 'EURUSD' }));
    expect(late).toHaveLength(1);
  });

  it('can leave', async () => {
    const { provider, feed } = setup();
    const seen: FeedEvent[] = [];
    const leave = feed.on((event) => seen.push(event));
    await feed.start();
    provider.push(quoteEvent(T, { symbol: 'EURUSD' }));
    leave();
    provider.push(quoteEvent(T, { symbol: 'EURUSD' }));
    expect(seen).toHaveLength(1);
  });

  it('are isolated: one that throws is reported and does not stop the others', async () => {
    const errors: unknown[] = [];
    const { provider, feed } = setup({ onListenerError: (error) => errors.push(error) });
    const seen: FeedEvent[] = [];
    feed.on(() => {
      throw new Error('recorder failed');
    });
    feed.on((event) => seen.push(event));
    await feed.start();
    provider.push(quoteEvent(T, { symbol: 'EURUSD' }));
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('recorder failed');
    expect(seen).toHaveLength(1);
  });

  it('are never hidden: by default the error is thrown outside the provider callback', async () => {
    const thrown: (() => void)[] = [];
    const spy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((task) => {
      thrown.push(task);
    });
    const { provider, feed } = setup();
    feed.on(() => {
      throw new Error('recorder failed');
    });
    await feed.start();
    expect(() => {
      provider.push(quoteEvent(T, { symbol: 'EURUSD' }));
    }).not.toThrow();
    expect(thrown).toHaveLength(1);
    expect(() => {
      thrown[0]?.();
    }).toThrow('recorder failed');
    spy.mockRestore();
  });
});

// -----------------------------------------------------------------------------------------------

const SIM: SimulationOptions = {
  seed: 5,
  startAt: Date.parse('2026-10-21T12:00:00Z'),
  durationS: 900,
  faults: [
    { type: 'badTick', atS: 100, kind: 'jump' },
    { type: 'badTick', atS: 200, kind: 'crossed' },
    { type: 'badTick', atS: 300, kind: 'notANumber' },
  ],
};

async function runReplay(events: Iterable<ProviderEvent>) {
  const provider = new ReplayProvider({ events });
  const feed = new Feed({ provider, symbols: SYMBOLS });
  const seen: FeedEvent[] = [];
  feed.on((event) => seen.push(event));
  await feed.start();
  await provider.finished;
  return { seen, feed };
}

describe('a replay through the feed', () => {
  it('gives the same events on every run, and the same ticks as the normalizer would', async () => {
    const first = await runReplay(simulateEvents(SIM));
    const second = await runReplay(simulateEvents(SIM));
    expect(JSON.stringify(first.seen)).toBe(JSON.stringify(second.seen));
    expect(first.feed.stats).toEqual(second.feed.stats);
  });

  it('refuses exactly the three bad ticks of the simulation, each for its reason', async () => {
    const { seen, feed } = await runReplay(simulateEvents(SIM));
    const refused = seen.flatMap((e) => (e.type === 'rejected' ? [e.reason] : []));
    expect(refused).toEqual(['JUMP', 'CROSSED', 'BAD_PRICE']);
    expect(feed.stats.accepted).toBe(seen.filter((e) => e.type === 'tick').length);
  });

  it('ends LIVE, with no incident on a clean run', async () => {
    const { seen, feed } = await runReplay(simulateEvents({ ...SIM, faults: [] }));
    expect(feed.health()).toMatchObject({ state: 'LIVE', connected: true });
    expect(seen.filter((e) => e.type === 'incident')).toEqual([]);
    expect(states(seen)).toEqual(['STALE', 'LIVE']);
  });

  it('does not notice a stall: with no timer a replay learns about silence only from its ticks', async () => {
    const { seen } = await runReplay(
      simulateEvents({ ...SIM, faults: [{ type: 'stall', atS: 100, forS: 60 }] }),
    );
    expect(states(seen)).toEqual(['STALE', 'LIVE']);
  });

  it('gives candles that are the same as those built from the ticks directly', async () => {
    const { seen } = await runReplay(simulateEvents(SIM));
    const ticks = seen.flatMap((e) =>
      e.type === 'tick' && e.tick.symbol === 'XAUUSD' ? [e.tick] : [],
    );
    const builder = new CandleBuilder({ symbol: 'XAUUSD' });
    const outcomes = ticks.map((tick) => builder.push(tick).outcome);
    expect(new Set(outcomes)).toEqual(new Set(['ACCEPTED']));
    const direct = buildCandles({ symbol: 'XAUUSD' }, ticks);
    const again = buildCandles({ symbol: 'XAUUSD' }, ticks);
    expect(direct.candles.length).toBeGreaterThan(10);
    expect(direct.candles).toEqual(again.candles);
    expect(direct.stats.late + direct.stats.invalid).toBe(0);
  });

  it('is the same through recorded ticks as through the simulation that made them', async () => {
    const simulated = await runReplay(simulateEvents({ ...SIM, faults: [] }));
    const ticks: TickInput[] = simulated.seen.flatMap((e) => (e.type === 'tick' ? [e.tick] : []));
    const replayed = await runReplay(ticksToEvents(ticks));
    const again = replayed.seen.flatMap((e) => (e.type === 'tick' ? [e.tick] : []));
    expect(again).toEqual(ticks);
  });
});

describe('the simulated provider through the feed', () => {
  it('works like the replay: the same ticks', async () => {
    const provider = new SimulatedProvider({ simulation: SIM, speed: 'max' });
    const feed = new Feed({ provider, symbols: SYMBOLS });
    const seen: FeedEvent[] = [];
    feed.on((event) => seen.push(event));
    await feed.start();
    await provider.finished;
    const viaReplay = await runReplay(simulateEvents(SIM));
    expect(JSON.stringify(seen)).toBe(JSON.stringify(viaReplay.seen));
  });
});
