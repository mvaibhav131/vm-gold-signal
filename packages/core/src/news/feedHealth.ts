import type { NewsFeedState } from '../domain';

/** A feed that has not answered for this long has a problem (05_UI_Spec: News, headlines and feeds). */
export const HEADLINE_FEED_SILENT_MS = 10 * 60_000;

/** A headline feed as `news_sources` holds it (times in epoch milliseconds). */
export interface HeadlineSource {
  readonly key: string;
  readonly name: string;
  readonly enabled: boolean;
  /** The last time the feed answered well; null if it never did. */
  readonly lastOkAt: number | null;
  /** The error of the last try; null when it worked. */
  readonly lastError: string | null;
}

export type HeadlineFeedProblemReason = 'ERROR' | 'NEVER' | 'SILENT';

export interface HeadlineFeedProblem {
  readonly key: string;
  readonly name: string;
  readonly reason: HeadlineFeedProblemReason;
  readonly detail: string | null;
}

export type HeadlineFeedStatus = 'OK' | 'PARTIAL' | 'DOWN' | 'NONE_ENABLED';

export interface HeadlineFeedHealth {
  readonly status: HeadlineFeedStatus;
  readonly enabled: number;
  readonly problems: readonly HeadlineFeedProblem[];
}

function problemOf(source: HeadlineSource, now: number): HeadlineFeedProblem | null {
  if (source.lastError !== null) {
    return { key: source.key, name: source.name, reason: 'ERROR', detail: source.lastError };
  }
  if (source.lastOkAt === null) {
    return { key: source.key, name: source.name, reason: 'NEVER', detail: null };
  }
  if (now - source.lastOkAt > HEADLINE_FEED_SILENT_MS) {
    return { key: source.key, name: source.name, reason: 'SILENT', detail: null };
  }
  return null;
}

/**
 * The state of the headline feeds, as the News page and the dashboard card derive it: a feed that is
 * switched on and has an error, never answered, or has been silent for more than 10 minutes has a
 * problem. DOWN when every feed that is on has one, PARTIAL when some do, and "none switched on" is
 * a state of its own.
 */
export function headlineFeedHealth(
  sources: readonly HeadlineSource[],
  now: number,
): HeadlineFeedHealth {
  const enabled = sources.filter((source) => source.enabled);
  if (enabled.length === 0) return { status: 'NONE_ENABLED', enabled: 0, problems: [] };
  const problems = enabled.flatMap((source) => problemOf(source, now) ?? []);
  const status =
    problems.length === 0 ? 'OK' : problems.length === enabled.length ? 'DOWN' : 'PARTIAL';
  return { status, enabled: enabled.length, problems };
}

/**
 * Whether "no headline" can be said: it cannot while the feeds are down or none is switched on.
 * The signal message and the market-move message then say "headline feed unavailable".
 */
export function newsFeedState(health: HeadlineFeedHealth): NewsFeedState {
  return health.status === 'DOWN' || health.status === 'NONE_ENABLED' ? 'UNAVAILABLE' : 'AVAILABLE';
}

export interface HeadlineIncident {
  /** When the last of the feeds went silent (the latest good answer): the same value after a restart. */
  readonly startedAt: number;
  readonly silentMs: number;
}

/**
 * The outage worth telling the owner about: every feed that is on has been silent for more than 10
 * minutes (a single failed try is not an outage), and at least one of them did answer once, so
 * there is a moment to say it began. A system that never got a headline reports nothing here (the
 * News page banner says it).
 */
export function headlineIncident(
  sources: readonly HeadlineSource[],
  now: number,
): HeadlineIncident | null {
  const enabled = sources.filter((source) => source.enabled);
  if (enabled.length === 0) return null;
  let startedAt: number | null = null;
  for (const source of enabled) {
    if (source.lastOkAt !== null && now - source.lastOkAt <= HEADLINE_FEED_SILENT_MS) return null;
    if (source.lastOkAt !== null && (startedAt === null || source.lastOkAt > startedAt)) {
      startedAt = source.lastOkAt;
    }
  }
  return startedAt === null ? null : { startedAt, silentMs: Math.max(0, now - startedAt) };
}
