import {
  buildClusters,
  timeOf,
  topicStats,
  type ClusterItem,
  type HeadlineCluster,
  type NewsImpact,
  type NewsTopic,
  type Session,
  type SourceTier,
} from '@vmgs/core';

import type {
  ImpactStore,
  MarketMoveRecord,
  MoveStore,
  NewItem,
  NewsSourceRow,
  NewsStore,
  RecentItem,
  SampleRecord,
  StoredItem,
  TopicStatRow,
} from '../news/store';

/** The headlines, their measured impact and the market moves in memory, with the same rules as the PostgreSQL store. */
export class MemoryNewsStore implements NewsStore, ImpactStore, MoveStore {
  /** The times of HIGH calendar events, for `eventTimes`. A test sets them. */
  highEventTimes: number[] = [];
  /** A failure that every call throws, until cleared. */
  failure: Error | null = null;
  private readonly sourceRows = new Map<string, NewsSourceRow>();
  private readonly itemList: StoredItem[] = [];
  private readonly samples = new Map<string, SampleRecord>();
  private readonly stats = new Map<string, TopicStatRow>();
  private readonly moveList: (MarketMoveRecord & { readonly id: number })[] = [];
  private sequence = 0;

  private check(): void {
    if (this.failure !== null) throw this.failure;
  }

  // ------------------------------------------------------------------------------- the feeds

  ensureSources(feeds: readonly { key: string; name: string; tier: SourceTier }[]): Promise<void> {
    this.check();
    for (const feed of feeds) {
      const old = this.sourceRows.get(feed.key);
      this.sourceRows.set(feed.key, {
        key: feed.key,
        name: feed.name,
        tier: feed.tier,
        enabled: old?.enabled ?? true,
        lastOkAt: old?.lastOkAt ?? null,
        lastError: old?.lastError ?? null,
      });
    }
    return Promise.resolve();
  }

  sources(): Promise<NewsSourceRow[]> {
    this.check();
    return Promise.resolve(
      [...this.sourceRows.values()].sort((a, b) => a.key.localeCompare(b.key)),
    );
  }

  recordOk(key: string, at: number): Promise<void> {
    this.check();
    const row = this.sourceRows.get(key);
    if (row !== undefined) this.sourceRows.set(key, { ...row, lastOkAt: at, lastError: null });
    return Promise.resolve();
  }

  recordError(key: string, error: string): Promise<void> {
    this.check();
    const row = this.sourceRows.get(key);
    if (row !== undefined) this.sourceRows.set(key, { ...row, lastError: error.slice(0, 500) });
    return Promise.resolve();
  }

  /** The owner's switch, for a test. */
  setEnabled(key: string, enabled: boolean): void {
    const row = this.sourceRows.get(key);
    if (row !== undefined) this.sourceRows.set(key, { ...row, enabled });
  }

  // ------------------------------------------------------------------------------- the items

  recentItems(since: number): Promise<RecentItem[]> {
    this.check();
    return Promise.resolve(
      this.itemList
        .map((item) => ({
          clusterId: item.clusterId,
          title: item.title,
          at: item.publishedAt ?? item.firstSeenAt,
        }))
        .filter((item) => item.at >= since),
    );
  }

  insertItems(items: readonly NewItem[]): Promise<StoredItem[]> {
    this.check();
    // as in one statement: an item of an unknown feed stores nothing at all
    const unknown = items.find((item) => !this.sourceRows.has(item.sourceKey));
    if (unknown !== undefined) {
      return Promise.reject(new Error(`no news source ${unknown.sourceKey} (foreign key)`));
    }
    const added: StoredItem[] = [];
    for (const item of items) {
      const there = this.itemList.some(
        (stored) => stored.sourceKey === item.sourceKey && stored.urlHash === item.urlHash,
      );
      if (there) continue;
      this.sequence += 1;
      const stored = { ...item, id: `item-${String(this.sequence).padStart(4, '0')}` };
      this.itemList.push(stored);
      added.push(stored);
    }
    return Promise.resolve(added);
  }

  items(): Promise<ClusterItem[]> {
    this.check();
    return Promise.resolve(this.clusterItems(this.itemList));
  }

  private clusterItems(items: readonly StoredItem[]): ClusterItem[] {
    return items.map((item) => ({
      id: item.id,
      clusterId: item.clusterId,
      sourceKey: item.sourceKey,
      sourceName: this.sourceRows.get(item.sourceKey)?.name ?? item.sourceKey,
      title: item.title,
      url: item.url,
      publishedAt: item.publishedAt,
      firstSeenAt: item.firstSeenAt,
      topics: item.topics,
      impact: item.impact,
      score: item.impactScore,
    }));
  }

  clustersSince(since: number): Promise<HeadlineCluster[]> {
    this.check();
    const ids = new Set(
      this.itemList.filter((item) => item.firstSeenAt >= since).map((item) => item.clusterId),
    );
    return Promise.resolve(
      buildClusters(this.clusterItems(this.itemList.filter((item) => ids.has(item.clusterId)))),
    );
  }

  // ------------------------------------------------------------------------------- the samples

  unmeasured(since: number, until: number): Promise<HeadlineCluster[]> {
    this.check();
    return Promise.resolve(
      buildClusters(this.clusterItems(this.itemList)).filter(
        (cluster) =>
          !this.samples.has(cluster.id) && timeOf(cluster) >= since && timeOf(cluster) <= until,
      ),
    );
  }

  saveSample(sample: SampleRecord): Promise<boolean> {
    this.check();
    if (this.samples.has(sample.clusterId)) return Promise.resolve(false);
    this.samples.set(sample.clusterId, sample);
    return Promise.resolve(true);
  }

  rebuildStats(_at: number): Promise<number> {
    this.check();
    const rows = topicStats(
      [...this.samples.values()].map((sample) => ({
        topics: sample.topics,
        impact: sample.impact,
        session: sample.session,
        atr5: sample.atr5,
        move10m: sample.move10m,
        maxAbs10m: sample.maxAbs10m,
      })),
    );
    for (const row of rows) {
      const key = `${row.topic}|${row.impact}`;
      this.stats.set(key, { ...row, baseline: this.stats.get(key)?.baseline ?? null });
    }
    return Promise.resolve(rows.length);
  }

  sampleSessions(): Promise<
    { topic: NewsTopic; impact: NewsImpact; session: Session; n: number }[]
  > {
    this.check();
    const counts = new Map<
      string,
      { topic: NewsTopic; impact: NewsImpact; session: Session; n: number }
    >();
    for (const sample of this.samples.values()) {
      for (const topic of new Set(sample.topics)) {
        const key = `${topic}|${sample.impact}|${sample.session}`;
        const row = counts.get(key) ?? {
          topic,
          impact: sample.impact,
          session: sample.session,
          n: 0,
        };
        row.n += 1;
        counts.set(key, row);
      }
    }
    return Promise.resolve([...counts.values()]);
  }

  saveBaselines(
    rows: readonly { topic: NewsTopic; impact: NewsImpact; baseline: number | null }[],
  ): Promise<void> {
    this.check();
    for (const row of rows) {
      const key = `${row.topic}|${row.impact}`;
      const old = this.stats.get(key);
      if (old !== undefined) this.stats.set(key, { ...old, baseline: row.baseline });
    }
    return Promise.resolve();
  }

  topicStats(): Promise<TopicStatRow[]> {
    this.check();
    return Promise.resolve(
      [...this.stats.values()].sort(
        (a, b) => a.topic.localeCompare(b.topic) || a.impact.localeCompare(b.impact),
      ),
    );
  }

  eventTimes(from: number, until: number): Promise<number[]> {
    this.check();
    const times = [
      ...this.itemList.map((item) => item.publishedAt ?? item.firstSeenAt),
      ...this.highEventTimes,
    ];
    return Promise.resolve(
      times.filter((time) => time >= from && time <= until).sort((a, b) => a - b),
    );
  }

  // ------------------------------------------------------------------------------- the moves

  insertMove(move: MarketMoveRecord): Promise<number> {
    this.check();
    const id = this.moveList.length + 1;
    this.moveList.push({ ...move, id });
    return Promise.resolve(id);
  }

  lastMoveAt(): Promise<number | null> {
    this.check();
    return Promise.resolve(
      this.moveList.length === 0 ? null : Math.max(...this.moveList.map((move) => move.detectedAt)),
    );
  }

  moves(): Promise<(MarketMoveRecord & { readonly id: number })[]> {
    this.check();
    return Promise.resolve([...this.moveList].sort((a, b) => a.id - b.id));
  }
}
