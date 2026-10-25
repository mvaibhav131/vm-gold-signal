import { topicStats, type NewsTopic } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import type { ImpactStore, MoveStore, NewsStore, SampleRecord } from './store';
import { FEEDS, MIN, T0, newItem, uuid } from './testData';

/** What the contract tests need besides the store. */
export interface NewsHarness {
  readonly store: NewsStore & ImpactStore & MoveStore;
  /** The owner's switch of a feed. */
  readonly setEnabled: (key: string, enabled: boolean) => Promise<void>;
  /** A HIGH calendar event at this time (it is also read by `eventTimes`). */
  readonly addHighEvent: (at: number) => Promise<void>;
}

const sample = (change: Partial<SampleRecord> = {}): SampleRecord => ({
  clusterId: uuid(900),
  topics: ['GEOPOLITICS_WAR'],
  impact: 'HIGH',
  publishedAt: T0,
  session: 'LONDON',
  atr5: 4,
  move2m: 1,
  move5m: 2,
  move10m: 2,
  maxAbs10m: 3,
  ...change,
});

/**
 * The behaviour that every `NewsStore`, `ImpactStore` and `MoveStore` must have, run against the
 * in-memory store (unit tests) and the PostgreSQL one (integration tests).
 */
export function newsStoreContract(
  name: string,
  makeHarness: () => Promise<{ harness: NewsHarness; done: () => Promise<void> }>,
): void {
  async function withStore(test: (harness: NewsHarness) => Promise<void>): Promise<void> {
    const { harness, done } = await makeHarness();
    try {
      await harness.store.ensureSources(FEEDS);
      await test(harness);
    } finally {
      await done();
    }
  }

  describe(`NewsStore, the feeds (${name})`, () => {
    it('adds the feeds, switched on, never read, and keeps the switch of the owner when it updates them', () =>
      withStore(async ({ store, setEnabled }) => {
        expect(await store.sources()).toEqual([
          {
            key: 'bbc_world',
            name: 'BBC News',
            tier: 2,
            enabled: true,
            lastOkAt: null,
            lastError: null,
          },
          {
            key: 'cnbc_top',
            name: 'CNBC',
            tier: 2,
            enabled: true,
            lastOkAt: null,
            lastError: null,
          },
          {
            key: 'fed_press',
            name: 'Federal Reserve',
            tier: 1,
            enabled: true,
            lastOkAt: null,
            lastError: null,
          },
        ]);
        await setEnabled('cnbc_top', false);
        await store.recordOk('cnbc_top', T0);
        await store.ensureSources([
          { key: 'cnbc_top', name: 'CNBC News', tier: 3 },
          { key: 'new_feed', name: 'New', tier: 2 },
        ]);
        const sources = await store.sources();
        expect(sources.find((s) => s.key === 'cnbc_top')).toEqual({
          key: 'cnbc_top',
          name: 'CNBC News',
          tier: 3,
          enabled: false,
          lastOkAt: T0,
          lastError: null,
        });
        expect(sources.map((s) => s.key)).toEqual([
          'bbc_world',
          'cnbc_top',
          'fed_press',
          'new_feed',
        ]);
        await store.ensureSources([]);
      }));

    it('keeps the time of the last good reading and the last error, and a good reading clears the error', () =>
      withStore(async ({ store }) => {
        await store.recordError('bbc_world', 'BBC News answered 503');
        expect((await store.sources())[0]).toMatchObject({
          lastOkAt: null,
          lastError: 'BBC News answered 503',
        });
        await store.recordOk('bbc_world', T0);
        await store.recordError('bbc_world', 'timeout');
        expect((await store.sources())[0]).toMatchObject({ lastOkAt: T0, lastError: 'timeout' });
        await store.recordOk('bbc_world', T0 + MIN);
        expect((await store.sources())[0]).toMatchObject({ lastOkAt: T0 + MIN, lastError: null });
      }));

    it('keeps at most 500 characters of an error, and knows nothing of a feed that is not there', () =>
      withStore(async ({ store }) => {
        await store.recordError('bbc_world', 'e'.repeat(900));
        expect((await store.sources())[0]?.lastError).toHaveLength(500);
        await store.recordOk('nope', T0);
        await store.recordError('nope', 'x');
        expect(await store.sources()).toHaveLength(3);
      }));
  });

  describe(`NewsStore, the items (${name})`, () => {
    it('stores an item with everything the alerts and the context read, and gives it an id', () =>
      withStore(async ({ store }) => {
        const item = newItem({
          summary: 'A short summary',
          topics: ['TRUMP_POLICY', 'GEOPOLITICS_WAR'],
          impact: 'HIGH',
          impactScore: 0.72,
        });
        const [stored] = await store.insertItems([item]);
        expect(stored).toMatchObject({ ...item, id: expect.any(String) as string });
        expect(await store.items()).toEqual([
          {
            id: stored?.id,
            clusterId: item.clusterId,
            sourceKey: 'bbc_world',
            sourceName: 'BBC News',
            title: item.title,
            url: item.url,
            publishedAt: item.publishedAt,
            firstSeenAt: item.firstSeenAt,
            topics: ['TRUMP_POLICY', 'GEOPOLITICS_WAR'],
            impact: 'HIGH',
            score: 0.72,
          },
        ]);
      }));

    it('keeps an item with no published time and an empty topic list as they are', () =>
      withStore(async ({ store }) => {
        await store.insertItems([newItem({ publishedAt: null, topics: [], impactScore: 0 })]);
        expect((await store.items())[0]).toMatchObject({ publishedAt: null, topics: [], score: 0 });
      }));

    it('stores what is new and tells which items those were: one source and hash is one item', () =>
      withStore(async ({ store }) => {
        const first = newItem({ urlHash: 'same' });
        const again = newItem({ urlHash: 'same', title: 'A later copy' });
        const other = newItem({ sourceKey: 'cnbc_top', urlHash: 'same' });
        expect((await store.insertItems([first, again, other])).map((item) => item.title)).toEqual([
          first.title,
          other.title,
        ]);
        expect(await store.insertItems([first])).toEqual([]);
        expect(await store.insertItems([])).toEqual([]);
        expect(await store.items()).toHaveLength(2);
        expect((await store.items()).find((item) => item.sourceKey === 'bbc_world')?.title).toBe(
          first.title,
        );
      }));

    it('refuses an item of a feed that is not there', () =>
      withStore(async ({ store }) => {
        await expect(store.insertItems([newItem({ sourceKey: 'ghost' })])).rejects.toThrow();
        expect(await store.items()).toEqual([]);
      }));

    it('gives the items from a time on, by when they were published or, without a time, first seen', () =>
      withStore(async ({ store }) => {
        await store.insertItems([
          newItem({ title: 'old', publishedAt: T0 - 90 * MIN, firstSeenAt: T0 - 10 * MIN }),
          newItem({ title: 'edge', publishedAt: T0 - 60 * MIN, firstSeenAt: T0 - 10 * MIN }),
          newItem({ title: 'seen', publishedAt: null, firstSeenAt: T0 - 30 * MIN }),
          newItem({ title: 'unseen', publishedAt: null, firstSeenAt: T0 - 61 * MIN }),
        ]);
        const recent = await store.recentItems(T0 - 60 * MIN);
        expect(recent.map((item) => item.title).sort()).toEqual(['edge', 'seen']);
        expect(recent.find((item) => item.title === 'seen')).toMatchObject({ at: T0 - 30 * MIN });
        expect(recent.find((item) => item.title === 'edge')).toMatchObject({ at: T0 - 60 * MIN });
      }));
  });

  describe(`NewsStore, the stories (${name})`, () => {
    it('makes one story of the items of a cluster: the strongest title, the outlets in order, the topics, the highest impact', () =>
      withStore(async ({ store }) => {
        const clusterId = uuid(5);
        await store.insertItems([
          newItem({
            clusterId,
            title: 'First report',
            sourceKey: 'cnbc_top',
            firstSeenAt: T0 - 9 * MIN,
            publishedAt: T0 - 10 * MIN,
            topics: ['FED_RATES'],
            impact: 'MEDIUM',
            impactScore: 0.5,
          }),
          newItem({
            clusterId,
            title: 'Stronger report',
            sourceKey: 'bbc_world',
            firstSeenAt: T0 - 7 * MIN,
            publishedAt: T0 - 8 * MIN,
            topics: ['GEOPOLITICS_WAR', 'FED_RATES'],
            impact: 'HIGH',
            impactScore: 0.81,
          }),
        ]);
        const [story] = await store.clustersSince(T0 - 60 * MIN);
        expect(story).toMatchObject({
          id: clusterId,
          title: 'Stronger report',
          impact: 'HIGH',
          topics: ['GEOPOLITICS_WAR', 'FED_RATES'],
          publishedAt: T0 - 10 * MIN,
          firstSeenAt: T0 - 9 * MIN,
        });
        expect(story?.sources).toEqual([
          { key: 'cnbc_top', name: 'CNBC' },
          { key: 'bbc_world', name: 'BBC News' },
        ]);
      }));

    it('has the stories with an item first seen from a time on, and all the items of those stories', () =>
      withStore(async ({ store }) => {
        const grown = uuid(10);
        await store.insertItems([
          newItem({
            clusterId: grown,
            title: 'Early',
            firstSeenAt: T0 - 50 * MIN,
            publishedAt: T0 - 51 * MIN,
          }),
          newItem({
            clusterId: grown,
            title: 'Late',
            firstSeenAt: T0 - 5 * MIN,
            sourceKey: 'cnbc_top',
          }),
          newItem({ clusterId: uuid(11), title: 'Old story', firstSeenAt: T0 - 40 * MIN }),
          newItem({ clusterId: uuid(12), title: 'Newer story', firstSeenAt: T0 - 2 * MIN }),
        ]);
        const stories = await store.clustersSince(T0 - 10 * MIN);
        expect(stories.map((story) => story.id)).toEqual([grown, uuid(12)]);
        expect(stories[0]?.sources.map((source) => source.key)).toEqual(['bbc_world', 'cnbc_top']);
        expect(stories[0]?.firstSeenAt).toBe(T0 - 50 * MIN);
        expect((await store.clustersSince(T0 - 5 * MIN)).map((story) => story.id)).toEqual([
          grown,
          uuid(12),
        ]);
        expect(await store.clustersSince(T0)).toEqual([]);
      }));

    it('puts the stories in the order they were first seen', () =>
      withStore(async ({ store }) => {
        await store.insertItems([
          newItem({ clusterId: uuid(22), firstSeenAt: T0 - 3 * MIN }),
          newItem({ clusterId: uuid(21), firstSeenAt: T0 - 9 * MIN }),
        ]);
        expect((await store.clustersSince(0)).map((story) => story.id)).toEqual([
          uuid(21),
          uuid(22),
        ]);
      }));
  });

  describe(`ImpactStore (${name})`, () => {
    const withStory = async (
      store: NewsStore & ImpactStore,
      id: number,
      time: number,
      topics: NewsTopic[] = ['GEOPOLITICS_WAR'],
    ) => {
      await store.insertItems([
        newItem({ clusterId: uuid(id), publishedAt: time, firstSeenAt: time + MIN, topics }),
      ]);
    };

    it('has the stories that have no sample and a time in the window, the ends included', () =>
      withStore(async ({ store }) => {
        await withStory(store, 1, T0 - 120 * MIN);
        await withStory(store, 2, T0 - 60 * MIN);
        await withStory(store, 3, T0 - 20 * MIN);
        await withStory(store, 4, T0 - 11 * MIN);
        await withStory(store, 5, T0 - 10 * MIN);
        const ids = async (since: number, until: number) =>
          (await store.unmeasured(since, until)).map((story) => story.id);
        expect(await ids(T0 - 60 * MIN, T0 - 10 * MIN)).toEqual([
          uuid(2),
          uuid(3),
          uuid(4),
          uuid(5),
        ]);
        expect(await ids(T0 - 59 * MIN, T0 - 11 * MIN)).toEqual([uuid(3), uuid(4)]);
        expect(await ids(T0, T0 + MIN)).toEqual([]);
      }));

    it('dates a story by its earliest published time, or when it was first seen without one', () =>
      withStore(async ({ store }) => {
        await store.insertItems([
          newItem({ clusterId: uuid(31), publishedAt: T0 - 30 * MIN, firstSeenAt: T0 - 5 * MIN }),
          newItem({ clusterId: uuid(31), publishedAt: T0 - 50 * MIN, firstSeenAt: T0 - 4 * MIN }),
          newItem({ clusterId: uuid(32), publishedAt: null, firstSeenAt: T0 - 40 * MIN }),
        ]);
        const ids = async (since: number, until: number) =>
          (await store.unmeasured(since, until)).map((story) => story.id);
        expect(await ids(T0 - 51 * MIN, T0 - 45 * MIN)).toEqual([uuid(31)]);
        expect(await ids(T0 - 41 * MIN, T0 - 39 * MIN)).toEqual([uuid(32)]);
        expect(await ids(T0 - 35 * MIN, T0 - 25 * MIN)).toEqual([]);
      }));

    it('keeps one sample for each story, and a measured story is no longer waiting', () =>
      withStore(async ({ store }) => {
        await withStory(store, 1, T0 - 30 * MIN);
        await withStory(store, 2, T0 - 29 * MIN);
        expect(await store.saveSample(sample({ clusterId: uuid(1) }))).toBe(true);
        expect(await store.saveSample(sample({ clusterId: uuid(1), move10m: 99 }))).toBe(false);
        expect((await store.unmeasured(0, T0)).map((story) => story.id)).toEqual([uuid(2)]);
      }));

    it('computes the statistics from the samples as the core does, with both topics of a sample counted', async () => {
      await withStore(async ({ store }) => {
        const samples = [
          sample({ clusterId: uuid(41), maxAbs10m: 3.999, move10m: 2.5 }),
          sample({ clusterId: uuid(42), maxAbs10m: 4, move10m: -6 }),
          sample({
            clusterId: uuid(43),
            topics: ['GEOPOLITICS_WAR', 'TRUMP_POLICY'],
            move10m: 1.2,
            maxAbs10m: 9,
          }),
          sample({ clusterId: uuid(44), impact: 'MEDIUM', move10m: 0.8, atr5: 3.2 }),
        ];
        for (const s of samples) expect(await store.saveSample(s)).toBe(true);
        expect(await store.rebuildStats(T0)).toBe(3);
        const rows = await store.topicStats();
        const expected = topicStats(samples.map((s) => ({ ...s, session: s.session })));
        expect(rows.map((row) => [row.topic, row.impact, row.n, row.moved1atr])).toEqual(
          expected.map((row) => [row.topic, row.impact, row.n, row.moved1atr]),
        );
        rows.forEach((row, i) => {
          expect(row.sumAbsAtr10m).toBeCloseTo(expected[i]?.sumAbsAtr10m ?? NaN, 9);
          expect(row.sumSignedAtr10m).toBeCloseTo(expected[i]?.sumSignedAtr10m ?? NaN, 9);
          expect(row.baseline).toBeNull();
        });
        expect(rows[0]).toMatchObject({
          topic: 'GEOPOLITICS_WAR',
          impact: 'HIGH',
          n: 3,
          moved1atr: 2,
        });
      });
    });

    it('recomputes the statistics when a sample is added, and a second run with nothing new changes nothing', () =>
      withStore(async ({ store }) => {
        await store.saveSample(sample({ clusterId: uuid(51) }));
        expect(await store.rebuildStats(T0)).toBe(1);
        const before = await store.topicStats();
        expect(await store.rebuildStats(T0 + MIN)).toBe(1);
        expect(await store.topicStats()).toEqual(before);
        await store.saveSample(sample({ clusterId: uuid(52), maxAbs10m: 5 }));
        await store.rebuildStats(T0 + 2 * MIN);
        expect((await store.topicStats())[0]).toMatchObject({ n: 2, moved1atr: 1 });
      }));

    it('has no statistics without samples', () =>
      withStore(async ({ store }) => {
        expect(await store.rebuildStats(T0)).toBe(0);
        expect(await store.topicStats()).toEqual([]);
        expect(await store.sampleSessions()).toEqual([]);
      }));

    it('keeps the baselines when the statistics are recomputed, and ignores a baseline of a row that is not there', () =>
      withStore(async ({ store }) => {
        await store.saveSample(sample({ clusterId: uuid(61) }));
        await store.rebuildStats(T0);
        await store.saveBaselines([
          { topic: 'GEOPOLITICS_WAR', impact: 'HIGH', baseline: 0.14 },
          { topic: 'RISK_OFF', impact: 'LOW', baseline: 0.5 },
        ]);
        await store.saveSample(sample({ clusterId: uuid(62) }));
        await store.rebuildStats(T0 + MIN);
        const rows = await store.topicStats();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ n: 2, baseline: 0.14 });
        await store.saveBaselines([{ topic: 'GEOPOLITICS_WAR', impact: 'HIGH', baseline: null }]);
        expect((await store.topicStats())[0]?.baseline).toBeNull();
        await store.saveBaselines([]);
      }));

    it('counts the samples of each topic, impact and session', () =>
      withStore(async ({ store }) => {
        await store.saveSample(sample({ clusterId: uuid(71), session: 'LONDON' }));
        await store.saveSample(
          sample({
            clusterId: uuid(72),
            session: 'LONDON',
            topics: ['GEOPOLITICS_WAR', 'FED_RATES'],
          }),
        );
        await store.saveSample(sample({ clusterId: uuid(73), session: 'ASIA' }));
        const rows = (await store.sampleSessions()).sort((a, b) =>
          `${a.topic}${a.session}`.localeCompare(`${b.topic}${b.session}`),
        );
        expect(rows).toEqual([
          { topic: 'FED_RATES', impact: 'HIGH', session: 'LONDON', n: 1 },
          { topic: 'GEOPOLITICS_WAR', impact: 'HIGH', session: 'ASIA', n: 1 },
          { topic: 'GEOPOLITICS_WAR', impact: 'HIGH', session: 'LONDON', n: 2 },
        ]);
      }));

    it('has the times of the stories and of the HIGH calendar events in a window, the ends included, in order', () =>
      withStore(async ({ store, addHighEvent }) => {
        await withStory(store, 81, T0 - 30 * MIN);
        await store.insertItems([
          newItem({ clusterId: uuid(82), publishedAt: null, firstSeenAt: T0 - 20 * MIN }),
          newItem({
            clusterId: uuid(83),
            publishedAt: T0 - 300 * MIN,
            firstSeenAt: T0 - 299 * MIN,
          }),
        ]);
        await addHighEvent(T0 - 25 * MIN);
        await addHighEvent(T0 - 90 * MIN);
        expect(await store.eventTimes(T0 - 30 * MIN, T0 - 20 * MIN)).toEqual([
          T0 - 30 * MIN,
          T0 - 25 * MIN,
          T0 - 20 * MIN,
        ]);
        expect(await store.eventTimes(T0 - 29 * MIN, T0 - 21 * MIN)).toEqual([T0 - 25 * MIN]);
        expect(await store.eventTimes(T0, T0 + MIN)).toEqual([]);
      }));
  });

  describe(`MoveStore (${name})`, () => {
    const move = (change: Partial<Parameters<MoveStore['insertMove']>[0]> = {}) => ({
      kind: 'SPIKE_UP' as const,
      detectedAt: T0,
      windowS: 240,
      moveUsd: 9.8,
      moveAtr: 2.8,
      spread: 0.35,
      headlines: [
        {
          title: 'Missile strike reported',
          sources: ['BBC News'],
          publishedAt: new Date(T0 - 13 * MIN).toISOString(),
          impact: 'HIGH' as const,
          topics: ['GEOPOLITICS_WAR' as const],
          url: 'https://example.com/a',
          classified: true,
        },
      ],
      meta: { basis: '5m', atr: 3.5 },
      ...change,
    });

    it('keeps a move with its frozen headlines and gives it an id that grows', () =>
      withStore(async ({ store }) => {
        const first = await store.insertMove(move());
        const second = await store.insertMove(
          move({ kind: 'SPIKE_DOWN', detectedAt: T0 + 20 * MIN, spread: null, headlines: [] }),
        );
        expect(second).toBeGreaterThan(first);
        const moves = await store.moves();
        expect(moves).toEqual([
          { id: first, ...move() },
          {
            id: second,
            ...move({ kind: 'SPIKE_DOWN', detectedAt: T0 + 20 * MIN, spread: null, headlines: [] }),
          },
        ]);
      }));

    it('knows when the latest move was detected, and that there was none', () =>
      withStore(async ({ store }) => {
        expect(await store.lastMoveAt()).toBeNull();
        await store.insertMove(move({ detectedAt: T0 + 5 * MIN }));
        await store.insertMove(move({ detectedAt: T0 }));
        expect(await store.lastMoveAt()).toBe(T0 + 5 * MIN);
      }));
  });
}
