import { topicStats, type TickPoint } from '@vmgs/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { plain } from '../../../../packages/core/src/messages/test-html';
import { query } from '../../../../packages/db/test/database';
import { PostgresOutboxStore } from '../alerts/postgresOutboxStore';
import { createPgWorld, type PgWorld } from '../lifecycle/pgHarness';
import { PostgresBotStore } from '../telegram/postgresBotStore';
import { FakeFeeds } from '../testing/fakeFeeds';
import { NewsAlerts } from './alerts';
import { UnclassifiedBuffer } from './buffer';
import { HeadlineFeedClient, type FeedSource } from './feeds';
import { ImpactMeasurer } from './impact';
import { MarketMoveDetector } from './moves';
import { NewsPoller } from './poller';
import { PostgresMarketReader } from './postgresMarketReader';
import { PostgresNewsStore } from './postgresStore';
import { NewsFeedWatcher } from './watcher';
import { MIN, T0, rampTicks } from './testData';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

let world: PgWorld;
let fake: FakeFeeds;

beforeAll(async () => {
  world = await createPgWorld();
  const day = new Date(T0).toISOString().slice(0, 10);
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  await query(
    world.database.url,
    `CREATE TABLE IF NOT EXISTS ticks_${day.replaceAll('-', '')} PARTITION OF ticks FOR VALUES FROM ('${day}') TO ('${next}')`,
  );
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  await query(
    world.database.url,
    'TRUNCATE news_impact_samples, news_topic_stats, news_items, news_sources, market_events, macro_events, ticks, candles RESTART IDENTITY CASCADE',
  );
  await query(world.database.url, 'DELETE FROM notification_outbox');
  fake = new FakeFeeds();
  await fake.start();
});

afterEach(async () => {
  await fake.stop();
});

const rss = (items: { title: string; at: number }[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Test</title>${items
    .map(
      (item) =>
        `<item><title>${item.title}</title><link>https://example.com/${item.title
          .toLowerCase()
          .replaceAll(
            /[^a-z0-9]+/g,
            '-',
          )}</link><pubDate>${new Date(item.at).toUTCString()}</pubDate></item>`,
    )
    .join('')}</channel></rss>`;

const serve = (path: string, items: { title: string; at: number }[], etag?: string): void => {
  fake.set(path, {
    body: rss(items),
    contentType: 'application/rss+xml',
    ...(etag === undefined ? {} : { etag }),
  });
};

const sources = (): FeedSource[] => [
  { key: 'fed_press', name: 'Federal Reserve', tier: 1, kind: 'rss', url: fake.url('/fed') },
  { key: 'bbc_world', name: 'BBC News', tier: 2, kind: 'rss', url: fake.url('/bbc') },
];

const addTicks = (ticks: readonly TickPoint[]) =>
  query(
    world.database.url,
    `INSERT INTO ticks (ts, rx_at, symbol, bid, ask)
     SELECT x.t, x.t, 'XAUUSD', x.b, x.a
       FROM unnest($1::timestamptz[], $2::numeric[], $3::numeric[]) AS x(t, b, a)`,
    [
      ticks.map((tick) => new Date(tick.ts)),
      ticks.map((tick) => tick.bid),
      ticks.map((tick) => tick.ask),
    ],
  );

/** Complete candles of `tf` from `from` (inclusive) to `until` (exclusive), each with the range `range` around 4000. */
const addCandles = (tf: '1m' | '5m', from: number, until: number, range: number) => {
  const step = tf === '1m' ? MIN : 5 * MIN;
  const openTimes: Date[] = [];
  for (let at = from; at < until; at += step) openTimes.push(new Date(at));
  return query(
    world.database.url,
    `INSERT INTO candles (symbol, tf, open_time, o, h, l, c, complete)
     SELECT 'XAUUSD', $1, x.t, 4000, 4000 + $2::numeric / 2, 4000 - $2::numeric / 2, 4000, true
       FROM unnest($3::timestamptz[]) AS x(t)`,
    [tf, range, openTimes],
  );
};

const outboxRows = () =>
  query<{
    event_key: string;
    channel: string;
    kind: string;
    expires_at: Date;
    payload: { text: string };
  }>(
    world.database.url,
    'SELECT event_key, channel, kind, expires_at, payload FROM notification_outbox ORDER BY event_key, channel',
  );

function rig(feeds: FeedSource[] = sources()) {
  const clock = { now: T0 };
  const store = new PostgresNewsStore(world.pool);
  const market = new PostgresMarketReader(world.pool, 'XAUUSD');
  const outbox = new PostgresOutboxStore(world.pool);
  const buffer = new UnclassifiedBuffer(() => clock.now);
  const logs: string[] = [];
  const log = (level: string, message: string) => logs.push(`${level}: ${message}`);
  const poller = new NewsPoller({
    feeds,
    client: new HeadlineFeedClient({ timeoutMs: 2000, now: () => clock.now }),
    store,
    buffer,
    now: () => clock.now,
    log,
  });
  const alerts = () =>
    new NewsAlerts({
      news: store,
      impact: store,
      market,
      outbox,
      settings: () => world.store.loadSettings(),
      now: () => clock.now,
    });
  const watcher = () =>
    new NewsFeedWatcher({
      store,
      outbox,
      settings: () => world.store.loadSettings(),
      now: () => clock.now,
    });
  const detector = () =>
    new MarketMoveDetector({
      market,
      news: store,
      moves: store,
      buffer,
      outbox,
      settings: () => world.store.loadSettings(),
      open: async () => {
        const bot = new PostgresBotStore(world.pool);
        return (await bot.open()).map((row) => ({
          seq: row.seq,
          side: row.side,
          unrealisedR: null,
        }));
      },
      now: () => clock.now,
      log,
    });
  return { clock, store, market, outbox, buffer, logs, poller, alerts, watcher, detector };
}

describe('the headlines, from the feed to the outbox (PostgreSQL)', () => {
  it('reads two feeds, keeps the stories about gold, tells each once, and does not tell or store again after a restart', async () => {
    serve(
      '/bbc',
      [
        { title: 'Missile strike reported near Kharkiv', at: T0 - 5 * MIN },
        { title: 'Local bakery wins a prize', at: T0 - 4 * MIN },
      ],
      '"b1"',
    );
    serve('/fed', [{ title: 'FOMC minutes show officials divided', at: T0 - 3 * MIN }], '"f1"');
    await addTicks(rampTicks(T0 - 6 * MIN, T0, 4000, 4004, 5));
    await addCandles('5m', T0 - 4 * 60 * MIN, T0 - 5 * MIN, 3);
    const { poller, alerts, buffer, store, clock } = rig();

    const polls = await poller.runOnce(true);
    expect(polls.map((poll) => [poll.key, poll.ok, poll.stored]).sort()).toEqual([
      ['bbc_world', true, 1],
      ['fed_press', true, 1],
    ]);
    const items = await query<{
      source_key: string;
      title: string;
      impact: string;
      cluster_id: string;
      classifier_version: string;
    }>(
      world.database.url,
      'SELECT source_key, title, impact, cluster_id, classifier_version FROM news_items ORDER BY source_key',
    );
    expect(items.map((item) => [item.source_key, item.title, item.impact])).toEqual([
      ['bbc_world', 'Missile strike reported near Kharkiv', 'HIGH'],
      ['fed_press', 'FOMC minutes show officials divided', 'HIGH'],
    ]);
    expect(buffer.items().map((item) => item.title)).toEqual(['Local bakery wins a prize']);
    expect((await store.sources()).map((source) => [source.key, source.lastOkAt])).toEqual([
      ['bbc_world', T0],
      ['fed_press', T0],
    ]);

    expect(await alerts().runOnce()).toBeGreaterThanOrEqual(2);
    const told = await outboxRows();
    const keys = [...new Set(told.map((row) => row.event_key))].sort();
    expect(keys).toEqual(items.map((item) => `news:${item.cluster_id}:headline`).sort());
    expect(new Set(told.map((row) => row.kind))).toEqual(new Set(['NEWS_HEADLINE']));
    const bbc = told.find((row) => row.event_key.includes(items[0]?.cluster_id ?? '?'));
    expect(bbc?.expires_at.getTime()).toBe(T0 + 30 * MIN);
    expect(plain(bbc?.payload.text ?? '')).toContain('Missile strike reported near Kharkiv');

    // a restarted alerts loop queues the same keys again: the outbox keeps one row of each
    expect(await alerts().runOnce()).toBe(0);
    expect(await outboxRows()).toHaveLength(told.length);

    // the feeds answer "not modified" to the validators they gave, and a copy that is read again adds nothing
    clock.now = T0 + MIN;
    await poller.runOnce(true);
    const [again] = fake.requestsTo('/fed').slice(-1);
    expect(again?.headers['if-none-match']).toBe('"f1"');
    const [count] = await query<{ n: string }>(
      world.database.url,
      'SELECT count(*)::text AS n FROM news_items',
    );
    expect(count?.n).toBe('2');
  });

  it('does not store a story twice when another outlet runs it: the second joins the cluster of the first', async () => {
    serve('/bbc', [{ title: 'Missile strike reported near Kharkiv overnight', at: T0 - 6 * MIN }]);
    serve('/fed', [
      { title: 'Missile strike reported near Kharkiv overnight, officials say', at: T0 - 5 * MIN },
    ]);
    const { poller } = rig();
    await poller.runOnce(true);
    const rows = await query<{ cluster_id: string }>(
      world.database.url,
      'SELECT cluster_id FROM news_items',
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.cluster_id)).size).toBe(1);
  });

  it('measures what gold did after a story, keeps the sample once, and rebuilds the statistics the same way the core does', async () => {
    const published = T0 - 20 * MIN;
    serve('/bbc', [{ title: 'Missile strike reported near Kharkiv', at: published }]);
    serve('/fed', []);
    await addTicks(rampTicks(published - 10_000, published + 11 * MIN, 4000, 4011, 5));
    await addCandles('5m', T0 - 4 * 60 * MIN, T0 - 5 * MIN, 3);
    await addCandles('1m', T0 - 60 * MIN, T0 - MIN, 1.2);
    const { poller, store, market, clock } = rig();
    await poller.runOnce(true);

    const measurer = new ImpactMeasurer({ impact: store, market, now: () => clock.now });
    expect(await measurer.runOnce()).toBe(1);
    expect(await measurer.runOnce()).toBe(0);
    const samples = await query<{
      topics: string[];
      session: string;
      atr5: string;
      move_10m: string;
    }>(world.database.url, 'SELECT topics, session, atr5, move_10m FROM news_impact_samples');
    expect(samples).toHaveLength(1);
    expect(samples[0]?.topics).toEqual(['GEOPOLITICS_WAR']);
    expect(Number(samples[0]?.atr5)).toBe(3);
    expect(Number(samples[0]?.move_10m)).toBeGreaterThan(8);

    const stats = await store.topicStats();
    expect(stats).toHaveLength(1);
    const expected = topicStats([
      {
        topics: ['GEOPOLITICS_WAR'],
        impact: 'HIGH',
        session: samples[0]?.session as 'LONDON',
        atr5: 3,
        move10m: Number(samples[0]?.move_10m),
        maxAbs10m: Number(samples[0]?.move_10m),
      },
    ]);
    expect(stats[0]).toMatchObject({ topic: 'GEOPOLITICS_WAR', impact: 'HIGH', n: expected[0]?.n });
    expect(stats[0]?.baseline).not.toBeUndefined();
  });

  it('sees a sudden move in the stored ticks, keeps it with the headlines around it, tells it once, and stays quiet after a restart', async () => {
    serve('/bbc', [{ title: 'Missile strike reported near Kharkiv', at: T0 - 8 * MIN }]);
    serve('/fed', []);
    await addTicks(rampTicks(T0 - 240_000, T0, 4000, 4010, 5));
    await addCandles('5m', T0 - 4 * 60 * MIN, T0, 3);
    await addCandles('1m', T0 - 60 * MIN, T0, 1.2);
    const { poller, detector, store, clock } = rig();
    await poller.runOnce(true);

    const first = detector();
    await first.warmUp();
    expect(await first.check()).toMatchObject({ kind: 'SPIKE_UP', moveUsd: 10, basis: '5m' });
    const [move] = await store.moves();
    expect(move).toMatchObject({ id: 1, kind: 'SPIKE_UP', moveUsd: 10, windowS: 240 });
    expect(move?.headlines.map((headline) => headline.title)).toEqual([
      'Missile strike reported near Kharkiv',
    ]);
    const rows = (await outboxRows()).filter((row) => row.kind === 'MARKET_MOVE');
    expect(rows.map((row) => row.event_key)).toEqual(expect.arrayContaining(['move:1:spike']));
    expect(plain(rows[0]?.payload.text ?? '')).toContain('GOLD SPIKE UP +10.000 USD in 4 min');
    expect(plain(rows[0]?.payload.text ?? '')).toContain('"Missile strike reported near Kharkiv"');

    // after a restart the pause is still there: the time of the last move is in the database
    clock.now = T0 + MIN;
    const second = detector();
    await second.warmUp();
    expect(await second.check()).toBeNull();
    expect(await store.moves()).toHaveLength(1);
  });

  it('tells when every headline feed has been silent for more than ten minutes, once, and when they are back', async () => {
    serve('/bbc', [{ title: 'Missile strike reported near Kharkiv', at: T0 - 5 * MIN }]);
    serve('/fed', [{ title: 'FOMC minutes show officials divided', at: T0 - 3 * MIN }]);
    const { poller, watcher, clock } = rig();
    await poller.runOnce(true);
    const watch = watcher();
    expect(await watch.runOnce()).toBe(0);

    clock.now = T0 + 11 * MIN;
    fake.next('/bbc', { type: 'status', status: 503 });
    fake.next('/fed', { type: 'status', status: 503 });
    expect((await poller.runOnce(true)).map((poll) => poll.ok)).toEqual([false, false]);
    expect(await watch.runOnce()).toBeGreaterThan(0);
    expect(await watch.runOnce()).toBe(0);
    const down = (await outboxRows()).filter((row) => row.kind === 'SYSTEM_DEGRADED');
    expect(down.length).toBeGreaterThan(0);
    expect(new Set(down.map((row) => row.event_key))).toEqual(
      new Set([`health:HEADLINES@${String(T0)}:degraded`]),
    );
    expect(plain(down[0]?.payload.text ?? '')).toContain('HEADLINE FEEDS');

    clock.now = T0 + 13 * MIN;
    expect((await poller.runOnce(true)).map((poll) => poll.ok)).toEqual([true, true]);
    expect(await watch.runOnce()).toBeGreaterThan(0);
    const back = (await outboxRows()).filter((row) => row.kind === 'SYSTEM_RECOVERED');
    expect(new Set(back.map((row) => row.event_key))).toEqual(
      new Set([`health:HEADLINES@${String(T0)}:recovered`]),
    );
  });
});
