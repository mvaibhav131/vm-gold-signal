import { findCandleGaps, tradingMsBetween, type FeedGap } from '@vmgs/core';

/**
 * WEEKEND: the weekly closure (Friday 17:00 to Sunday 17:00 New York). DAILY_BREAK: the one hour
 * break that most gold feeds take around 17:00 New York. FEED: any other hole in the data.
 */
export type GapClass = 'WEEKEND' | 'DAILY_BREAK' | 'FEED';

/** A gap inside this window of the UTC day (the break is at 21:00 or 22:00 UTC, by daylight saving) and at most this long is the daily break. */
const DAILY_BREAK = { fromHour: 21, untilHour: 23.5, maxMs: 90 * 60_000 } as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The closure is 48 hours; a holiday Friday or Monday makes it 72 to 74. A longer hole that contains a weekend is a hole in the data. */
export const WEEKEND_MAX_MS = 84 * HOUR_MS;

export function classOfGap(gap: FeedGap): GapClass {
  if (gap.kind === 'WEEKEND') return gap.durationMs <= WEEKEND_MAX_MS ? 'WEEKEND' : 'FEED';
  const day = Math.floor(gap.startMs / DAY_MS) * DAY_MS;
  const inWindow =
    gap.startMs >= day + DAILY_BREAK.fromHour * HOUR_MS &&
    gap.endMs <= day + DAILY_BREAK.untilHour * HOUR_MS;
  return inWindow && gap.durationMs <= DAILY_BREAK.maxMs ? 'DAILY_BREAK' : 'FEED';
}

export interface LongGap {
  readonly startMs: number;
  readonly endMs: number;
  /** Minutes of an open market in it: a weekend inside a long hole is not counted. */
  readonly minutes: number;
}

export interface GapReport {
  readonly weekend: number;
  readonly dailyBreak: number;
  /** Holes that are neither the weekend nor the daily break. */
  readonly feed: number;
  readonly missingFeedMinutes: number;
  /** Minutes present over minutes present plus missing ones outside the expected closures. */
  readonly coveragePct: number;
  /** The longest unexpected holes, longest first. */
  readonly longest: readonly LongGap[];
}

const LONGEST = 10;

/** Where a series of 1m candles has holes, told apart into the expected closures and the unexpected ones. */
export function gapReport(minutes: readonly { readonly openTime: number }[]): GapReport {
  let weekend = 0;
  let dailyBreak = 0;
  let missing = 0;
  const feedGaps: LongGap[] = [];
  for (const gap of findCandleGaps(minutes, '1m')) {
    const kind = classOfGap(gap);
    if (kind === 'WEEKEND') weekend += 1;
    else if (kind === 'DAILY_BREAK') dailyBreak += 1;
    else {
      const count = Math.round(tradingMsBetween(gap.startMs, gap.endMs) / 60_000);
      missing += count;
      feedGaps.push({ startMs: gap.startMs, endMs: gap.endMs, minutes: count });
    }
  }
  const present = minutes.length;
  const total = present + missing;
  return {
    weekend,
    dailyBreak,
    feed: feedGaps.length,
    missingFeedMinutes: missing,
    coveragePct: total === 0 ? 0 : Math.round((10_000 * present) / total) / 100,
    longest: feedGaps
      .sort((a, b) => b.minutes - a.minutes || a.startMs - b.startMs)
      .slice(0, LONGEST),
  };
}
