import type { HeadlinesResponse } from '@vmgs/contracts';

import { formatSpan } from '../format/time';

export type NewsSourceHealth = HeadlinesResponse['sources'][number];

/** A feed is polled every minute; one that has not answered for this long is not working. */
export const FEED_STALE_AFTER_MS = 10 * 60_000;

/** Why a feed is not working, in words, or null when it is working or the owner switched it off. */
export function sourceProblem(source: NewsSourceHealth, nowMs: number): string | null {
  if (!source.enabled) return null;
  if (source.lastError !== null) return source.lastError;
  if (source.lastOkAt === null) return 'No successful poll yet';
  const silentMs = nowMs - Date.parse(source.lastOkAt);
  if (silentMs > FEED_STALE_AFTER_MS) {
    return `No successful poll for ${formatSpan(silentMs / 1000)}`;
  }
  return null;
}

export interface FeedStatus {
  /** `NONE`: no feed is switched on, so there is nothing to be down. */
  readonly state: 'OK' | 'PARTIAL' | 'DOWN' | 'NONE';
  readonly enabled: number;
  readonly problems: readonly { readonly source: NewsSourceHealth; readonly reason: string }[];
}

/**
 * The state of the headline feeds as one answer, so that "no headlines" can never be taken for
 * "the feeds are down": `DOWN` when every feed that is switched on has a problem, `PARTIAL` when some do.
 */
export function headlineFeedStatus(
  sources: readonly NewsSourceHealth[],
  nowMs: number,
): FeedStatus {
  const enabled = sources.filter((source) => source.enabled);
  const problems = enabled.flatMap((source) => {
    const reason = sourceProblem(source, nowMs);
    return reason === null ? [] : [{ source, reason }];
  });
  if (enabled.length === 0) return { state: 'NONE', enabled: 0, problems };
  if (problems.length === 0) return { state: 'OK', enabled: enabled.length, problems };
  return {
    state: problems.length === enabled.length ? 'DOWN' : 'PARTIAL',
    enabled: enabled.length,
    problems,
  };
}
