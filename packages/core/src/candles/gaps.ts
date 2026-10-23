import type { Timeframe } from '../domain';
import { nextWeekendMidpoint } from '../time/tradingDay';
import { bucketEnd } from './buckets';

/** WEEKEND: the gap spans the Friday 17:00 to Sunday 17:00 New York closure. FEED: anything else. */
export const GAP_KINDS = ['FEED', 'WEEKEND'] as const;
export type GapKind = (typeof GAP_KINDS)[number];

/** A stretch of time without data. Never filled with invented candles. */
export interface FeedGap {
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  readonly kind: GapKind;
}

export function makeGap(startMs: number, endMs: number): FeedGap {
  const spansWeekend = nextWeekendMidpoint(startMs) < endMs;
  return { startMs, endMs, durationMs: endMs - startMs, kind: spansWeekend ? 'WEEKEND' : 'FEED' };
}

/**
 * Holes in a candle series (sorted by open time): from the end of one candle to the open of the
 * next candle when candles are missing in between. Used to rebuild gap knowledge after a restart
 * and to check bootstrapped history.
 */
export function findCandleGaps(
  candles: readonly { readonly openTime: number }[],
  tf: Timeframe,
): FeedGap[] {
  const gaps: FeedGap[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const previous = candles[i - 1];
    const current = candles[i];
    if (previous === undefined || current === undefined) continue;
    const expectedNext = bucketEnd(tf, previous.openTime);
    if (current.openTime > expectedNext) gaps.push(makeGap(expectedNext, current.openTime));
  }
  return gaps;
}
