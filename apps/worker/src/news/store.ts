import type {
  ClusterItem,
  HeadlineCluster,
  HeadlineSource,
  NewsImpact,
  NewsTopic,
  Session,
  SourceTier,
  StatCandle,
  TickPoint,
} from '@vmgs/core';
import type { ExplanationHeadline } from '@vmgs/core';

/** A feed as `news_sources` holds it. `enabled` is the owner's switch; the poller never changes it. */
export interface NewsSourceRow extends HeadlineSource {
  readonly tier: SourceTier;
}

/** An item ready to be stored: classified and given its cluster. */
export interface NewItem {
  readonly sourceKey: string;
  /** The hash of the canonical link: with the source it is what makes an item the same item. */
  readonly urlHash: string;
  readonly title: string;
  readonly url: string;
  readonly summary: string | null;
  readonly publishedAt: number | null;
  readonly firstSeenAt: number;
  readonly topics: readonly NewsTopic[];
  readonly impact: NewsImpact;
  readonly impactScore: number;
  readonly clusterId: string;
  readonly classifierVersion: string;
}

export interface StoredItem extends NewItem {
  readonly id: string;
}

/** A stored item as the clustering needs it. */
export interface RecentItem {
  readonly clusterId: string;
  readonly title: string;
  /** Published time, or first seen when the feed gave none. */
  readonly at: number;
}

/** The headlines (`news_sources`, `news_items`), as the poller, the alerts and the context read them. */
export interface NewsStore {
  /** Adds the feeds that are not there and updates the name and the tier of those that are; never touches `enabled`. */
  ensureSources(feeds: readonly { key: string; name: string; tier: SourceTier }[]): Promise<void>;
  sources(): Promise<NewsSourceRow[]>;
  /** The feed answered well at `at`: its last good time moves and its error is cleared. */
  recordOk(key: string, at: number): Promise<void>;
  /** The feed failed: its error is kept; its last good time stays. */
  recordError(key: string, error: string): Promise<void>;
  /** Items whose time is at least `since`, for the clustering of a new item. */
  recentItems(since: number): Promise<RecentItem[]>;
  /**
   * Stores the items that are not there yet (`UNIQUE(source_key, url_hash)`) and returns only those that
   * were new. Several items with one source and hash in a batch count once, the first.
   */
  insertItems(items: readonly NewItem[]): Promise<StoredItem[]>;
  /** The stories that have an item first seen at or after `since`, with all their items, in the order first seen. */
  clustersSince(since: number): Promise<HeadlineCluster[]>;
  /** Every stored item with its source, for tests and the contract. */
  items(): Promise<ClusterItem[]>;
}

/** A story that has not been measured yet. */
export interface SampleRecord {
  readonly clusterId: string;
  readonly topics: readonly NewsTopic[];
  readonly impact: NewsImpact;
  readonly publishedAt: number;
  readonly session: Session;
  readonly atr5: number;
  readonly move2m: number | null;
  readonly move5m: number | null;
  readonly move10m: number;
  readonly maxAbs10m: number;
}

export interface TopicStatRow {
  readonly topic: NewsTopic;
  readonly impact: NewsImpact;
  readonly n: number;
  readonly moved1atr: number;
  readonly sumAbsAtr10m: number;
  readonly sumSignedAtr10m: number;
  readonly baseline: number | null;
}

/** The measured impact of headlines (`news_impact_samples`, `news_topic_stats`). */
export interface ImpactStore {
  /** The stories with a time from `since` to `until` that have no sample yet, in the order first seen. */
  unmeasured(since: number, until: number): Promise<HeadlineCluster[]>;
  /** Keeps a sample (one for each story); false when the story already had one. */
  saveSample(sample: SampleRecord): Promise<boolean>;
  /** Recomputes every row of the topic statistics from the samples, keeping the baselines; returns how many rows. */
  rebuildStats(at: number): Promise<number>;
  /** How many samples of each topic and impact began in each session (the weights of the baseline). */
  sampleSessions(): Promise<
    { topic: NewsTopic; impact: NewsImpact; session: Session; n: number }[]
  >;
  saveBaselines(
    rows: readonly { topic: NewsTopic; impact: NewsImpact; baseline: number | null }[],
  ): Promise<void>;
  topicStats(): Promise<TopicStatRow[]>;
  /** The times of the stories and the HIGH calendar events from `from` to `until`: windows near them are not ordinary. */
  eventTimes(from: number, until: number): Promise<number[]>;
}

export interface MarketMoveRecord {
  readonly kind: 'SPIKE_UP' | 'SPIKE_DOWN';
  readonly detectedAt: number;
  readonly windowS: number;
  readonly moveUsd: number;
  readonly moveAtr: number;
  readonly spread: number | null;
  /** The headlines that were around the move, frozen. */
  readonly headlines: readonly ExplanationHeadline[];
  readonly meta: Readonly<Record<string, unknown>>;
}

/** The sudden moves of gold (`market_events`). */
export interface MoveStore {
  /** Keeps a move and returns its id. */
  insertMove(move: MarketMoveRecord): Promise<number>;
  /** When the latest move was detected; null if there was none. */
  lastMoveAt(): Promise<number | null>;
  moves(): Promise<(MarketMoveRecord & { readonly id: number })[]>;
}

/** The stored market: ticks and closed candles of the traded symbol. */
export interface MarketReader {
  /** Ticks with a provider time from `from` to `until` (both included), by time. */
  ticks(from: number, until: number): Promise<TickPoint[]>;
  /** The last `limit` complete candles of `tf` that had closed by `until`, oldest first. */
  closedCandles(tf: '1m' | '5m', until: number, limit: number): Promise<StatCandle[]>;
  /** The complete candles of `tf` that opened from `from` to before `until`, oldest first. */
  candlesBetween(tf: '1m' | '5m', from: number, until: number): Promise<StatCandle[]>;
}
