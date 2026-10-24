import { dataFreshGate, type FeedFacts } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { Feed } from './feed';
import { FeedMonitor } from './monitor';
import { ManualProvider } from './testing/manualProvider';
import type { FeedHealth, QuoteProvider } from './types';

const T = Date.parse('2026-10-21T12:00:00Z');

// The DATA_FRESH gate reads the numbers of the feed's health. `FeedHealth` must stay readable by it.
describe('the health of the feed is what the DATA_FRESH gate reads', () => {
  const asFacts = (health: FeedHealth): FeedFacts => health;

  function live() {
    const monitor = new FeedMonitor({ isScheduledClosed: () => false });
    monitor.onConnection(true, T);
    monitor.onTick({ ts: T, rxAt: T + 1_000, symbol: 'XAUUSD', bid: 4000, ask: 4000.18 });
    return monitor;
  }

  it('a live feed passes and the gate reports the age of the tick', () => {
    const health = live().snapshot(T + 3_000);
    expect(health.state).toBe('LIVE');
    expect(dataFreshGate(asFacts(health))).toMatchObject({ passed: true, value: 3, limit: 10 });
  });

  it('a stale feed and a feed that says LIVE agree with the gate on the 10 s limit', () => {
    const monitor = live();
    expect(monitor.snapshot(T + 10_000).state).toBe('LIVE');
    expect(dataFreshGate(asFacts(monitor.snapshot(T + 10_000))).passed).toBe(true);
    expect(monitor.snapshot(T + 10_001).state).toBe('STALE');
    expect(dataFreshGate(asFacts(monitor.snapshot(T + 10_001)))).toMatchObject({
      passed: false,
      reason: 'STALE',
    });
  });

  it('a lost connection, a closed market and a stale flag from the provider each fail it, with their reason', () => {
    const lost = live();
    lost.onConnection(false, T + 2_000, 'closed');
    expect(dataFreshGate(asFacts(lost.snapshot(T + 3_000))).reason).toBe('DISCONNECTED');

    const closed = live();
    closed.onMarket('CLOSED', T + 2_000, true);
    expect(dataFreshGate(asFacts(closed.snapshot(T + 3_000))).reason).toBe('MARKET_CLOSED');

    const flagged = live();
    flagged.onMarket('OPEN', T + 2_000, true);
    expect(dataFreshGate(asFacts(flagged.snapshot(T + 3_000))).reason).toBe('PROVIDER_STALE');
  });

  it('a feed that has not connected yet fails with its own reason', () => {
    const fresh = new FeedMonitor({ isScheduledClosed: () => false });
    expect(dataFreshGate(asFacts(fresh.snapshot(T))).reason).toBe('DISCONNECTED');
  });

  it('works on the health that the Feed itself gives', async () => {
    const provider: QuoteProvider = new ManualProvider(T);
    const feed = new Feed({
      provider,
      symbols: ['XAUUSD'],
      monitor: { isScheduledClosed: () => false },
    });
    await feed.start();
    expect(dataFreshGate(feed.health()).passed).toBe(false);
    await feed.stop();
  });
});
