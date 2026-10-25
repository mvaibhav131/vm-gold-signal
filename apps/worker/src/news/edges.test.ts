import type { TickInput } from '@vmgs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeFeeds } from '../testing/fakeFeeds';
import { defaultAlertSettings } from '../testing/memoryLifecycleStore';
import { MemoryMarketReader } from '../testing/memoryMarketReader';
import { MemoryNewsStore } from '../testing/memoryNewsStore';
import { MemoryOutboxStore } from '../testing/memoryOutboxStore';
import { NewsAlerts } from './alerts';
import { BUFFER_MAX, BUFFER_MS, UnclassifiedBuffer } from './buffer';
import { HeadlineFeedClient, type FeedReading, type FeedSource } from './feeds';
import { BASELINE_DAYS, BASELINE_EVERY_MS, IMPACT_READY_MS, ImpactMeasurer } from './impact';
import { MarketMoveDetector } from './moves';
import { canonicalUrl, parseFeed, type RawHeadline } from './parsers';
import { FEED_POLL_MS, NewsPoller } from './poller';
import type { NewItem } from './store';
import { FEEDS, MIN, flatCandles, newItem, rampTicks, uuid } from './testData';

// Edges that the first tests of each file did not reach: found by changing the code on purpose (B25b mutation check).

const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 23, 16, 17, 0);

describe('UnclassifiedBuffer', () => {
  const held = (title: string, at: number, url = `https://example.com/${title}`) => ({
    title,
    url,
    sourceName: 'BBC News',
    publishedAt: at,
    firstSeenAt: at,
  });

  it('has the documented numbers: two hours, five hundred', () => {
    expect(BUFFER_MS).toBe(2 * HOUR);
    expect(BUFFER_MAX).toBe(500);
  });

  it('keeps a link once, whatever its title, and the same title under another link', () => {
    const buffer = new UnclassifiedBuffer(() => NOW);
    expect(buffer.add(held('One', NOW - MIN, 'https://example.com/a'))).toBe(true);
    expect(buffer.add(held('Other title', NOW - MIN, 'https://example.com/a'))).toBe(false);
    expect(buffer.add(held('One', NOW - MIN, 'https://example.com/b'))).toBe(true);
    expect(buffer.items()).toHaveLength(2);
  });

  it('takes a headline that is exactly two hours old, and not one that is older', () => {
    const buffer = new UnclassifiedBuffer(() => NOW);
    expect(buffer.add(held('Edge', NOW - BUFFER_MS))).toBe(true);
    expect(buffer.add(held('Older', NOW - BUFFER_MS - 1))).toBe(false);
    expect(buffer.items().map((item) => item.title)).toEqual(['Edge']);
  });

  it('lets a headline go when it is more than two hours old, and not before', () => {
    const clock = { now: NOW };
    const buffer = new UnclassifiedBuffer(() => clock.now);
    buffer.add(held('Edge', NOW - 10 * MIN));
    clock.now = NOW - 10 * MIN + BUFFER_MS;
    expect(buffer.items()).toHaveLength(1);
    clock.now += 1;
    expect(buffer.items()).toEqual([]);
  });

  it('keeps the newest 500 when more come, whatever the order they came in', () => {
    const buffer = new UnclassifiedBuffer(() => NOW);
    for (let i = 0; i <= BUFFER_MAX; i += 1) {
      // 501 headlines, the oldest of them added last
      buffer.add(held(`Story ${String(i)}`, NOW - (i + 1) * 1000));
    }
    const titles = buffer.items().map((item) => item.title);
    expect(titles).toHaveLength(500);
    expect(titles).toContain('Story 0');
    expect(titles).toContain('Story 499');
    expect(titles).not.toContain('Story 500');
  });

  it('lists the oldest first, and by link when the times are the same', () => {
    const buffer = new UnclassifiedBuffer(() => NOW);
    buffer.add(held('Late', NOW - MIN, 'https://example.com/z'));
    buffer.add(held('Same b', NOW - 5 * MIN, 'https://example.com/b'));
    buffer.add(held('Same a', NOW - 5 * MIN, 'https://example.com/a'));
    expect(buffer.items().map((item) => item.title)).toEqual(['Same a', 'Same b', 'Late']);
  });
});

// ------------------------------------------------------------------------------------ the poller

const FEED_LIST: FeedSource[] = [
  { key: 'bbc_world', name: 'BBC News', tier: 2, kind: 'rss', url: 'https://bbc.example/rss' },
  {
    key: 'fed_press',
    name: 'Federal Reserve',
    tier: 1,
    kind: 'rss',
    url: 'https://fed.example/rss',
  },
  { key: 'cnbc_top', name: 'CNBC', tier: 2, kind: 'rss', url: 'https://cnbc.example/rss' },
];

const headline = (title: string, change: Partial<RawHeadline> = {}): RawHeadline => ({
  title,
  url: `https://example.com/${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`,
  summary: null,
  publishedAt: NOW - 5 * MIN,
  ...change,
});

const reading = (items: RawHeadline[]): FeedReading => ({
  status: 'ok',
  items,
  skipped: 0,
  validators: { etag: null, lastModified: null },
});

function pollerRig(feeds: FeedSource[] = FEED_LIST) {
  const clock = { now: NOW };
  const readings = new Map<string, FeedReading>();
  const store = new MemoryNewsStore();
  const buffer = new UnclassifiedBuffer(() => clock.now);
  let ids = 0;
  const poller = new NewsPoller({
    feeds,
    client: {
      read: (source) => Promise.resolve(readings.get(source.key) ?? reading([])),
    },
    store,
    buffer,
    now: () => clock.now,
    newId: () => uuid(++ids),
  });
  return { clock, readings, store, buffer, poller };
}

describe('NewsPoller: edges', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads a feed every 60 seconds', () => {
    expect(FEED_POLL_MS).toBe(60_000);
  });

  it('does not offer an item it has seen again to the store', async () => {
    const { poller, readings, store } = pollerRig();
    const insert = vi.spyOn(store, 'insertItems');
    readings.set('bbc_world', reading([headline('Missile strike reported near Kharkiv')]));
    await poller.runOnce(true);
    await poller.runOnce(true);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('stores the older story of a reading first, so that it has the first cluster', async () => {
    const { poller, readings, store } = pollerRig();
    readings.set(
      'bbc_world',
      reading([
        headline('FOMC minutes show officials divided', { publishedAt: NOW - 5 * MIN }),
        headline('Missile strike reported near Kharkiv', { publishedAt: NOW - 20 * MIN }),
      ]),
    );
    await poller.runOnce(true);
    const clusters = Object.fromEntries(
      (await store.items()).map((item) => [item.title, item.clusterId]),
    );
    expect(clusters['Missile strike reported near Kharkiv']).toBe(uuid(1));
    expect(clusters['FOMC minutes show officials divided']).toBe(uuid(2));
  });

  it('puts a story without a published time in the cluster of the same story that another outlet dated ten minutes ago', async () => {
    const { poller, readings, store } = pollerRig();
    readings.set(
      'bbc_world',
      reading([headline('Missile strike reported near Kharkiv overnight', { publishedAt: null })]),
    );
    readings.set(
      'fed_press',
      reading([
        headline('Missile strike reported near Kharkiv overnight, officials say', {
          publishedAt: NOW - 10 * MIN,
        }),
      ]),
    );
    await poller.runOnce(true);
    const clusters = (await store.items()).map((item) => item.clusterId);
    expect(clusters).toHaveLength(2);
    expect(new Set(clusters).size).toBe(1);
  });

  it('remembers a story for three hours, the third hour included, to join it with the same story from another outlet', async () => {
    const { poller, readings, store } = pollerRig();
    readings.set(
      'bbc_world',
      reading([
        headline('Missile strike reported near Kharkiv overnight', { publishedAt: NOW - 3 * HOUR }),
      ]),
    );
    await poller.runOnce(true);
    readings.set(
      'fed_press',
      reading([
        headline('Missile strike reported near Kharkiv overnight, officials say', {
          publishedAt: NOW - 2.5 * HOUR,
        }),
      ]),
    );
    await poller.runOnce(true);
    const clusters = (await store.items()).map((item) => item.clusterId);
    expect(clusters).toHaveLength(2);
    expect(new Set(clusters).size).toBe(1);
  });

  it('forgets the oldest of 5000 links it has seen, and only that one', async () => {
    const { poller, readings, buffer } = pollerRig(FEED_LIST.slice(0, 1));
    const items = Array.from({ length: 5001 }, (_, i) =>
      headline(`Local story number ${String(i)}`, { publishedAt: NOW - (6000 - i) * 1000 }),
    );
    readings.set('bbc_world', reading(items));
    await poller.runOnce(true);
    const add = vi.spyOn(buffer, 'add');
    readings.set('bbc_world', reading([items[1], items[2500], items[5000]] as RawHeadline[]));
    await poller.runOnce(true);
    expect(add).not.toHaveBeenCalled();
    readings.set('bbc_world', reading([items[0]] as RawHeadline[]));
    await poller.runOnce(true);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[0].title).toBe('Local story number 0');
  });

  it('looks again after a second at the earliest, also when a feed that is switched off has no time of its own', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryNewsStore();
    await store.ensureSources(FEED_LIST.map(({ key, name, tier }) => ({ key, name, tier })));
    store.setEnabled('cnbc_top', false);
    const sources = vi.spyOn(store, 'sources');
    const poller = new NewsPoller({
      feeds: FEED_LIST,
      client: { read: () => Promise.resolve(reading([])) },
      store,
      buffer: new UnclassifiedBuffer(),
      now: () => Date.now(),
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(sources).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(sources).toHaveBeenCalledTimes(2);
    await poller.stop();
  });
});

// ------------------------------------------------------------------------------ the move detector

const asTicks = (ticks: { ts: number; bid: number; ask: number }[]): TickInput[] =>
  ticks.map((tick) => ({ ...tick, rxAt: tick.ts, symbol: 'XAUUSD' }));

async function detectorRig() {
  const store = new MemoryNewsStore();
  await store.ensureSources(FEEDS);
  const market = new MemoryMarketReader();
  market.candles['1m'] = flatCandles('1m', NOW, 15, 1.2);
  market.candles['5m'] = flatCandles('5m', NOW, 15, 3);
  const detector = new MarketMoveDetector({
    market,
    news: store,
    moves: store,
    buffer: new UnclassifiedBuffer(() => NOW),
    outbox: new MemoryOutboxStore(),
    settings: () => Promise.resolve(defaultAlertSettings()),
    open: () => Promise.resolve([]),
    now: () => NOW,
  });
  return { detector, market };
}

describe('MarketMoveDetector: edges', () => {
  it('keeps ticks for six minutes, so that a move that began 5 minutes before a tick 15 seconds old is whole', async () => {
    const { detector, market } = await detectorRig();
    // a wide ATR(1m) leaves the 5-minute window to report the move
    market.candles['1m'] = flatCandles('1m', NOW, 15, 50);
    const ticks = [{ ts: NOW - 315_000, bid: 3999.4, ask: 3999.6 }];
    for (let s = 310; s >= 15; s -= 5) {
      const mid = s === 15 ? 4005.6 : 4000;
      ticks.push({ ts: NOW - s * 1000, bid: mid - 0.1, ask: mid + 0.1 });
    }
    detector.onTicks(asTicks(ticks));
    expect(await detector.check()).toMatchObject({ kind: 'SPIKE_UP', moveUsd: 6.1, windowS: 300 });
  });

  it('keeps the newest 20000 ticks when more come, not the oldest', async () => {
    const { detector } = await detectorRig();
    const ticks = Array.from({ length: 20_500 }, (_, i) => {
      const ts = NOW - (20_499 - i) * 10;
      // flat for 4 minutes, then 10 USD in the last 4 seconds
      const mid = i < 20_100 ? 4000 : 4000 + ((i - 20_100) / 399) * 10;
      return { ts, bid: mid - 0.1, ask: mid + 0.1 };
    });
    detector.onTicks(asTicks(ticks));
    expect(await detector.check()).toMatchObject({ kind: 'SPIKE_UP', moveUsd: 10 });
  });
});

// ------------------------------------------------------------------------------ the impact measurer

/** 11:30 UTC on 2026-10-23: the London session. */
const AT = Date.UTC(2026, 9, 23, 11, 30, 0);
const story = (change: Partial<NewItem> = {}): NewItem =>
  newItem({
    clusterId: uuid(1),
    topics: ['TRUMP_POLICY'],
    impact: 'HIGH',
    publishedAt: AT,
    firstSeenAt: AT + MIN,
    ...change,
  });

async function measurerRig(range = 4) {
  const clock = { now: AT + IMPACT_READY_MS };
  const store = new MemoryNewsStore();
  await store.ensureSources(FEEDS);
  const market = new MemoryMarketReader();
  market.candles['5m'] = flatCandles('5m', AT, 15, range);
  market.tickList = rampTicks(AT - 10_000, AT + 11 * MIN, 4000 - 10 / 60, 4011, 10);
  const measurer = new ImpactMeasurer({ impact: store, market, now: () => clock.now });
  return { clock, store, market, measurer };
}

describe('ImpactMeasurer: edges', () => {
  it('has the documented numbers: a baseline of 30 days, renewed every 6 hours', () => {
    expect(BASELINE_DAYS).toBe(30);
    expect(BASELINE_EVERY_MS).toBe(6 * HOUR);
  });

  it('does not rebuild the statistics when no story was measured', async () => {
    const { measurer, store } = await measurerRig();
    const rebuild = vi.spyOn(store, 'rebuildStats');
    expect(await measurer.runOnce()).toBe(0);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('does not measure against an ATR of zero', async () => {
    const { measurer, store } = await measurerRig(0);
    await store.insertItems([story()]);
    expect(await measurer.runOnce()).toBe(0);
  });

  it('keeps the ATR to three decimals, as the sample table does', async () => {
    const { measurer, store } = await measurerRig(3.14159265);
    await store.insertItems([story()]);
    expect(await measurer.runOnce()).toBe(1);
    const [row] = await store.topicStats();
    expect(row?.sumAbsAtr10m).toBeCloseTo(10 / 3.142, 5);
  });

  it('records the largest excursion of the 10 minutes, not only where gold stood at the end', async () => {
    const { measurer, store, market } = await measurerRig();
    market.tickList = [
      ...rampTicks(AT - 10_000, AT + 5 * MIN, 3999.8, 4010, 10),
      ...rampTicks(AT + 5 * MIN + 10_000, AT + 11 * MIN, 4009.8, 4001, 10),
    ];
    await store.insertItems([story()]);
    expect(await measurer.runOnce()).toBe(1);
    const [row] = await store.topicStats();
    // it ended near +2.5 USD (0.6 ATR) but went to +10 USD (2.5 ATR)
    expect(row?.moved1atr).toBe(1);
    expect(row?.sumAbsAtr10m).toBeLessThan(1);
  });

  it('takes the price at the story from a tick up to 30 seconds before it', async () => {
    const { measurer, store, market } = await measurerRig();
    market.tickList = [
      { ts: AT - 20_000, bid: 3999.9, ask: 4000.1 },
      ...rampTicks(AT + 20_000, AT + 11 * MIN, 4000.33, 4011, 10),
    ];
    await store.insertItems([story()]);
    expect(await measurer.runOnce()).toBe(1);
  });

  it('computes the baseline of the last 30 days, with the 14 candles before them for the ATR, and the events around them', async () => {
    const { measurer, store, market, clock } = await measurerRig();
    await store.insertItems([story()]);
    const candles = vi.spyOn(market, 'candlesBetween');
    const events = vi.spyOn(store, 'eventTimes');
    await measurer.runOnce();
    const from = clock.now - 30 * 24 * HOUR;
    expect(candles).toHaveBeenCalledWith('1m', from, clock.now);
    expect(candles).toHaveBeenCalledWith('5m', from - 15 * 300_000, clock.now);
    expect(events).toHaveBeenCalledWith(from - 10 * MIN, clock.now + 10 * MIN);
  });

  it('renews the baseline after six hours, the sixth hour included, and not before', async () => {
    const renewals = async (wait: number): Promise<number> => {
      const { measurer, store, market, clock } = await measurerRig();
      const later = AT + 5 * HOUR;
      market.candles['5m'] = [...flatCandles('5m', AT, 15, 4), ...flatCandles('5m', later, 15, 4)];
      market.tickList = [
        ...rampTicks(AT - 10_000, AT + 11 * MIN, 4000 - 10 / 60, 4011, 10),
        ...rampTicks(later - 10_000, later + 11 * MIN, 4000 - 10 / 60, 4011, 10),
      ];
      const save = vi.spyOn(store, 'saveBaselines');
      await store.insertItems([story()]);
      expect(await measurer.runOnce()).toBe(1);
      await store.insertItems([
        story({ clusterId: uuid(2), publishedAt: later, firstSeenAt: later + MIN }),
      ]);
      clock.now += wait;
      expect(await measurer.runOnce()).toBe(1);
      return save.mock.calls.length;
    };
    expect(await renewals(BASELINE_EVERY_MS - 1)).toBe(1);
    expect(await renewals(BASELINE_EVERY_MS)).toBe(2);
  });
});

// -------------------------------------------------------------------------------- the headline alerts

describe('NewsAlerts: edges', () => {
  it('reads 15 candles for the ATR, and ticks from 30 seconds before the story', async () => {
    const store = new MemoryNewsStore();
    await store.ensureSources(FEEDS);
    const market = new MemoryMarketReader();
    const published = NOW - 2 * MIN;
    await store.insertItems([
      story({ clusterId: uuid(1), publishedAt: published, firstSeenAt: NOW - MIN }),
    ]);
    const candles = vi.spyOn(market, 'closedCandles');
    const ticks = vi.spyOn(market, 'ticks');
    const alerts = new NewsAlerts({
      news: store,
      impact: store,
      market,
      outbox: new MemoryOutboxStore(),
      settings: () => Promise.resolve(defaultAlertSettings()),
      now: () => NOW,
    });
    await alerts.runOnce();
    expect(candles).toHaveBeenCalledWith('5m', NOW, 15);
    expect(ticks).toHaveBeenCalledWith(published - 30_000, NOW);
  });
});

// ------------------------------------------------------------------------------ the feed parsers

describe('feed parsing: edges', () => {
  it('does not take `ref` for part of the address of a story', () => {
    expect(canonicalUrl('https://example.com/a?ref=home&id=1')).toBe('https://example.com/a?id=1');
  });

  it('takes an Atom link without `rel` for the alternate link', () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Fed holds rates steady</title><link href="https://example.com/a"/><updated>2026-10-23T16:10:00Z</updated></entry></feed>`;
    expect(parseFeed(xml, NOW).items[0]?.url).toBe('https://example.com/a');
  });

  it('reads an address whose ampersands were encoded twice', () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Fed holds rates steady</title><link rel="alternate" href="https://example.com/a?x=1&amp;amp;y=2"/></entry></feed>`;
    expect(parseFeed(xml, NOW).items[0]?.url).toBe('https://example.com/a?x=1&y=2');
  });

  it('reads a feed that starts with a byte order mark', () => {
    const xml = `\uFEFF<?xml version="1.0"?><rss version="2.0"><channel><item><title>Fed holds rates steady</title><link>https://example.com/a</link></item></channel></rss>`;
    expect(parseFeed(xml, NOW).items).toHaveLength(1);
  });

  it('decodes the entities of a title that are not XML ones', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>Fed holds rates&nbsp;steady&hellip; Powell&rsquo;s view &#8212; &euro;5</title><link>https://example.com/a</link></item></channel></rss>`;
    expect(parseFeed(xml, NOW).items[0]?.title).toBe('Fed holds rates steady… Powell’s view — €5');
  });
});

describe('HeadlineFeedClient: the size limit is a limit, not a wall', () => {
  const fake = new FakeFeeds();

  it('takes a feed of exactly the largest size, by its declared and by its real size', async () => {
    await fake.start();
    try {
      const head = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>Fed holds rates steady</title><link>https://example.com/a</link></item></channel></rss><!--`;
      const tail = '-->';
      const body = `${head}${'x'.repeat(2000 - head.length - tail.length)}${tail}`;
      expect(Buffer.byteLength(body)).toBe(2000);
      fake.set('/feed', { body, contentType: 'text/xml' });
      const client = new HeadlineFeedClient({ maxBytes: 2000, timeoutMs: 2000 });
      const result = await client.read(
        { key: 'test', name: 'Test', tier: 2, kind: 'rss', url: fake.url('/feed') },
        { etag: null, lastModified: null },
      );
      expect(result.status).toBe('ok');
      const small = new HeadlineFeedClient({ maxBytes: 1999, timeoutMs: 2000 });
      await expect(
        small.read(
          { key: 'test', name: 'Test', tier: 2, kind: 'rss', url: fake.url('/feed') },
          { etag: null, lastModified: null },
        ),
      ).rejects.toMatchObject({ kind: 'too_large' });
    } finally {
      await fake.stop();
    }
  });
});
