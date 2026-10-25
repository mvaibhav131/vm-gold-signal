import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryNewsStore } from '../testing/memoryNewsStore';
import { UnclassifiedBuffer } from './buffer';
import type { FeedReading, FeedSource, Validators } from './feeds';
import { FeedError, type RawHeadline } from './parsers';
import { FEED_FAILURE_DELAYS_MS, FEED_POLL_MS, NewsPoller } from './poller';
import { uuid } from './testData';

const NOW = Date.UTC(2026, 9, 23, 16, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

const FEEDS: FeedSource[] = [
  {
    key: 'fed_press',
    name: 'Federal Reserve',
    tier: 1,
    kind: 'rss',
    url: 'https://fed.example/rss',
  },
  { key: 'bbc_world', name: 'BBC News', tier: 2, kind: 'rss', url: 'https://bbc.example/rss' },
  { key: 'cnbc_top', name: 'CNBC', tier: 2, kind: 'rss', url: 'https://cnbc.example/rss' },
];

const headline = (title: string, change: Partial<RawHeadline> = {}): RawHeadline => ({
  title,
  url: `https://example.com/${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`,
  summary: null,
  publishedAt: NOW - 5 * MIN,
  ...change,
});

class FakeClient {
  readonly calls: { key: string; validators: Validators }[] = [];
  readonly readings = new Map<string, (FeedReading | Error)[]>();
  readonly fallback = new Map<string, FeedReading | Error>();

  /** The next reading of a feed (they queue up); the last one is kept for every later call. */
  give(key: string, ...items: (FeedReading | Error | RawHeadline[])[]): void {
    const list = items.map((item) => (Array.isArray(item) ? ok(item) : item));
    this.readings.set(key, [...(this.readings.get(key) ?? []), ...list]);
  }

  read(source: FeedSource, validators: Validators): Promise<FeedReading> {
    this.calls.push({ key: source.key, validators });
    const next = this.readings.get(source.key)?.shift() ?? this.fallback.get(source.key) ?? ok([]);
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }

  callsTo(key: string): number {
    return this.calls.filter((call) => call.key === key).length;
  }
}

const ok = (
  items: RawHeadline[],
  validators: Validators = { etag: null, lastModified: null },
): FeedReading => ({
  status: 'ok',
  items,
  skipped: 0,
  validators,
});

function rig(feeds: FeedSource[] = FEEDS) {
  const clock = { now: NOW };
  const client = new FakeClient();
  const store = new MemoryNewsStore();
  const buffer = new UnclassifiedBuffer(() => clock.now);
  const logs: string[] = [];
  const news: number[] = [];
  let ids = 0;
  const make = () =>
    new NewsPoller({
      feeds,
      client,
      store,
      buffer,
      onNew: (items) => news.push(items.length),
      now: () => clock.now,
      newId: () => uuid(++ids),
      log: (level, message) => logs.push(`${level}: ${message}`),
    });
  return { clock, client, store, buffer, logs, news, poller: make(), make };
}

describe('NewsPoller.runOnce', () => {
  it('reads every feed, stores what is about gold and puts the rest in the buffer', async () => {
    const { poller, client, store, buffer } = rig();
    client.give('bbc_world', [
      headline('Missile strike reported near Kharkiv'),
      headline('Local bakery wins a prize'),
    ]);
    client.give('fed_press', [headline('FOMC minutes show officials divided')]);
    const polls = await poller.runOnce();
    expect(polls.map((poll) => [poll.key, poll.ok, poll.stored]).sort()).toEqual([
      ['bbc_world', true, 1],
      ['cnbc_top', true, 0],
      ['fed_press', true, 1],
    ]);
    const items = (await store.items()).sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
    expect(items.map((item) => [item.sourceKey, item.title, item.impact, item.topics])).toEqual([
      ['bbc_world', 'Missile strike reported near Kharkiv', 'HIGH', ['GEOPOLITICS_WAR']],
      ['fed_press', 'FOMC minutes show officials divided', 'HIGH', ['FED_RATES']],
    ]);
    expect(buffer.items().map((item) => [item.title, item.sourceName])).toEqual([
      ['Local bakery wins a prize', 'BBC News'],
    ]);
    expect(poller.stats).toEqual({ polls: 3, stored: 2 });
  });

  it('makes the feeds known to the database, and marks each as read well', async () => {
    const { poller, store, clock } = rig();
    await poller.runOnce();
    const sources = await store.sources();
    expect(
      sources.map((source) => [source.key, source.tier, source.lastOkAt, source.lastError]),
    ).toEqual([
      ['bbc_world', 2, clock.now, null],
      ['cnbc_top', 2, clock.now, null],
      ['fed_press', 1, clock.now, null],
    ]);
  });

  it('stores an item as the classifier saw it: tier, age, summary and the version of the rules', async () => {
    const { poller, client, store } = rig();
    client.give('fed_press', [
      headline('Federal Reserve Board announces enforcement action', {
        summary: 'A short summary',
        publishedAt: NOW - 3 * HOUR,
      }),
    ]);
    client.give('bbc_world', [
      headline('Trump announces new tariffs on European goods', { publishedAt: null }),
    ]);
    await poller.runOnce();
    const items = await store.items();
    const fed = items.find((item) => item.sourceKey === 'fed_press');
    // W phrase 0.4 x weight 1.0 x tier 1 x three hours old (0.8)
    expect(fed).toMatchObject({
      impact: 'LOW',
      score: 0.32,
      publishedAt: NOW - 3 * HOUR,
      firstSeenAt: NOW,
    });
    const bbc = items.find((item) => item.sourceKey === 'bbc_world');
    // an item with no time is taken as fresh: 0.8 x 0.9
    expect(bbc).toMatchObject({ impact: 'HIGH', score: 0.72, publishedAt: null, firstSeenAt: NOW });
    const stored = (await store.recentItems(0)).length;
    expect(stored).toBe(2);
  });

  it('does not read a feed again before a minute has passed, and asks whether it changed when it does', async () => {
    const { poller, client, clock } = rig();
    client.give(
      'bbc_world',
      ok([headline('Missile strike reported')], { etag: 'W/"1"', lastModified: 'Thu' }),
    );
    await poller.runOnce();
    expect(await poller.runOnce()).toEqual([]);
    clock.now += FEED_POLL_MS - 1;
    expect(await poller.runOnce()).toEqual([]);
    expect(client.callsTo('bbc_world')).toBe(1);
    clock.now += 1;
    await poller.runOnce();
    expect(client.callsTo('bbc_world')).toBe(2);
    expect(
      client.calls.filter((call) => call.key === 'bbc_world').map((call) => call.validators),
    ).toEqual([
      { etag: null, lastModified: null },
      { etag: 'W/"1"', lastModified: 'Thu' },
    ]);
  });

  it('takes "not modified" as a good reading with nothing new', async () => {
    const { poller, client, store, clock } = rig();
    await poller.runOnce();
    clock.now += FEED_POLL_MS;
    client.give('bbc_world', {
      status: 'not_modified',
      items: [],
      skipped: 0,
      validators: { etag: 'W/"1"', lastModified: null },
    });
    const polls = await poller.runOnce();
    expect(polls.find((poll) => poll.key === 'bbc_world')).toMatchObject({ ok: true, stored: 0 });
    expect((await store.sources()).find((source) => source.key === 'bbc_world')?.lastOkAt).toBe(
      clock.now,
    );
  });

  it('does not store an item twice: not on the next reading, and not after a restart', async () => {
    const { poller, client, store, clock, make, news } = rig();
    const story = headline('Missile strike reported near Kharkiv');
    client.fallback.set('bbc_world', ok([story]));
    await poller.runOnce();
    clock.now += FEED_POLL_MS;
    await poller.runOnce();
    expect(await store.items()).toHaveLength(1);
    expect(news).toEqual([1]);
    const restarted = make();
    clock.now += FEED_POLL_MS;
    const polls = await restarted.runOnce(true);
    expect(polls.find((poll) => poll.key === 'bbc_world')?.stored).toBe(0);
    expect(await store.items()).toHaveLength(1);
  });

  it('takes two links to one story, with tracking parameters of their own, as one item', async () => {
    const { poller, client, store } = rig();
    client.give('bbc_world', [
      headline('Missile strike reported near Kharkiv', {
        url: 'https://bbc.example/a?at_medium=RSS&id=1',
      }),
      headline('Missile strike reported near Kharkiv again', {
        url: 'https://bbc.example/a?id=1&at_campaign=x',
      }),
    ]);
    await poller.runOnce();
    expect(await store.items()).toHaveLength(1);
  });

  it('joins a story that another outlet runs, in the same pass and in a later one', async () => {
    const { poller, client, store, clock } = rig();
    client.give('bbc_world', [
      headline('Trump announces new tariffs on European goods', { publishedAt: NOW - 4 * MIN }),
    ]);
    client.give('cnbc_top', [
      headline('US to impose tariffs on European goods, Trump says', {
        publishedAt: NOW - 3 * MIN,
      }),
    ]);
    await poller.runOnce();
    clock.now += FEED_POLL_MS;
    client.give('fed_press', [
      headline('Tariffs on European goods announced by Trump', { publishedAt: NOW - 2 * MIN }),
    ]);
    await poller.runOnce();
    const items = await store.items();
    expect(items).toHaveLength(3);
    expect(new Set(items.map((item) => item.clusterId)).size).toBe(1);
    const [story] = await store.clustersSince(0);
    expect(story?.sources.map((source) => source.key).sort()).toEqual([
      'bbc_world',
      'cnbc_top',
      'fed_press',
    ]);
  });

  it('keeps stories that are not the same apart, and does not join an hour away', async () => {
    const { poller, client, store, clock } = rig();
    client.give('bbc_world', [
      headline('Trump announces new tariffs on European goods', { publishedAt: NOW - 3 * HOUR }),
      headline('Trump meets Xi in Beijing', { publishedAt: NOW - 4 * MIN }),
    ]);
    await poller.runOnce();
    clock.now += FEED_POLL_MS;
    client.give('cnbc_top', [
      headline('US to impose tariffs on European goods, Trump says', {
        publishedAt: NOW - 2 * MIN,
      }),
    ]);
    await poller.runOnce();
    expect(new Set((await store.items()).map((item) => item.clusterId)).size).toBe(3);
  });

  it('remembers the stories of an earlier run, so that a restart still joins them', async () => {
    const { poller, client, store, clock, make } = rig();
    client.give('bbc_world', [headline('Trump announces new tariffs on European goods')]);
    await poller.runOnce();
    clock.now += FEED_POLL_MS;
    const restarted = make();
    client.give('cnbc_top', [headline('US to impose tariffs on European goods, Trump says')]);
    await restarted.runOnce();
    expect(new Set((await store.items()).map((item) => item.clusterId)).size).toBe(1);
  });

  it('does not keep an item older than six hours, nor a feed that is switched off', async () => {
    const { poller, client, store } = rig();
    client.give('bbc_world', [
      headline('Missile strike reported near Kharkiv', { publishedAt: NOW - 6 * HOUR }),
      headline('Missile strike reported near Odesa', { publishedAt: NOW - 6 * HOUR - 1 }),
    ]);
    store.setEnabled('cnbc_top', false);
    await poller.runOnce(); // loads the feeds into the store first
    store.setEnabled('cnbc_top', false);
    const polls = await poller.runOnce(true);
    expect(polls.map((poll) => poll.key).sort()).toEqual(['bbc_world', 'fed_press']);
    expect(client.callsTo('cnbc_top')).toBe(1);
    expect((await store.items()).map((item) => item.title)).toEqual([
      'Missile strike reported near Kharkiv',
    ]);
  });

  describe('a feed that fails', () => {
    it('costs only itself: the error is kept and the other feeds are read', async () => {
      const { poller, client, store, logs } = rig();
      client.give('bbc_world', new FeedError('BBC News answered 503', 'http', 503));
      client.give('cnbc_top', [headline('Missile strike reported near Kharkiv')]);
      const polls = await poller.runOnce();
      expect(polls.find((poll) => poll.key === 'bbc_world')).toMatchObject({
        ok: false,
        delayMs: 2 * MIN,
      });
      expect(polls.find((poll) => poll.key === 'cnbc_top')).toMatchObject({ ok: true, stored: 1 });
      const sources = await store.sources();
      expect(sources.find((source) => source.key === 'bbc_world')).toMatchObject({
        lastOkAt: null,
        lastError: 'BBC News answered 503',
      });
      expect(logs).toContain('error: a headline feed could not be read');
    });

    it('waits 2, 5 and then 10 minutes, and starts from a minute again after a good reading', async () => {
      expect(FEED_FAILURE_DELAYS_MS).toEqual([120_000, 300_000, 600_000]);
      const { poller, client, clock, logs } = rig();
      client.fallback.set('bbc_world', new Error('down'));
      const delays: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const polls = await poller.runOnce(true);
        delays.push(polls.find((poll) => poll.key === 'bbc_world')?.delayMs ?? 0);
        clock.now += 10 * MIN;
      }
      expect(delays).toEqual([2 * MIN, 5 * MIN, 10 * MIN, 10 * MIN, 10 * MIN]);
      client.fallback.set('bbc_world', ok([]));
      const good = await poller.runOnce(true);
      expect(good.find((poll) => poll.key === 'bbc_world')).toMatchObject({
        ok: true,
        delayMs: FEED_POLL_MS,
      });
      expect(logs).toContain('info: a headline feed can be read again');
      client.fallback.set('bbc_world', new Error('down again'));
      clock.now += 10 * MIN;
      expect((await poller.runOnce(true)).find((poll) => poll.key === 'bbc_world')?.delayMs).toBe(
        2 * MIN,
      );
    });

    it('clears the error on the next good reading', async () => {
      const { poller, client, store, clock } = rig();
      client.give('bbc_world', new Error('down'), ok([]));
      await poller.runOnce();
      clock.now += 2 * MIN;
      await poller.runOnce();
      expect((await store.sources()).find((source) => source.key === 'bbc_world')).toMatchObject({
        lastOkAt: clock.now,
        lastError: null,
      });
    });

    it('waits in its own time for each feed', async () => {
      const { poller, client, clock } = rig();
      client.give('bbc_world', new Error('down'));
      await poller.runOnce();
      clock.now += MIN;
      const polls = await poller.runOnce();
      expect(polls.map((poll) => poll.key).sort()).toEqual(['cnbc_top', 'fed_press']);
    });
  });

  describe('a database that fails', () => {
    it('does not take it for the feed: the copy is read again, and the items are stored when it is back', async () => {
      const { poller, client, store, clock, logs } = rig();
      const story = headline('Missile strike reported near Kharkiv');
      client.fallback.set('bbc_world', ok([story], { etag: 'W/"1"', lastModified: null }));
      await poller.runOnce();
      clock.now += FEED_POLL_MS;
      // a new story, and the database goes down while it is stored
      client.fallback.set(
        'bbc_world',
        ok([story, headline('Airstrikes hit a port city overnight')], {
          etag: 'W/"2"',
          lastModified: null,
        }),
      );
      const insert = store.insertItems.bind(store);
      store.insertItems = () => Promise.reject(new Error('the database is down'));
      const polls = await poller.runOnce();
      expect(polls.find((poll) => poll.key === 'bbc_world')).toMatchObject({
        ok: false,
        stored: 0,
        delayMs: FEED_POLL_MS,
      });
      expect(logs).toContain('error: a headline feed could not be stored');
      expect(
        (await store.sources()).find((source) => source.key === 'bbc_world')?.lastError,
      ).toBeNull();
      store.insertItems = insert;
      clock.now += FEED_POLL_MS;
      await poller.runOnce();
      expect((await store.items()).map((item) => item.title).sort()).toEqual([
        'Airstrikes hit a port city overnight',
        'Missile strike reported near Kharkiv',
      ]);
      // the validators of the copy that could not be stored were not kept
      expect(client.calls.filter((call) => call.key === 'bbc_world').at(-1)?.validators.etag).toBe(
        'W/"1"',
      );
    });

    it('says so and does nothing when the feeds cannot even be listed', async () => {
      const { poller, store, logs, client } = rig();
      store.failure = new Error('the database is down');
      expect(await poller.runOnce()).toEqual([]);
      expect(client.calls).toEqual([]);
      expect(logs).toEqual(['error: the news poller could not reach the database']);
      store.failure = null;
      expect(await poller.runOnce()).toHaveLength(3);
    });
  });

  it('puts an item that no rule knows in the buffer once, however often the feed repeats it', async () => {
    const { poller, client, buffer, clock } = rig();
    client.fallback.set('bbc_world', ok([headline('Local bakery wins a prize')]));
    await poller.runOnce();
    clock.now += FEED_POLL_MS;
    await poller.runOnce();
    expect(buffer.items()).toHaveLength(1);
  });
});

describe('NewsPoller, running', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads at once, then every minute, and stops when told, and can be started again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const client = new FakeClient();
    const poller = new NewsPoller({
      feeds: FEEDS.slice(1, 2),
      client,
      store: new MemoryNewsStore(),
      buffer: new UnclassifiedBuffer(),
      now: () => Date.now(),
    });
    poller.start();
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.callsTo('bbc_world')).toBe(1);
    await vi.advanceTimersByTimeAsync(FEED_POLL_MS - 10);
    expect(client.callsTo('bbc_world')).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(client.callsTo('bbc_world')).toBe(2);
    await poller.stop();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(client.callsTo('bbc_world')).toBe(2);
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.callsTo('bbc_world')).toBe(3);
    await poller.stop();
  });
});
