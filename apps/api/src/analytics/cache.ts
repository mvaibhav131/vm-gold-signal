/** How long an analytics answer is kept (04 section 2: "cached for 30 s"). */
export const ANALYTICS_CACHE_MS = 30_000;
/** The most answers kept at once: the query is the visitor's, so the number of keys must not be. */
export const ANALYTICS_CACHE_ENTRIES = 256;

export interface AnswerCacheOptions {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly now: () => number;
}

interface Entry {
  /** When the work that made the answer began: the answer is no older than `ttlMs` from there. */
  readonly at: number;
  readonly value: unknown;
}

/**
 * Answers by key, each kept for `ttlMs` by the clock of the service. A request that comes while its answer is being
 * worked out shares that work, and a computation that fails is not kept (the next request tries again). An answer
 * stamped in the future (the clock moved back) is not trusted.
 */
export class AnswerCache {
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(private readonly options: AnswerCacheOptions) {}

  get size(): number {
    return this.entries.size;
  }

  get<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const now = this.options.now();
    const kept = this.entries.get(key);
    if (kept !== undefined && this.fresh(kept, now)) return Promise.resolve(kept.value as T);
    const shared = this.running.get(key);
    if (shared !== undefined) return shared as Promise<T>;

    // `then` defers the work, so that it is registered before anything it does (a failure included) can unregister it
    const work = Promise.resolve()
      .then(compute)
      .then((value) => {
        this.keep(key, value, now);
        return value;
      })
      .finally(() => {
        this.running.delete(key);
      });
    this.running.set(key, work);
    return work;
  }

  private fresh(entry: Entry, now: number): boolean {
    return now >= entry.at && now - entry.at < this.options.ttlMs;
  }

  private keep(key: string, value: unknown, at: number): void {
    this.entries.delete(key);
    this.entries.set(key, { at, value });
    if (this.entries.size <= this.options.maxEntries) return;
    const now = this.options.now();
    for (const [other, entry] of this.entries) {
      if (!this.fresh(entry, now)) this.entries.delete(other);
    }
    // a Map iterates in the order of insertion: the oldest answer goes first
    for (const other of this.entries.keys()) {
      if (this.entries.size <= this.options.maxEntries) break;
      this.entries.delete(other);
    }
  }
}
