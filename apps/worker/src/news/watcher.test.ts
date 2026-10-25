import { frozenHeadlineSchema } from '@vmgs/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { plain } from '../../../../packages/core/src/messages/test-html';
import { defaultAlertSettings } from '../testing/memoryLifecycleStore';
import { MemoryNewsStore } from '../testing/memoryNewsStore';
import { MemoryOutboxStore } from '../testing/memoryOutboxStore';
import { NewsContextReader } from './context';
import { FEEDS, MIN, T0, newItem, uuid } from './testData';
import { NewsFeedWatcher } from './watcher';

async function rig() {
  const clock = { now: T0 };
  const store = new MemoryNewsStore();
  await store.ensureSources(FEEDS);
  const outbox = new MemoryOutboxStore();
  const logs: string[] = [];
  const queued = { count: 0 };
  const make = () =>
    new NewsFeedWatcher({
      store,
      outbox,
      settings: () => Promise.resolve(defaultAlertSettings()),
      onQueued: () => {
        queued.count += 1;
      },
      now: () => clock.now,
      pollMs: 5,
      log: (level, message) => logs.push(`${level}: ${message}`),
    });
  return { clock, store, outbox, logs, queued, watcher: make(), make };
}

/** Every feed answered `agoMin` minutes before `T0`. */
async function silentFor(store: MemoryNewsStore, agoMin: number): Promise<void> {
  for (const feed of FEEDS) await store.recordOk(feed.key, T0 - agoMin * MIN);
}

describe('NewsFeedWatcher', () => {
  it('has nothing to say while a feed answered in the last 10 minutes', async () => {
    const { watcher, store, outbox, queued } = await rig();
    await silentFor(store, 30);
    await store.recordOk('cnbc_top', T0 - 5 * MIN);
    expect(await watcher.runOnce()).toBe(0);
    expect(outbox.entries()).toEqual([]);
    expect(queued.count).toBe(0);
  });

  it('has nothing to say for a system whose feeds never answered', async () => {
    const { watcher, outbox } = await rig();
    expect(await watcher.runOnce()).toBe(0);
    expect(outbox.entries()).toEqual([]);
  });

  it('tells once that every headline feed has been silent for more than 10 minutes, named by when it began', async () => {
    const { watcher, store, outbox, clock, queued } = await rig();
    await silentFor(store, 12);
    await store.recordOk('fed_press', T0 - 11 * MIN);
    expect(await watcher.runOnce()).toBe(1);
    const [row] = outbox.entries();
    expect(row).toMatchObject({
      channel: 'telegram',
      kind: 'SYSTEM_DEGRADED',
      eventKey: `health:HEADLINES@${String(T0 - 11 * MIN)}:degraded`,
      signalId: null,
      expiresAt: T0 + 60 * MIN,
    });
    expect(plain(String(row?.payload.text)).split('\n')[0]).toBe(
      '🔴 HEADLINE FEEDS DOWN since 21:19 IST (no feed answered for 11 min)',
    );
    expect(queued.count).toBe(1);
    clock.now += 5 * MIN;
    expect(await watcher.runOnce()).toBe(0);
    expect(outbox.entries()).toHaveLength(1);
  });

  it('does not tell again after a restart in the middle of the outage', async () => {
    const { watcher, store, outbox, make } = await rig();
    await silentFor(store, 15);
    await watcher.runOnce();
    expect(await make().runOnce()).toBe(0);
    expect(outbox.entries()).toHaveLength(1);
  });

  it('tells when a feed is back, with how long it was down, only for an outage it announced', async () => {
    const { watcher, store, outbox, clock } = await rig();
    await silentFor(store, 15);
    await watcher.runOnce();
    clock.now += 5 * MIN;
    await store.recordOk('bbc_world', clock.now - MIN);
    expect(await watcher.runOnce()).toBe(1);
    const back = outbox.entries().find((entry) => entry.kind === 'SYSTEM_RECOVERED');
    expect(back).toMatchObject({ eventKey: `health:HEADLINES@${String(T0 - 15 * MIN)}:recovered` });
    expect(plain(String(back?.payload.text)).split('\n')[0]).toBe(
      '🟢 HEADLINE FEEDS BACK 21:34 IST after 19 min.',
    );
    clock.now += MIN;
    expect(await watcher.runOnce()).toBe(0);
  });

  it('says nothing about a recovery of an outage it never announced', async () => {
    const { make, store, outbox, clock } = await rig();
    await silentFor(store, 15);
    clock.now += 5 * MIN;
    await store.recordOk('bbc_world', clock.now);
    expect(await make().runOnce()).toBe(0);
    expect(outbox.entries()).toEqual([]);
  });

  it('tells about a second outage after the first one was over', async () => {
    const { watcher, store, outbox, clock } = await rig();
    await silentFor(store, 15);
    await watcher.runOnce();
    clock.now += MIN;
    await store.recordOk('bbc_world', clock.now);
    await watcher.runOnce();
    clock.now += 30 * MIN;
    expect(await watcher.runOnce()).toBe(1);
    expect(outbox.entries().map((entry) => entry.kind)).toEqual([
      'SYSTEM_DEGRADED',
      'SYSTEM_RECOVERED',
      'SYSTEM_DEGRADED',
    ]);
  });

  it('leaves out a feed that is switched off', async () => {
    const { watcher, store, outbox } = await rig();
    await silentFor(store, 15);
    await store.recordOk('bbc_world', T0 - MIN);
    store.setEnabled('bbc_world', false);
    expect(await watcher.runOnce()).toBe(1);
    expect(outbox.entries()).toHaveLength(1);
  });

  describe('running', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('looks again and again, logs a pass that fails and goes on, and stops', async () => {
      const { watcher, store, outbox, logs } = await rig();
      store.failure = new Error('the database is down');
      watcher.start();
      watcher.start();
      await vi.waitFor(() => {
        expect(logs.length).toBeGreaterThan(0);
      });
      expect(logs[0]).toBe('error: the headline feed watcher could not finish a pass');
      store.failure = null;
      await silentFor(store, 15);
      await vi.waitFor(() => {
        expect(outbox.entries()).toHaveLength(1);
      });
      await watcher.stop();
    });
  });
});

describe('NewsContextReader', () => {
  const item = (title: string, change: Parameters<typeof newItem>[0] = {}) =>
    newItem({
      title,
      impact: 'MEDIUM',
      publishedAt: T0 - 10 * MIN,
      firstSeenAt: T0 - 9 * MIN,
      ...change,
    });

  it('has the state of the feeds, the stories of the last hour and the time of the newest HIGH one', async () => {
    const { store } = await rig();
    for (const feed of FEEDS) await store.recordOk(feed.key, T0 - MIN);
    await store.insertItems([
      item('Medium story', { clusterId: uuid(1) }),
      item('Older high story', {
        clusterId: uuid(2),
        impact: 'HIGH',
        publishedAt: T0 - 50 * MIN,
        firstSeenAt: T0 - 49 * MIN,
      }),
      item('Newer high story', {
        clusterId: uuid(3),
        impact: 'HIGH',
        publishedAt: T0 - 20 * MIN,
        firstSeenAt: T0 - 19 * MIN,
      }),
      item('Too old', {
        clusterId: uuid(4),
        impact: 'HIGH',
        publishedAt: T0 - 61 * MIN,
        firstSeenAt: T0 - 61 * MIN,
      }),
    ]);
    const context = await new NewsContextReader(store, () => T0).read();
    expect(context.feed).toBe('AVAILABLE');
    expect(context.health.status).toBe('OK');
    expect(context.headlines.map((headline) => headline.title)).toEqual([
      'Newer high story',
      'Older high story',
      'Medium story',
    ]);
    expect(context.lastHighHeadlineAt).toBe(T0 - 20 * MIN);
  });

  it('gives headlines that the contract of a frozen headline accepts', async () => {
    const { store } = await rig();
    await store.recordOk('bbc_world', T0);
    await store.insertItems([item('A story', { clusterId: uuid(1) })]);
    const { headlines } = await new NewsContextReader(store, () => T0).read();
    expect(headlines).toHaveLength(1);
    for (const headline of headlines)
      expect(frozenHeadlineSchema.parse(headline)).toEqual(headline);
  });

  it('says "feed unavailable" when the feeds are down, and not "no headline" for a quiet hour', async () => {
    const { store } = await rig();
    const reader = new NewsContextReader(store, () => T0);
    // no feed ever answered: down
    expect(await reader.read()).toMatchObject({
      feed: 'UNAVAILABLE',
      headlines: [],
      lastHighHeadlineAt: null,
    });
    for (const feed of FEEDS) await store.recordOk(feed.key, T0 - MIN);
    expect(await reader.read()).toMatchObject({
      feed: 'AVAILABLE',
      headlines: [],
      lastHighHeadlineAt: null,
    });
    for (const feed of FEEDS) store.setEnabled(feed.key, false);
    expect((await reader.read()).feed).toBe('UNAVAILABLE');
  });

  it('can be asked about another moment, and has none of the future', async () => {
    const { store } = await rig();
    await store.recordOk('bbc_world', T0);
    await store.insertItems([item('A story', { clusterId: uuid(1) })]);
    const reader = new NewsContextReader(store, () => T0);
    expect((await reader.read(T0 - 30 * MIN)).headlines).toEqual([]);
    expect((await reader.read(T0 + 50 * MIN)).headlines).toHaveLength(1);
    expect((await reader.read(T0 + 51 * MIN)).headlines).toEqual([]);
  });
});
