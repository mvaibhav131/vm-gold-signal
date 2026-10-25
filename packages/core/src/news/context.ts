import type { NewsImpact, NewsTopic } from '../domain';
import type { ExplanationHeadline } from '../explain/types';

/** A headline is part of the context of a signal for this long (the "News (last 60 min)" line). */
export const CONTEXT_WINDOW_MS = 60 * 60_000;
/** The most headlines the line of a signal shows. */
export const CONTEXT_MAX_HEADLINES = 3;
/** A headline is a possible cause of a move when it came in the 30 minutes before it. */
export const CAUSE_WINDOW_MS = 30 * 60_000;
/** The most classified headlines of the "possible causes" list, and the most unclassified ones after them. */
export const CAUSE_MAX_CLASSIFIED = 5;
export const CAUSE_MAX_UNCLASSIFIED = 3;
/** A headline alert is sent only for a story that is at most this old (a feed that lags is not news). */
export const HEADLINE_ALERT_MAX_AGE_MS = 30 * 60_000;

/** A story from one or more outlets, as the alerts and the context read it. */
export interface HeadlineCluster {
  readonly id: string;
  /** The title of the strongest item of the story. */
  readonly title: string;
  readonly url: string;
  /** The outlets that ran it, in the order they were seen. */
  readonly sources: readonly { readonly key: string; readonly name: string }[];
  readonly topics: readonly NewsTopic[];
  readonly impact: NewsImpact;
  /** The earliest published time of its items; null when no feed gave one. */
  readonly publishedAt: number | null;
  /** When the first of its items was seen. */
  readonly firstSeenAt: number;
}

/** A headline that no rule recognised, kept for a short time so that a move can still show what was around it. */
export interface UnclassifiedHeadline {
  readonly title: string;
  readonly url: string;
  readonly sourceName: string;
  readonly publishedAt: number | null;
  readonly firstSeenAt: number;
}

/** The time that decides where a story sits in the day: published, or first seen when the feed gave none. */
export const timeOf = (item: {
  readonly publishedAt: number | null;
  readonly firstSeenAt: number;
}): number => item.publishedAt ?? item.firstSeenAt;

const RANK: Readonly<Record<NewsImpact, number>> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/** HIGH first, then MEDIUM and LOW, the newest first within an impact, the id deciding a tie. */
function byImpactThenNewest(a: HeadlineCluster, b: HeadlineCluster): number {
  return RANK[b.impact] - RANK[a.impact] || timeOf(b) - timeOf(a) || a.id.localeCompare(b.id);
}

/** One stored item, as `buildClusters` reads it. */
export interface ClusterItem {
  readonly id: string;
  readonly clusterId: string;
  readonly sourceKey: string;
  readonly sourceName: string;
  readonly title: string;
  readonly url: string;
  readonly publishedAt: number | null;
  readonly firstSeenAt: number;
  readonly topics: readonly NewsTopic[];
  readonly impact: NewsImpact;
  readonly score: number;
}

/**
 * Stories made of their items. The title and the link are those of the strongest item (the earliest
 * seen when two are equal), the outlets are in the order they were first seen, the topics are those of
 * the strongest item first and then any other item's, the impact is the highest of its items, and the time
 * is the earliest published time (the earliest seen time for the story's `firstSeenAt`). Clusters come
 * in the order they were first seen.
 */
export function buildClusters(items: readonly ClusterItem[]): HeadlineCluster[] {
  const groups = new Map<string, ClusterItem[]>();
  for (const item of items)
    groups.set(item.clusterId, [...(groups.get(item.clusterId) ?? []), item]);
  const clusters: HeadlineCluster[] = [];
  for (const [id, group] of groups) {
    const bySeen = [...group].sort(
      (a, b) => a.firstSeenAt - b.firstSeenAt || a.id.localeCompare(b.id),
    );
    const strongest = [...bySeen].sort((a, b) => b.score - a.score)[0];
    if (strongest === undefined) continue;
    const topics: NewsTopic[] = [];
    for (const item of [strongest, ...bySeen]) {
      for (const topic of item.topics) if (!topics.includes(topic)) topics.push(topic);
    }
    const sources: { key: string; name: string }[] = [];
    for (const item of bySeen) {
      if (!sources.some((source) => source.key === item.sourceKey)) {
        sources.push({ key: item.sourceKey, name: item.sourceName });
      }
    }
    const published = bySeen.flatMap((item) =>
      item.publishedAt === null ? [] : [item.publishedAt],
    );
    clusters.push({
      id,
      title: strongest.title,
      url: strongest.url,
      sources,
      topics,
      impact: bySeen.reduce<NewsImpact>(
        (best, item) => (RANK[item.impact] > RANK[best] ? item.impact : best),
        'LOW',
      ),
      publishedAt: published.length === 0 ? null : Math.min(...published),
      firstSeenAt: bySeen[0]?.firstSeenAt ?? 0,
    });
  }
  return clusters.sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.id.localeCompare(b.id));
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** The frozen copy of a story, as a signal explanation and a market move keep it. */
export function frozenHeadline(cluster: HeadlineCluster): ExplanationHeadline {
  return {
    title: cluster.title,
    sources: cluster.sources.map((source) => source.name),
    publishedAt: iso(cluster.publishedAt),
    impact: cluster.impact,
    topics: [...cluster.topics],
    url: cluster.url,
    classified: true,
  };
}

/** The frozen copy of a headline that no rule recognised: timing only, no impact and no topics. */
export function frozenUnclassified(item: UnclassifiedHeadline): ExplanationHeadline {
  return {
    title: item.title,
    sources: [item.sourceName],
    publishedAt: iso(item.publishedAt),
    impact: null,
    topics: [],
    url: item.url,
    classified: false,
  };
}

/**
 * The "News (last 60 min)" line of a signal: the stories of the last hour, HIGH first and the newest
 * first within an impact, at most three (02 section 16, "Use inside signals and reviews").
 */
export function contextHeadlines(
  clusters: readonly HeadlineCluster[],
  now: number,
): ExplanationHeadline[] {
  return clusters
    .filter((cluster) => timeOf(cluster) <= now && now - timeOf(cluster) <= CONTEXT_WINDOW_MS)
    .sort(byImpactThenNewest)
    .slice(0, CONTEXT_MAX_HEADLINES)
    .map(frozenHeadline);
}

/** When the newest HIGH story was published (first seen when it has no time): the input of `HEADLINE_RECENT`. */
export function lastHighHeadlineAt(
  clusters: readonly HeadlineCluster[],
  now: number,
): number | null {
  let latest: number | null = null;
  for (const cluster of clusters) {
    const at = timeOf(cluster);
    if (cluster.impact === 'HIGH' && at <= now && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

/** One entry of the "possible causes" of a move. */
export interface Cause {
  readonly headline: ExplanationHeadline;
  /** When it was published or first seen. */
  readonly at: number;
}

/**
 * The headlines of the 30 minutes before a move, as possible causes and nothing more: the stories
 * that were classified first (HIGH first, the newest first, at most five), then up to three that no
 * rule recognised, the closest to the move in time first.
 */
export function possibleCauses(
  clusters: readonly HeadlineCluster[],
  unclassified: readonly UnclassifiedHeadline[],
  at: number,
): Cause[] {
  const inWindow = (time: number): boolean => time <= at && at - time <= CAUSE_WINDOW_MS;
  const classified = clusters
    .filter((cluster) => inWindow(timeOf(cluster)))
    .sort(byImpactThenNewest)
    .slice(0, CAUSE_MAX_CLASSIFIED)
    .map((cluster) => ({ headline: frozenHeadline(cluster), at: timeOf(cluster) }));
  const others = unclassified
    .filter((item) => inWindow(timeOf(item)))
    .sort((a, b) => at - timeOf(a) - (at - timeOf(b)) || a.title.localeCompare(b.title))
    .slice(0, CAUSE_MAX_UNCLASSIFIED)
    .map((item) => ({ headline: frozenUnclassified(item), at: timeOf(item) }));
  return [...classified, ...others];
}
