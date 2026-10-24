import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BiquoteProvider,
  parseProviderTimestamp,
  toMarketState,
  type BiquoteOptions,
} from './biquote';
import { Feed } from './feed';
import { FakeSignalRServer } from './testing/fakeSignalR';
import type { FeedEvent, ProviderEvent } from './types';

let server: FakeSignalRServer;
let provider: BiquoteProvider | null = null;
let feed: Feed | null = null;

beforeEach(async () => {
  server = await FakeSignalRServer.start();
});

afterEach(async () => {
  await feed?.stop();
  feed = null;
  await provider?.stop();
  provider = null;
  await server.stop();
});

/** The real tick of the Biquote hub, as the probe of 2026-10-23 saw it. */
const goldTick = (change: Record<string, unknown> = {}) => ({
  symbol: 'XAUUSD',
  bid: 3995.856,
  ask: 3996.038,
  last: 0,
  volume: 0,
  timestamp: '2026-10-23T20:57:46Z',
  source: 'MetaTrader 5 (Broker 1)',
  high: 4034.46,
  low: 3975.401,
  direction: 'DOWN',
  dayDiffPercent: -3.1418,
  description: 'Gold vs US Dollar',
  time: '2026.10.23 20:57:46',
  exchange: 'COMEX',
  spread: 0.182,
  mid: 3995.947,
  ...change,
});

async function waitFor(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fast = { initialMs: 20, factor: 2, capMs: 200, jitter: 0 } as const;

/** A Wednesday: the weekly closure must not decide what these tests see. The clock runs in real time. */
const WEDNESDAY = Date.parse('2026-10-21T12:00:00Z');
function weekdayClock() {
  const start = Date.now();
  return { now: () => WEDNESDAY + (Date.now() - start) };
}

/** A clock that only moves when the test says so, for the limits that real timers cannot hit exactly. */
function handClock() {
  let at = WEDNESDAY;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

interface Made {
  readonly source: BiquoteProvider;
  readonly events: ProviderEvent[];
  readonly logs: { level: string; message: string; data?: Record<string, unknown> }[];
}

function make(extra: Partial<BiquoteOptions> = {}): Made {
  const logs: Made['logs'] = [];
  const source = new BiquoteProvider({
    symbols: ['XAUUSD', 'DXY'],
    baseUrl: server.baseUrl,
    backoff: fast,
    marketPollMs: 0,
    watchdogEveryMs: 20,
    clock: weekdayClock(),
    log: (level, message, data) => logs.push({ level, message, ...(data ? { data } : {}) }),
    ...extra,
  });
  provider = source;
  const events: ProviderEvent[] = [];
  source.subscribe((event) => events.push(event));
  return { source, events, logs };
}

const connections = (events: readonly ProviderEvent[]) =>
  events.flatMap((e) => (e.type === 'connection' ? [e] : []));
const quotes = (events: readonly ProviderEvent[]) =>
  events.flatMap((e) => (e.type === 'quote' ? [e] : []));
const markets = (events: readonly ProviderEvent[]) =>
  events.flatMap((e) => (e.type === 'market' ? [e] : []));

const gaps = (times: readonly number[]) => times.slice(1).map((t, i) => t - (times[i] ?? 0));

describe('connecting', () => {
  it('connects, subscribes to every symbol once and says that it is connected', async () => {
    const { source, events } = make();
    await source.start();
    await waitFor(() => connections(events).length === 1, 'the connection');
    expect(connections(events)).toEqual([
      { type: 'connection', connected: true, at: expect.any(Number) as number },
    ]);
    expect(server.subscribes.map((s) => s.symbols)).toEqual([['XAUUSD', 'DXY']]);
    expect(server.negotiates).toHaveLength(1);
  });

  it('is a realtime provider with a wall clock', () => {
    const source = new BiquoteProvider({ symbols: ['XAUUSD'], baseUrl: server.baseUrl });
    expect(source.name).toBe('biquote');
    expect(source.realtime).toBe(true);
    expect(Math.abs(source.clock.now() - Date.now())).toBeLessThan(50);
  });

  it('does not connect twice when started twice', async () => {
    const { source, events } = make();
    await source.start();
    await source.start();
    await waitFor(() => connections(events).length === 1, 'the connection');
    await pause(100);
    expect(server.negotiates).toHaveLength(1);
  });

  it('needs at least one symbol', () => {
    expect(() => new BiquoteProvider({ symbols: [] })).toThrow(RangeError);
  });

  it('logs that it connected', async () => {
    const { source, logs } = make();
    await source.start();
    await waitFor(() => logs.some((l) => l.message === 'connected'), 'the log line');
    expect(logs.find((l) => l.message === 'connected')?.level).toBe('info');
  });

  it('accepts a base URL with a slash at the end', async () => {
    const { source, events } = make({ baseUrl: `${server.baseUrl}///` });
    await source.start();
    await waitFor(() => connections(events).length === 1, 'the connection');
  });
});

describe('ticks', () => {
  it('become quotes with the source time in milliseconds and the receive time from the clock', async () => {
    const { source, events } = make({ clock: { now: () => 1_700_000_000_000 } });
    await source.start();
    await waitFor(() => server.subscribes.length === 1, 'the subscription');
    server.sendTick(goldTick());
    await waitFor(() => quotes(events).length === 1, 'the quote');
    expect(quotes(events)[0]).toEqual({
      type: 'quote',
      rxAt: 1_700_000_000_000,
      quote: {
        symbol: 'XAUUSD',
        bid: 3995.856,
        ask: 3996.038,
        ts: Date.parse('2026-10-23T20:57:46Z'),
      },
    });
  });

  it('keep the symbol, so that the cross-asset ticks are told apart', async () => {
    const { source, events } = make();
    await source.start();
    await waitFor(() => server.subscribes.length === 1, 'the subscription');
    server.sendTick(goldTick({ symbol: 'DXY', bid: 101.733, ask: 101.749 }));
    await waitFor(() => quotes(events).length === 1, 'the quote');
    expect(quotes(events)[0]?.quote.symbol).toBe('DXY');
  });

  it('ignore the fields they do not need, and a time with milliseconds is fine', async () => {
    const { source, events } = make();
    await source.start();
    await waitFor(() => server.subscribes.length === 1, 'the subscription');
    server.sendTick({
      symbol: 'XAUUSD',
      bid: 1,
      ask: 2,
      timestamp: '2026-10-23T20:57:46.250Z',
      somethingNew: { nested: true },
    });
    await waitFor(() => quotes(events).length === 1, 'the quote');
    expect(quotes(events)[0]?.quote.ts).toBe(Date.parse('2026-10-23T20:57:46.250Z'));
  });

  it('that cannot be read are reported as malformed, and the next good one still comes through', async () => {
    const { source, events } = make();
    await source.start();
    await waitFor(() => server.subscribes.length === 1, 'the subscription');
    server.sendTick(goldTick({ bid: undefined }));
    server.sendTick(goldTick({ bid: '3995.856' }));
    server.sendTick(goldTick({ timestamp: undefined }));
    server.sendTick(goldTick({ timestamp: '2026-10-23T20:57:46' }));
    server.sendTick(goldTick({ timestamp: 'yesterday' }));
    server.sendTick(goldTick());
    await waitFor(() => quotes(events).length === 1, 'the good quote');
    const malformed = events.filter((e) => e.type === 'malformed');
    expect(malformed).toHaveLength(5);
    expect(malformed[0]).toMatchObject({ detail: expect.stringContaining('without') as string });
    expect(malformed[3]).toMatchObject({ detail: expect.stringContaining('no zone') as string });
  });

  it('that are not objects are malformed too', async () => {
    const { source, events } = make();
    await source.start();
    await waitFor(() => server.subscribes.length === 1, 'the subscription');
    const [connection] = [...server.connections];
    if (!connection) throw new Error('no connection');
    server.invoke(connection, 'ReceiveTick', ['not an object']);
    server.invoke(connection, 'ReceiveTick', []);
    await waitFor(() => events.filter((e) => e.type === 'malformed').length === 2, 'two reports');
  });
});

describe('the market state', () => {
  it('is read from the hub after subscribing, for every symbol', async () => {
    server.onSubscribe = (connection) => {
      server.invoke(connection, 'ReceiveSubscriptionState', [
        [
          { symbol: 'XAUUSD', state: 'closed', quoteAgeSeconds: 46324, seeded: true },
          { symbol: 'DXY', state: 'open', quoteAgeSeconds: 0, seeded: true },
        ],
      ]);
    };
    const { source, events } = make({ clock: { now: () => 5_000 } });
    await source.start();
    await waitFor(() => markets(events).length === 2, 'the market states');
    expect(markets(events)).toEqual([
      {
        type: 'market',
        symbol: 'XAUUSD',
        state: 'CLOSED',
        at: 5_000,
        providerStale: null,
        quoteAgeS: 46324,
      },
      {
        type: 'market',
        symbol: 'DXY',
        state: 'OPEN',
        at: 5_000,
        providerStale: null,
        quoteAgeS: 0,
      },
    ]);
  });

  it('is unknown for a word that is not open or closed, and has no age when none is sent', async () => {
    server.onSubscribe = (connection) => {
      server.invoke(connection, 'ReceiveSubscriptionState', [
        [{ symbol: 'XAUUSD', state: 'halted' }],
      ]);
    };
    const { source, events } = make();
    await source.start();
    await waitFor(() => markets(events).length === 1, 'the market state');
    expect(markets(events)[0]).toMatchObject({ state: 'UNKNOWN', quoteAgeS: null });
  });

  it('is ignored, with a warning, when it cannot be read', async () => {
    server.onSubscribe = (connection) => {
      server.invoke(connection, 'ReceiveSubscriptionState', ['nonsense']);
    };
    const { source, events, logs } = make();
    await source.start();
    await waitFor(() => logs.some((l) => l.level === 'warn'), 'the warning');
    expect(markets(events)).toEqual([]);
  });

  describe('from the REST API', () => {
    it('is polled for the traded symbol and says whether the provider thinks the quote is stale', async () => {
      server.rest.set('XAUUSD', {
        status: 200,
        body: { symbol: 'XAUUSD', marketState: 'closed', stale: true, quoteAgeSeconds: 46525 },
      });
      const { source, events } = make({ marketPollMs: 30, clock: { now: () => 7_000 } });
      await source.start();
      await waitFor(() => markets(events).length >= 2, 'two polls');
      expect(markets(events)[0]).toEqual({
        type: 'market',
        symbol: 'XAUUSD',
        state: 'CLOSED',
        at: 7_000,
        providerStale: true,
        quoteAgeS: 46525,
      });
      expect(new Set(server.restHits.map((h) => h.symbol))).toEqual(new Set(['XAUUSD']));
    });

    it('polls at once, and then at the interval', async () => {
      const { source } = make({ marketPollMs: 60 });
      await source.start();
      await waitFor(() => server.restHits.length >= 1, 'the first poll');
      expect(server.restHits.length).toBeLessThan(3);
      await waitFor(() => server.restHits.length >= 3, 'three polls');
    });

    it('can be switched off', async () => {
      const { source, events } = make({ marketPollMs: 0 });
      await source.start();
      await waitFor(() => connections(events).length === 1, 'the connection');
      await pause(100);
      expect(server.restHits).toEqual([]);
    });

    it('polls the watched symbol: the traded one by default, the first one otherwise, or the one asked for', async () => {
      const first = make({ marketPollMs: 1_000 });
      await first.source.start();
      await waitFor(() => server.restHits.length === 1, 'the poll');
      expect(server.restHits[0]?.symbol).toBe('XAUUSD');
      await first.source.stop();

      const other = make({ symbols: ['DXY', 'XAGUSD'], marketPollMs: 1_000 });
      await other.source.start();
      await waitFor(() => server.restHits.length === 2, 'the second poll');
      expect(server.restHits[1]?.symbol).toBe('DXY');
      await other.source.stop();

      const chosen = make({
        symbols: ['DXY', 'XAGUSD'],
        watchSymbol: 'XAGUSD',
        marketPollMs: 1_000,
      });
      await chosen.source.start();
      await waitFor(() => server.restHits.length === 3, 'the third poll');
      expect(server.restHits[2]?.symbol).toBe('XAGUSD');
    });

    it('says nothing, and logs a line, when the answer is an error or cannot be read', async () => {
      server.rest.set('XAUUSD', { status: 500, body: { error: 'boom' } });
      const { source, events, logs } = make({ marketPollMs: 30 });
      await source.start();
      await waitFor(
        () => logs.filter((l) => l.message === 'market state not read').length >= 2,
        'the logs',
      );
      expect(markets(events)).toEqual([]);

      server.rest.set('XAUUSD', { status: 200, body: { nothing: 'useful' } });
      const before = logs.length;
      await waitFor(() => logs.length > before, 'another log');
      expect(markets(events)).toEqual([]);
      expect(logs.every((l) => l.level === 'debug' || l.level === 'info')).toBe(true);
    });

    it('does not trust the body of an error answer', async () => {
      server.rest.set('XAUUSD', {
        status: 500,
        body: { marketState: 'closed', stale: true, quoteAgeSeconds: 5 },
      });
      const { source, events, logs } = make({ marketPollMs: 30 });
      await source.start();
      await waitFor(() => logs.some((l) => l.message === 'market state not read'), 'the log');
      expect(markets(events)).toEqual([]);
      expect(logs.find((l) => l.message === 'market state not read')?.data).toEqual({
        reason: 'HTTP 500',
      });
    });

    it('goes on after a failure: the next good answer is used', async () => {
      server.rest.set('XAUUSD', { status: 503, body: {} });
      const { source, events } = make({ marketPollMs: 30 });
      await source.start();
      await waitFor(() => server.restHits.length >= 2, 'two failed polls');
      server.rest.set('XAUUSD', {
        status: 200,
        body: { marketState: 'open', stale: false, quoteAgeSeconds: 0 },
      });
      await waitFor(() => markets(events).length >= 1, 'a good poll');
      expect(markets(events)[0]).toMatchObject({ state: 'OPEN', providerStale: false });
    });

    it('stops polling when stopped', async () => {
      const { source } = make({ marketPollMs: 30 });
      await source.start();
      await waitFor(() => server.restHits.length >= 2, 'two polls');
      await source.stop();
      const hits = server.restHits.length;
      await pause(150);
      expect(server.restHits.length).toBe(hits);
    });
  });
});

describe('losing the connection', () => {
  it('says so, connects again and subscribes again', async () => {
    const { source, events } = make();
    await source.start();
    await waitFor(() => connections(events).length === 1, 'the connection');
    server.dropAll();
    await waitFor(() => connections(events).length === 3, 'the reconnection');
    expect(connections(events).map((c) => c.connected)).toEqual([true, false, true]);
    expect(connections(events)[1]?.reason).toEqual(expect.any(String));
    expect(server.negotiates).toHaveLength(2);
    expect(server.subscribes.map((s) => s.symbols)).toEqual([
      ['XAUUSD', 'DXY'],
      ['XAUUSD', 'DXY'],
    ]);
    expect(new Set(server.subscribes.map((s) => s.connectionId)).size).toBe(2);
  });

  it('gets the ticks again after it has reconnected', async () => {
    const { source, events } = make();
    await source.start();
    await waitFor(() => connections(events).length === 1, 'the connection');
    server.dropAll();
    await waitFor(() => connections(events).length === 3, 'the reconnection');
    await waitFor(() => server.subscribes.length === 2, 'the second subscription');
    server.sendTick(goldTick());
    await waitFor(() => quotes(events).length === 1, 'the quote');
  });

  it('reconnects after the server has closed the connection on purpose', async () => {
    const { source, events } = make();
    await source.start();
    await waitFor(() => connections(events).length === 1, 'the connection');
    server.closeAll();
    await waitFor(() => connections(events).length === 3, 'the reconnection');
  });

  it('logs the loss and the wait', async () => {
    const { source, events, logs } = make();
    await source.start();
    await waitFor(() => connections(events).length === 1, 'the connection');
    server.dropAll();
    await waitFor(() => logs.some((l) => l.message === 'reconnecting'), 'the log line');
    expect(logs.some((l) => l.message === 'connection lost' && l.level === 'warn')).toBe(true);
  });

  it('notices a server that has gone quiet: no pings at all', async () => {
    const { source, events } = make({ keepAliveMs: 40, serverTimeoutMs: 200 });
    await source.start();
    await waitFor(() => connections(events).length === 1, 'the connection');
    server.silent = true;
    await waitFor(() => connections(events).length === 2, 'the loss');
    expect(connections(events)[1]?.connected).toBe(false);
    expect(connections(events)[1]?.reason).toMatch(/timeout|timed out|server/i);
    server.silent = false;
    await waitFor(() => connections(events).length === 3, 'the reconnection');
  });
});

describe('a server that cannot be reached', () => {
  it('is reported once as a lost connection with the reason, and tried again and again', async () => {
    server.negotiateStatus = 503;
    const { source, events } = make();
    await source.start();
    await waitFor(() => server.negotiates.length >= 4, 'four attempts');
    expect(connections(events)).toHaveLength(1);
    expect(connections(events)[0]).toMatchObject({ connected: false });
    expect(connections(events)[0]?.reason).toMatch(/^cannot connect: /);
  });

  it('connects as soon as the server is back', async () => {
    server.negotiateStatus = 503;
    const { source, events } = make();
    await source.start();
    await waitFor(() => server.negotiates.length >= 2, 'two attempts');
    server.negotiateStatus = null;
    await waitFor(() => connections(events).some((c) => c.connected), 'the connection');
    expect(connections(events).map((c) => c.connected)).toEqual([false, true]);
  });

  it('waits longer and longer between attempts, up to the cap', async () => {
    server.negotiateStatus = 503;
    const { source } = make({ backoff: { initialMs: 30, factor: 2, capMs: 120, jitter: 0 } });
    await source.start();
    await waitFor(() => server.negotiates.length >= 6, 'six attempts');
    const spacing = gaps(server.negotiates);
    // waits of 30, 60, 120, 120, 120 ms plus the time an attempt takes
    expect(spacing[1] ?? 0).toBeGreaterThan((spacing[0] ?? 0) + 15);
    expect(spacing[2] ?? 0).toBeGreaterThan((spacing[1] ?? 0) + 25);
    expect(spacing[3] ?? 0).toBeLessThan((spacing[2] ?? 0) + 80);
    expect(spacing[4] ?? 0).toBeLessThan(120 + 100);
  });

  it('does not start the waits again for a server that accepts and drops at once', async () => {
    server.onSubscribe = (connection) => {
      connection.socket.close();
    };
    const { source } = make({ backoff: { initialMs: 30, factor: 2, capMs: 400, jitter: 0 } });
    await source.start();
    await waitFor(() => server.negotiates.length >= 5, 'five attempts');
    const spacing = gaps(server.negotiates);
    expect(spacing[3] ?? 0).toBeGreaterThan((spacing[0] ?? 0) + 60);
  });

  it('starts the waits again once a connection has held for a while', async () => {
    server.negotiateStatus = 503;
    const { source, events } = make({
      backoff: { initialMs: 50, factor: 4, capMs: 1_000, jitter: 0 },
      healthyAfterMs: 100,
    });
    await source.start();
    // two failures: the next wait would be 800 ms
    await waitFor(() => server.negotiates.length >= 3, 'three attempts');
    server.negotiateStatus = null;
    await waitFor(() => connections(events).some((c) => c.connected), 'the connection', 10_000);
    await pause(250);
    const droppedAt = Date.now();
    server.dropAll();
    await waitFor(
      () => connections(events).filter((c) => c.connected).length === 2,
      'the reconnection',
      10_000,
    );
    expect(Date.now() - droppedAt).toBeLessThan(600);
  });

  it('counts a connection as healthy when it has held for exactly the time asked', async () => {
    server.negotiateStatus = 503;
    const clock = handClock();
    const { source, events, logs } = make({
      backoff: { initialMs: 20, factor: 4, capMs: 1_000, jitter: 0 },
      healthyAfterMs: 1_000,
      clock,
    });
    await source.start();
    await waitFor(() => server.negotiates.length >= 3, 'three failed attempts');
    server.negotiateStatus = null;
    await waitFor(() => connections(events).some((c) => c.connected), 'the connection', 10_000);
    const waits = () => logs.filter((l) => l.message === 'reconnecting');
    const before = waits().length;
    clock.advance(1_000);
    server.dropAll();
    await waitFor(() => waits().length > before, 'the next wait');
    expect(waits()[before]?.data).toEqual({ waitMs: 20, attempt: 1 });
  });
});

describe('a connection that is up but silent', () => {
  const stall = { stallResubscribeMs: 150, stallReconnectMs: 400 } as const;

  it('subscribes again, once, after the first silence', async () => {
    const { source, events } = make(stall);
    await source.start();
    await waitFor(() => connections(events).length === 1, 'the connection');
    await waitFor(() => server.subscribes.length === 2, 'the second subscription');
    expect(server.subscribes[1]?.connectionId).toBe(server.subscribes[0]?.connectionId);
    await pause(100);
    expect(server.subscribes).toHaveLength(2);
  });

  it('connects again after the second silence', async () => {
    const { source, events } = make(stall);
    await source.start();
    await waitFor(() => connections(events).length === 1, 'the connection');
    await waitFor(() => connections(events).length === 3, 'the reconnection');
    expect(connections(events).map((c) => c.connected)).toEqual([true, false, true]);
    expect(new Set(server.subscribes.map((s) => s.connectionId)).size).toBe(2);
  });

  it('is not silent while quotes of the watched symbol come', async () => {
    const { source, events } = make(stall);
    await source.start();
    await waitFor(() => server.subscribes.length === 1, 'the subscription');
    const sendUntil = Date.now() + 700;
    while (Date.now() < sendUntil) {
      server.sendTick(goldTick());
      await pause(40);
    }
    expect(server.subscribes).toHaveLength(1);
    expect(connections(events)).toHaveLength(1);
  });

  it('is silent when only other symbols come', async () => {
    const { source } = make(stall);
    await source.start();
    await waitFor(() => server.subscribes.length === 1, 'the subscription');
    const sendUntil = Date.now() + 300;
    while (Date.now() < sendUntil) {
      server.sendTick(goldTick({ symbol: 'DXY', bid: 101.7, ask: 101.72 }));
      await pause(30);
    }
    expect(server.subscribes.length).toBeGreaterThanOrEqual(2);
  });

  it('does nothing while the market is closed, according to the provider', async () => {
    server.rest.set('XAUUSD', {
      status: 200,
      body: { marketState: 'closed', stale: true, quoteAgeSeconds: 99 },
    });
    const { source, events } = make({ ...stall, marketPollMs: 40 });
    await source.start();
    await waitFor(() => markets(events).length >= 1, 'the market state');
    await pause(900);
    expect(server.subscribes).toHaveLength(1);
    expect(connections(events)).toHaveLength(1);
  });

  it('does nothing on a weekend when the provider has not said (the weekly schedule)', async () => {
    const saturday = Date.parse('2026-10-24T12:00:00Z');
    const t0 = Date.now();
    const { source, events } = make({
      ...stall,
      clock: { now: () => saturday + (Date.now() - t0) },
    });
    await source.start();
    await waitFor(() => connections(events).length === 1, 'the connection');
    await pause(900);
    expect(server.subscribes).toHaveLength(1);
  });

  it('acts again when the provider says open, whatever the weekday', async () => {
    const saturday = Date.parse('2026-10-24T12:00:00Z');
    const t0 = Date.now();
    server.rest.set('XAUUSD', {
      status: 200,
      body: { marketState: 'open', stale: false, quoteAgeSeconds: 0 },
    });
    const { source, events } = make({
      ...stall,
      marketPollMs: 40,
      clock: { now: () => saturday + (Date.now() - t0) },
    });
    await source.start();
    await waitFor(() => connections(events).length === 1, 'the connection');
    await waitFor(() => server.subscribes.length >= 2, 'a second subscription');
  });

  it('logs what it does', async () => {
    const { source, logs } = make(stall);
    await source.start();
    await waitFor(
      () => logs.some((l) => l.message === 'no quote, connecting again'),
      'the log line',
    );
    expect(logs.some((l) => l.message === 'no quote, subscribing again')).toBe(true);
  });

  it('subscribes again, and later connects again, exactly when the silence reaches each limit', async () => {
    const clock = handClock();
    const { source, events } = make({ ...stall, clock });
    await source.start();
    await waitFor(() => connections(events).length === 1, 'the connection');
    clock.advance(149);
    await pause(80);
    expect(server.subscribes).toHaveLength(1);
    clock.advance(1);
    await waitFor(() => server.subscribes.length === 2, 'the second subscription');
    clock.advance(249);
    await pause(80);
    expect(connections(events)).toHaveLength(1);
    clock.advance(1);
    await waitFor(() => connections(events).length === 2, 'the reconnection');
  });

  it('can subscribe again, on the same connection, after a quote has come in between', async () => {
    const { source, events } = make(stall);
    await source.start();
    await waitFor(() => server.subscribes.length === 2, 'the second subscription');
    server.sendTick(goldTick());
    await waitFor(() => server.subscribes.length === 3, 'the third subscription');
    expect(server.subscribes[2]?.connectionId).toBe(server.subscribes[0]?.connectionId);
    expect(connections(events)).toHaveLength(1);
  });

  it('can subscribe again on the connection that replaced a silent one', async () => {
    const { source } = make(stall);
    await source.start();
    await waitFor(() => server.subscribes.length === 4, 'the fourth subscription');
    const ids = server.subscribes.map((s) => s.connectionId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBe(ids[3]);
    expect(ids[1]).not.toBe(ids[2]);
  });

  describe('with a market state from the hub', () => {
    const state = (symbol: string, value: string) => [
      [{ symbol, state: value, quoteAgeSeconds: 5 }],
    ];

    it('believes it for exactly two minutes', async () => {
      server.onSubscribe = (connection) => {
        server.invoke(connection, 'ReceiveSubscriptionState', state('XAUUSD', 'closed'));
      };
      const clock = handClock();
      const { source, events } = make({ ...stall, clock });
      await source.start();
      await waitFor(() => markets(events).length === 1, 'the market state');
      clock.advance(120_000);
      await pause(100);
      expect(server.subscribes).toHaveLength(1);
      expect(connections(events)).toHaveLength(1);
    });

    it('counts the silence from the moment the market opens, not from before', async () => {
      server.onSubscribe = (connection) => {
        server.invoke(connection, 'ReceiveSubscriptionState', state('XAUUSD', 'closed'));
      };
      const clock = handClock();
      const { source, events } = make({ ...stall, clock });
      await source.start();
      await waitFor(() => markets(events).length === 1, 'the closed state');
      clock.advance(1_000);
      await pause(80);
      expect(server.subscribes).toHaveLength(1);
      server.broadcast('ReceiveSubscriptionState', state('XAUUSD', 'open'));
      await waitFor(() => markets(events).length === 2, 'the open state');
      await pause(100);
      expect(server.subscribes).toHaveLength(1);
      expect(connections(events)).toHaveLength(1);
    });

    it('is not paused by the closed market of another symbol', async () => {
      server.onSubscribe = (connection) => {
        server.invoke(connection, 'ReceiveSubscriptionState', state('DXY', 'closed'));
      };
      const { source } = make(stall);
      await source.start();
      await waitFor(() => server.subscribes.length >= 2, 'a second subscription');
    });
  });

  describe('while a connection is being made', () => {
    it('does not judge the first one', async () => {
      server.negotiateDelayMs = 300;
      const { source, events, logs } = make({ stallResubscribeMs: 50, stallReconnectMs: 100 });
      await source.start();
      await waitFor(() => connections(events).length === 1, 'the connection');
      expect(server.negotiates).toHaveLength(1);
      expect(logs.some((l) => l.message === 'could not connect')).toBe(false);
    });

    it('does not judge the one that replaces a lost connection', async () => {
      const clock = handClock();
      const { source, events, logs } = make({ ...stall, clock });
      await source.start();
      await waitFor(() => connections(events).length === 1, 'the connection');
      server.negotiateDelayMs = 300;
      server.dropAll();
      await waitFor(() => connections(events).length === 2, 'the loss');
      clock.advance(10_000);
      await waitFor(
        () => connections(events).filter((c) => c.connected).length === 2,
        'the reconnection',
      );
      expect(server.negotiates).toHaveLength(2);
      expect(logs.some((l) => l.message === 'could not connect')).toBe(false);
    });
  });
});

describe('stopping', () => {
  it('closes the connection, says nothing more and can be repeated', async () => {
    const { source, events } = make();
    await source.start();
    await waitFor(() => connections(events).length === 1, 'the connection');
    await source.stop();
    await waitFor(() => server.connections.size === 0, 'the server to see the close');
    const count = events.length;
    server.sendTick(goldTick());
    await pause(80);
    expect(events).toHaveLength(count);
    await expect(source.stop()).resolves.toBeUndefined();
  });

  it('returns at once from a long wait between attempts', async () => {
    server.negotiateStatus = 503;
    const { source } = make({
      backoff: { initialMs: 30_000, factor: 2, capMs: 60_000, jitter: 0 },
    });
    await source.start();
    await waitFor(() => server.negotiates.length === 1, 'the first attempt');
    const started = Date.now();
    await source.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('does not reconnect after it was stopped', async () => {
    const { source, events } = make();
    await source.start();
    await waitFor(() => connections(events).length === 1, 'the connection');
    await source.stop();
    await pause(150);
    expect(server.negotiates).toHaveLength(1);
  });

  it('can be started again after it was stopped', async () => {
    const { source, events } = make();
    await source.start();
    await waitFor(() => connections(events).length === 1, 'the connection');
    await source.stop();
    await source.start();
    await waitFor(() => server.negotiates.length === 2, 'the second connection');
    await waitFor(() => server.subscribes.length === 2, 'the second subscription');
  });

  it('can be stopped before it has been started', async () => {
    const { source } = make();
    await expect(source.stop()).resolves.toBeUndefined();
  });

  it('lets a listener leave', async () => {
    const { source } = make();
    const seen: ProviderEvent[] = [];
    const leave = source.subscribe((event) => seen.push(event));
    leave();
    await source.start();
    await waitFor(() => server.subscribes.length === 1, 'the subscription');
    server.sendTick(goldTick());
    await pause(80);
    expect(seen).toEqual([]);
  });
});

describe('through the feed', () => {
  const freshTick = (source: BiquoteProvider, change: Record<string, unknown> = {}) =>
    goldTick({ timestamp: new Date(source.clock.now()).toISOString(), ...change });

  it('gives ticks, a live state and numbers for the health tab', async () => {
    const { source } = make();
    feed = new Feed({ provider: source, symbols: ['XAUUSD', 'DXY'] });
    const seen: FeedEvent[] = [];
    feed.on((event) => seen.push(event));
    await feed.start();
    await waitFor(() => server.subscribes.length === 1, 'the subscription');
    for (let i = 0; i < 6; i += 1) {
      server.sendTick(freshTick(source, { bid: 3995.856 + i / 10, ask: 3996.038 + i / 10 }));
      await pause(15);
    }
    await waitFor(() => seen.filter((e) => e.type === 'tick').length === 6, 'six ticks');
    const health = feed.health();
    expect(health.state).toBe('LIVE');
    expect(health.connected).toBe(true);
    expect(health.tickAgeMs).toBeLessThan(1_000);
    expect(health.spread).toBe(0.182);
    expect(health.clockSkewMs).not.toBeNull();
    expect(Math.abs(health.clockSkewMs ?? 9_999)).toBeLessThan(500);
    expect(feed.stats).toMatchObject({ received: 6, accepted: 6 });
  });

  it('notices silence, a lost connection and the recovery, with the incidents', async () => {
    const { source } = make();
    feed = new Feed({
      provider: source,
      symbols: ['XAUUSD', 'DXY'],
      evaluateEveryMs: 25,
      monitor: { maxTickAgeMs: 250, incidentGraceMs: 100 },
    });
    const seen: FeedEvent[] = [];
    feed.on((event) => seen.push(event));
    await feed.start();
    await waitFor(() => server.subscribes.length === 1, 'the subscription');
    server.sendTick(freshTick(source));
    await waitFor(() => feed?.health().state === 'LIVE', 'live');

    // silence: the tick gets older than 250 ms. Wait for the monitor's own state event: health()
    // is computed on the spot and can say STALE before the monitor has noticed it.
    await waitFor(
      () => seen.some((e) => e.type === 'state' && e.state === 'STALE' && e.previous === 'LIVE'),
      'the stale state',
    );

    // the server goes away
    server.negotiateStatus = 503;
    server.dropAll();
    await waitFor(() => feed?.health().state === 'DISCONNECTED', 'disconnected');
    await waitFor(
      () =>
        seen.some(
          (e) => e.type === 'incident' && e.phase === 'OPEN' && e.incident.kind === 'STALE',
        ),
      'the incident',
    );

    // and comes back
    server.negotiateStatus = null;
    await waitFor(() => server.subscribes.length === 2, 'the second subscription');
    server.sendTick(freshTick(source, { bid: 3999, ask: 3999.18 }));
    await waitFor(() => feed?.health().state === 'LIVE', 'live again');
    const closed = seen.find((e) => e.type === 'incident' && e.phase === 'CLOSE');
    expect(closed).toMatchObject({ incident: { kind: 'STALE', details: { disconnected: true } } });
  });

  it('drops the quote that the server sends again after a reconnect', async () => {
    const { source } = make();
    const seeded = goldTick({ timestamp: new Date(source.clock.now()).toISOString() });
    server.onSubscribe = (connection) => {
      server.invoke(connection, 'ReceiveTick', [seeded]);
    };
    feed = new Feed({ provider: source, symbols: ['XAUUSD', 'DXY'] });
    const seen: FeedEvent[] = [];
    feed.on((event) => seen.push(event));
    await feed.start();
    await waitFor(() => seen.some((e) => e.type === 'tick'), 'the seeded tick');
    server.dropAll();
    await waitFor(() => seen.some((e) => e.type === 'rejected'), 'the repeat');
    expect(seen.filter((e) => e.type === 'tick')).toHaveLength(1);
    expect(seen.find((e) => e.type === 'rejected')).toMatchObject({ reason: 'DUPLICATE' });
  });

  it('is a closed market, not a fault, when the hub says closed and the seeded tick is old', async () => {
    const { source } = make();
    const old = goldTick({
      timestamp: new Date(source.clock.now() - 12 * 3_600_000).toISOString(),
    });
    server.onSubscribe = (connection) => {
      server.invoke(connection, 'ReceiveSubscriptionState', [
        [{ symbol: 'XAUUSD', state: 'closed', quoteAgeSeconds: 43200, seeded: true }],
      ]);
      server.invoke(connection, 'ReceiveTick', [old]);
    };
    feed = new Feed({ provider: source, symbols: ['XAUUSD', 'DXY'] });
    const seen: FeedEvent[] = [];
    feed.on((event) => seen.push(event));
    await feed.start();
    await waitFor(
      () =>
        seen.some(
          (e) => e.type === 'incident' && e.incident.kind === 'MARKET_STATE' && e.phase === 'OPEN',
        ),
      'a closed market',
    );
    expect(feed.health()).toMatchObject({ connected: true, marketState: 'CLOSED' });
    expect(feed.health().state).toBe('MARKET_CLOSED');
    expect(seen.filter((e) => e.type === 'tick')).toHaveLength(1);
    expect(seen.some((e) => e.type === 'incident' && e.incident.kind !== 'MARKET_STATE')).toBe(
      false,
    );
  });
});

describe('the helpers', () => {
  it('read only a time with a zone', () => {
    expect(parseProviderTimestamp('2026-10-23T20:57:46Z')).toBe(Date.parse('2026-10-23T20:57:46Z'));
    expect(parseProviderTimestamp('2026-10-23T20:57:46.250Z')).toBe(
      Date.parse('2026-10-23T20:57:46.250Z'),
    );
    expect(parseProviderTimestamp('2026-10-23T20:57:46+05:30')).toBe(
      Date.parse('2026-10-23T15:27:46Z'),
    );
    expect(parseProviderTimestamp('2026-10-23T20:57:46')).toBeNull();
    expect(parseProviderTimestamp('2026.10.23 20:57:46')).toBeNull();
    expect(parseProviderTimestamp('2026-13-45T20:57:46Z')).toBeNull();
    expect(parseProviderTimestamp('')).toBeNull();
  });

  it('read the market state in any letter case, and anything else as unknown', () => {
    expect(['open', 'OPEN', 'Open'].map(toMarketState)).toEqual(['OPEN', 'OPEN', 'OPEN']);
    expect(['closed', 'CLOSED'].map(toMarketState)).toEqual(['CLOSED', 'CLOSED']);
    expect(['', 'pre-market', 'halted'].map(toMarketState)).toEqual([
      'UNKNOWN',
      'UNKNOWN',
      'UNKNOWN',
    ]);
  });
});
