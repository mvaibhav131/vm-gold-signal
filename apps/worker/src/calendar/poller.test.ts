import type { CalendarPolicy } from '@vmgs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryCalendarStore } from '../testing/memoryCalendarStore';
import { CalendarPoller } from './poller';
import type { CalendarFetch, CalendarProvider, ProviderEvent } from './provider';
import { providerEvent } from './testData';

const NOW = Date.UTC(2026, 9, 23, 6, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;
const POLICY: CalendarPolicy = { currencies: ['USD'], minImpact: 'HIGH' };

class FakeProvider implements CalendarProvider {
  readonly name = 'fake';
  events: ProviderEvent[] = [];
  skipped = 0;
  invalid = 0;
  truncated = false;
  failure: Error | null = null;
  readonly ranges: { from: number; to: number }[] = [];

  fetchRange(from: number, to: number): Promise<CalendarFetch> {
    this.ranges.push({ from, to });
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve({
      events: [...this.events],
      skipped: this.skipped,
      invalid: this.invalid,
      truncated: this.truncated,
    });
  }

  fetchHistory(): Promise<ProviderEvent[]> {
    return Promise.resolve([]);
  }
}

function rig(policy: CalendarPolicy = POLICY) {
  const clock = { now: NOW };
  const provider = new FakeProvider();
  const store = new MemoryCalendarStore();
  const logs: string[] = [];
  const make = () =>
    new CalendarPoller({
      provider,
      store,
      policy: () => Promise.resolve(policy),
      now: () => clock.now,
      log: (level, message) => logs.push(`${level}: ${message}`),
    });
  return { clock, provider, store, logs, poller: make(), make };
}

const watched = (inMs: number, change: Partial<ProviderEvent> = {}): ProviderEvent =>
  providerEvent({ scheduledAt: NOW + inMs, ...change });

describe('CalendarPoller.runOnce', () => {
  it('stores what it reads, and keeps the time of the good reading', async () => {
    const { poller, provider, store, logs } = rig();
    provider.events = [watched(3 * 60 * MIN)];
    provider.skipped = 2;
    expect(await poller.runOnce()).toEqual({ ok: true, delayMs: 5 * MIN });
    expect(store.all()).toHaveLength(1);
    expect(await store.lastOk()).toBe(NOW);
    expect(poller.stats).toEqual({ polls: 1, failures: 0, lastOkAt: NOW });
    expect(logs).toEqual(['info: the calendar was read for the first time']);
  });

  it('goes back two weeks the first time and three days after that, and eight days ahead', async () => {
    const { poller, provider, clock } = rig();
    await poller.runOnce();
    clock.now += 5 * MIN;
    await poller.runOnce();
    expect(provider.ranges).toEqual([
      { from: NOW - 14 * DAY, to: NOW + 8 * DAY },
      { from: NOW + 5 * MIN - 3 * DAY, to: NOW + 5 * MIN + 8 * DAY },
    ]);
  });

  it('keeps the store up to date: new events are added and revised ones changed', async () => {
    const { poller, provider, store, clock } = rig();
    provider.events = [watched(3 * 60 * MIN)];
    await poller.runOnce();
    clock.now += 5 * MIN;
    provider.events = [
      watched(3 * 60 * MIN, { forecast: 0.2 }),
      watched(4 * 60 * MIN, { sourceEventId: 'later' }),
    ];
    await poller.runOnce();
    expect(store.all().map((record) => [record.sourceEventId, record.forecast])).toEqual([
      ['mql5:277492', 0.2],
      ['later', 0.3],
    ]);
  });

  describe('the wait until the next reading', () => {
    it('is five minutes when no event is near', async () => {
      const { poller, provider } = rig();
      provider.events = [watched(60 * MIN), watched(-3 * 60 * MIN, { sourceEventId: 'old' })];
      expect((await poller.runOnce()).delayMs).toBe(5 * MIN);
    });

    it('is short enough to start the fast reading a minute before a watched event', async () => {
      const { poller, provider } = rig();
      provider.events = [watched(3 * MIN)];
      expect((await poller.runOnce()).delayMs).toBe(2 * MIN);
    });

    it('is 15 seconds from a minute before a watched event until its value is in', async () => {
      const { poller, provider } = rig();
      provider.events = [watched(30_000)];
      expect((await poller.runOnce()).delayMs).toBe(15_000);
      provider.events = [watched(-5 * MIN)];
      expect((await poller.runOnce()).delayMs).toBe(15_000);
      provider.events = [watched(-5 * MIN, { actual: 0.5 })];
      expect((await poller.runOnce()).delayMs).toBe(5 * MIN);
    });

    it('does not hurry for an event that is not watched: another currency, a lower impact, a tentative time', async () => {
      const { poller, provider } = rig();
      provider.events = [
        watched(30_000, { sourceEventId: 'eur', currency: 'EUR' }),
        watched(30_000, { sourceEventId: 'low', importance: 'medium' }),
        watched(30_000, { sourceEventId: 'tent', timeMode: 'tentative' }),
      ];
      expect((await poller.runOnce()).delayMs).toBe(5 * MIN);
    });

    it('follows the impact that the policy asks for', async () => {
      const { poller, provider } = rig({ currencies: ['USD'], minImpact: 'MEDIUM' });
      provider.events = [watched(30_000, { importance: 'medium' })];
      expect((await poller.runOnce()).delayMs).toBe(15_000);
    });
  });

  describe('a reading that fails', () => {
    it('is not a throw: the result says it failed, and the wait grows from 30 s to 5 min', async () => {
      const { poller, provider, store, logs } = rig();
      provider.failure = new Error('the calendar answered 503');
      const delays: number[] = [];
      for (let i = 0; i < 6; i += 1) delays.push((await poller.runOnce()).delayMs);
      expect(delays).toEqual([30_000, 60_000, 120_000, 300_000, 300_000, 300_000]);
      expect(await store.lastOk()).toBeNull();
      expect(poller.stats).toEqual({ polls: 6, failures: 6, lastOkAt: null });
      expect(logs[0]).toBe('error: the calendar could not be read');
    });

    it('starts again from 30 s after a good reading, and says the calendar is back', async () => {
      const { poller, provider, logs } = rig();
      provider.failure = new Error('down');
      await poller.runOnce();
      await poller.runOnce();
      provider.failure = null;
      expect((await poller.runOnce()).ok).toBe(true);
      provider.failure = new Error('down');
      expect((await poller.runOnce()).delayMs).toBe(30_000);
      expect(logs).toContain('info: the calendar can be read again');
    });

    it('goes back two weeks again if the first reading failed', async () => {
      const { poller, provider, clock } = rig();
      provider.failure = new Error('down');
      await poller.runOnce();
      provider.failure = null;
      clock.now += 30_000;
      await poller.runOnce();
      expect(provider.ranges.map((range) => range.to - range.from)).toEqual([22 * DAY, 22 * DAY]);
      expect(provider.ranges[1]?.from).toBe(NOW + 30_000 - 14 * DAY);
    });

    it('is a failure when the store fails, and the time of a good reading is not moved', async () => {
      const { poller, store, clock } = rig();
      await poller.runOnce();
      clock.now += 5 * MIN;
      store.failure = new Error('the database is down');
      expect(await poller.runOnce()).toEqual({ ok: false, delayMs: 30_000 });
      store.failure = null;
      expect(await store.lastOk()).toBe(NOW);
      expect(poller.stats.lastOkAt).toBe(NOW);
    });

    it('is a failure when the policy cannot be read', async () => {
      const { provider, store } = rig();
      const poller = new CalendarPoller({
        provider,
        store,
        policy: () => Promise.reject(new Error('settings down')),
        now: () => NOW,
      });
      expect(await poller.runOnce()).toEqual({ ok: false, delayMs: 30_000 });
    });
  });

  it('says when the answer was cut or had rows it could not read', async () => {
    const { poller, provider, logs } = rig();
    provider.truncated = true;
    await poller.runOnce();
    expect(logs).toContain('error: the calendar answer is not complete');
    const second = rig();
    second.provider.invalid = 1;
    await second.poller.runOnce();
    expect(second.logs).toContain('error: the calendar answer is not complete');
    const fine = rig();
    await fine.poller.runOnce();
    expect(fine.logs).not.toContain('error: the calendar answer is not complete');
  });
});

describe('CalendarPoller, running', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function running() {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const provider = new FakeProvider();
    const store = new MemoryCalendarStore();
    const poller = new CalendarPoller({ provider, store, policy: () => Promise.resolve(POLICY) });
    return { provider, store, poller };
  }

  it('reads at once, then every five minutes, and stops when told', async () => {
    const { provider, poller } = running();
    poller.start();
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.ranges).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5 * MIN - 2);
    expect(provider.ranges).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(provider.ranges).toHaveLength(2);
    await poller.stop();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(provider.ranges).toHaveLength(2);
  });

  it('tries again after 30 seconds when a reading failed', async () => {
    const { provider, poller } = running();
    provider.failure = new Error('down');
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.ranges).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(provider.ranges).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(provider.ranges).toHaveLength(2);
    await poller.stop();
  });

  it('stops at once, even while a reading is under way, without waiting for the next one', async () => {
    const { provider, poller } = running();
    let release: () => void = () => undefined;
    let reads = 0;
    provider.fetchRange = () =>
      new Promise((resolve) => {
        reads += 1;
        release = () => {
          resolve({ events: [], skipped: 0, invalid: 0, truncated: false });
        };
      });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toBe(1);
    const stopping = poller.stop();
    release();
    // fake time does not move: a loop that went to sleep after the reading would never finish
    await stopping;
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(reads).toBe(1);
  });

  it('stops at once while it waits, and can be started again', async () => {
    const { provider, poller } = running();
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await poller.stop();
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.ranges).toHaveLength(2);
    await poller.stop();
  });
});
