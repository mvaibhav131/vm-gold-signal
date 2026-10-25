import { createHash, randomUUID } from 'node:crypto';

import {
  CLASSIFIER_VERSION,
  MAX_ITEM_AGE_MS,
  classify,
  findCluster,
  probeOf,
  type ClusterEntry,
} from '@vmgs/core';

import type { UnclassifiedBuffer } from './buffer';
import type { FeedReading, FeedSource, Validators } from './feeds';
import { canonicalUrl } from './parsers';
import type { NewItem, NewsStore, StoredItem } from './store';

/** A feed is read this often when it works (02 section 16: every 60 s). */
export const FEED_POLL_MS = 60_000;
/** The wait after the first, second and later failures of a feed; the last is kept. */
export const FEED_FAILURE_DELAYS_MS = [120_000, 300_000, 600_000] as const;
/** The stories of this long ago are looked at when a new item is clustered. */
const CLUSTER_MEMORY_MS = 3 * 60 * 60_000;
/** The links already seen are remembered, up to this many, so that a feed that repeats itself costs nothing. */
const SEEN_MAX = 5_000;

export interface NewsPollerOptions {
  readonly feeds: readonly FeedSource[];
  readonly client: { read(source: FeedSource, validators: Validators): Promise<FeedReading> };
  readonly store: Pick<
    NewsStore,
    'ensureSources' | 'sources' | 'recordOk' | 'recordError' | 'recentItems' | 'insertItems'
  >;
  readonly buffer: UnclassifiedBuffer;
  /** New stories or new items were stored. */
  readonly onNew?: (items: readonly StoredItem[]) => void;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly log?: (
    level: 'info' | 'error',
    message: string,
    details?: Record<string, unknown>,
  ) => void;
}

export interface FeedPoll {
  readonly key: string;
  readonly ok: boolean;
  /** Items stored that were not there before. */
  readonly stored: number;
  /** The wait until this feed is read again. */
  readonly delayMs: number;
}

const urlHash = (url: string): string =>
  createHash('sha256').update(canonicalUrl(url)).digest('hex');

/**
 * Reads the headline feeds into `news_items`: each feed on its own clock (every 60 s, and after a failure
 * 2, 5 and then 10 minutes), with conditional requests; classifies every item, drops what is not about
 * gold into the 2-hour buffer, joins the stories that other outlets also ran, and stores the rest. A feed that
 * fails costs only itself: its error is kept and the others go on. An item older than 6 hours is not kept.
 */
export class NewsPoller {
  private readonly options: NewsPollerOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly log: NonNullable<NewsPollerOptions['log']>;
  private readonly validators = new Map<string, Validators>();
  private readonly failures = new Map<string, number>();
  private readonly nextDue = new Map<string, number>();
  private readonly seen = new Set<string>();
  private entries: ClusterEntry[] = [];
  private loaded = false;
  private polls = 0;
  private storedTotal = 0;
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(options: NewsPollerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.log = options.log ?? (() => undefined);
  }

  get stats(): { polls: number; stored: number } {
    return { polls: this.polls, stored: this.storedTotal };
  }

  /** One pass over the feeds that are due (all of them with `all`). Never throws. */
  async runOnce(all = false): Promise<FeedPoll[]> {
    const now = this.now();
    let enabled: Set<string>;
    try {
      if (!this.loaded) await this.load(now);
      enabled = new Set(
        (await this.options.store.sources()).filter((row) => row.enabled).map((row) => row.key),
      );
    } catch (error) {
      this.log('error', 'the news poller could not reach the database', { error: message(error) });
      return [];
    }
    const due = this.options.feeds.filter(
      (feed) => enabled.has(feed.key) && (all || (this.nextDue.get(feed.key) ?? 0) <= now),
    );
    // the feeds are read together, but stored one after the other, so the clustering sees each in turn
    const readings = await Promise.all(due.map((feed) => this.read(feed)));
    const polls: FeedPoll[] = [];
    for (const reading of readings) polls.push(await this.settle(reading));
    return polls;
  }

  private async load(now: number): Promise<void> {
    await this.options.store.ensureSources(
      this.options.feeds.map(({ key, name, tier }) => ({ key, name, tier })),
    );
    const recent = await this.options.store.recentItems(now - CLUSTER_MEMORY_MS);
    this.entries = recent.map((item) => {
      const probe = probeOf(item.title, item.at);
      return {
        clusterId: item.clusterId,
        tokens: probe.tokens,
        normalized: probe.normalized,
        at: item.at,
      };
    });
    this.loaded = true;
  }

  private async read(
    feed: FeedSource,
  ): Promise<{ feed: FeedSource; reading: FeedReading | null; error: unknown }> {
    this.polls += 1;
    try {
      const reading = await this.options.client.read(
        feed,
        this.validators.get(feed.key) ?? { etag: null, lastModified: null },
      );
      return { feed, reading, error: null };
    } catch (error) {
      return { feed, reading: null, error };
    }
  }

  private async settle(result: {
    feed: FeedSource;
    reading: FeedReading | null;
    error: unknown;
  }): Promise<FeedPoll> {
    const { feed, reading } = result;
    const now = this.now();
    if (reading === null) {
      return this.failed(feed, result.error, now);
    }
    let stored: StoredItem[];
    try {
      stored = await this.ingest(feed, reading, now);
      await this.options.store.recordOk(feed.key, now);
    } catch (error) {
      // the feed worked, the database did not: the copy is not marked as read, and the next pass reads it again
      this.log('error', 'a headline feed could not be stored', {
        feed: feed.key,
        error: message(error),
      });
      this.nextDue.set(feed.key, now + FEED_POLL_MS);
      return { key: feed.key, ok: false, stored: 0, delayMs: FEED_POLL_MS };
    }
    this.validators.set(feed.key, reading.validators);
    if ((this.failures.get(feed.key) ?? 0) > 0) {
      this.log('info', 'a headline feed can be read again', { feed: feed.key });
    }
    this.failures.set(feed.key, 0);
    this.nextDue.set(feed.key, now + FEED_POLL_MS);
    this.storedTotal += stored.length;
    if (stored.length > 0) this.options.onNew?.(stored);
    return { key: feed.key, ok: true, stored: stored.length, delayMs: FEED_POLL_MS };
  }

  private async failed(feed: FeedSource, error: unknown, now: number): Promise<FeedPoll> {
    const failures = (this.failures.get(feed.key) ?? 0) + 1;
    this.failures.set(feed.key, failures);
    const delayMs =
      FEED_FAILURE_DELAYS_MS[Math.min(failures, FEED_FAILURE_DELAYS_MS.length) - 1] ??
      FEED_FAILURE_DELAYS_MS[0];
    this.nextDue.set(feed.key, now + delayMs);
    this.log('error', 'a headline feed could not be read', {
      feed: feed.key,
      error: message(error),
      failures,
    });
    await this.options.store.recordError(feed.key, message(error)).catch(() => undefined);
    return { key: feed.key, ok: false, stored: 0, delayMs };
  }

  /** Classifies, clusters and stores the items of a reading; returns the items that were new. */
  private async ingest(feed: FeedSource, reading: FeedReading, now: number): Promise<StoredItem[]> {
    const fresh: NewItem[] = [];
    const keys: string[] = [];
    const items = [...reading.items].sort(
      (a, b) => (a.publishedAt ?? now) - (b.publishedAt ?? now),
    );
    for (const item of items) {
      const hash = urlHash(item.url);
      const key = `${feed.key}|${hash}`;
      if (this.seen.has(key)) continue;
      if (item.publishedAt !== null && now - item.publishedAt > MAX_ITEM_AGE_MS) continue;
      this.remember(key);
      keys.push(key);
      const classification = classify({
        title: item.title,
        summary: item.summary,
        tier: feed.tier,
        ageMs: item.publishedAt === null ? 0 : Math.max(0, now - item.publishedAt),
      });
      if (classification === null) {
        this.options.buffer.add({
          title: item.title,
          url: item.url,
          sourceName: feed.name,
          publishedAt: item.publishedAt,
          firstSeenAt: now,
        });
        continue;
      }
      const at = item.publishedAt ?? now;
      const probe = probeOf(item.title, at);
      const clusterId = findCluster(probe, this.entries) ?? this.newId();
      this.entries.push({ clusterId, tokens: probe.tokens, normalized: probe.normalized, at });
      fresh.push({
        sourceKey: feed.key,
        urlHash: hash,
        title: item.title,
        url: item.url,
        summary: item.summary,
        publishedAt: item.publishedAt,
        firstSeenAt: now,
        topics: classification.topics,
        impact: classification.impact,
        impactScore: classification.score,
        clusterId,
        classifierVersion: CLASSIFIER_VERSION,
      });
    }
    this.entries = this.entries.filter((entry) => now - entry.at <= CLUSTER_MEMORY_MS);
    if (fresh.length === 0) return [];
    try {
      return await this.options.store.insertItems(fresh);
    } catch (error) {
      // not stored: they must be read again, not taken for seen
      for (const key of keys) this.seen.delete(key);
      throw error;
    }
  }

  private remember(key: string): void {
    this.seen.add(key);
    if (this.seen.size > SEEN_MAX) {
      const [oldest] = this.seen;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = null;
  }

  private async run(): Promise<void> {
    while (this.running) {
      await this.runOnce();
      if (this.stopped()) break;
      const nextAt = Math.min(...this.options.feeds.map((feed) => this.nextDue.get(feed.key) ?? 0));
      const wait = Math.min(Math.max(nextAt - this.now(), 1_000), FEED_POLL_MS);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  /** `stop()` may be called while a pass is awaited; the loop condition alone would not see it. */
  private stopped(): boolean {
    return !this.running;
  }
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
