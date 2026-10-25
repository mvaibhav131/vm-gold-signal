import { diceSimilarity, normalizeTitle, sharedTokens, titleTokens } from './text';

/** A story from another outlet is the same story when it came within this long of the first. */
export const CLUSTER_WINDOW_MS = 60 * 60_000;
/** Two titles are one story at this Dice similarity of their words ... */
export const CLUSTER_MIN_SIMILARITY = 0.6;
/** ... and at least this many words in common (a short title must be the same title). */
export const CLUSTER_MIN_SHARED = 3;

/** An item that is already stored, as far as the clustering needs it. */
export interface ClusterEntry {
  readonly clusterId: string;
  readonly tokens: readonly string[];
  readonly normalized: string;
  /** Published time, or first seen when the feed gave none. */
  readonly at: number;
}

export interface ClusterProbe {
  readonly title: string;
  readonly at: number;
}

/** What the clustering needs to know about a title, computed once. */
export function probeOf(title: string, at: number): ClusterEntry & { readonly title: string } {
  return {
    clusterId: '',
    title,
    tokens: titleTokens(title),
    normalized: normalizeTitle(title),
    at,
  };
}

/** Two titles tell the same story. */
export function sameStory(
  a: Pick<ClusterEntry, 'tokens' | 'normalized'>,
  b: Pick<ClusterEntry, 'tokens' | 'normalized'>,
): boolean {
  if (a.normalized !== '' && a.normalized === b.normalized) return true;
  return (
    sharedTokens(a.tokens, b.tokens) >= CLUSTER_MIN_SHARED &&
    diceSimilarity(a.tokens, b.tokens) >= CLUSTER_MIN_SIMILARITY
  );
}

/**
 * The cluster that a new item joins: the stored item of the same story, published within an hour
 * of it, that is the most alike (the older one and then the smaller id when two are equally alike).
 * Null when it is a story of its own.
 */
export function findCluster(
  probe: Pick<ClusterEntry, 'tokens' | 'normalized' | 'at'>,
  entries: readonly ClusterEntry[],
): string | null {
  let best: { entry: ClusterEntry; score: number } | null = null;
  for (const entry of entries) {
    if (Math.abs(entry.at - probe.at) > CLUSTER_WINDOW_MS) continue;
    if (!sameStory(probe, entry)) continue;
    const score =
      entry.normalized === probe.normalized ? 2 : diceSimilarity(probe.tokens, entry.tokens);
    if (
      best === null ||
      score > best.score ||
      (score === best.score &&
        (entry.at < best.entry.at ||
          (entry.at === best.entry.at && entry.clusterId < best.entry.clusterId)))
    ) {
      best = { entry, score };
    }
  }
  return best === null ? null : best.entry.clusterId;
}
