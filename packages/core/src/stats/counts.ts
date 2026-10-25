import type { TradeOutcome } from '../trade/types';

/**
 * The counts of one bucket of the statistics, the same numbers as a row of `stats_bucket`. A result
 * that counts in the statistics (WIN, PARTIAL_WIN, LOSS, TIME_EXIT) is in `n` and in the count of its
 * own result; `winners` counts every trade with net R above zero, whatever its result (a partial win
 * whose costs take it to zero is not a winner, and a time exit above zero is), which is what the win
 * rate is made of. CANCELLED and DATA_INVALID are in no bucket.
 */
export interface BucketCounts {
  readonly n: number;
  /** Results `WIN`. */
  readonly wins: number;
  /** Trades with net R above zero. */
  readonly winners: number;
  readonly partials: number;
  readonly losses: number;
  readonly timeExits: number;
  readonly tp1Hits: number;
  readonly tp2Hits: number;
  /** The sum of net R, and its two parts: above zero (never negative) and below zero (never positive). */
  readonly sumR: number;
  readonly sumWinR: number;
  readonly sumLossR: number;
}

export const EMPTY_COUNTS: BucketCounts = {
  n: 0,
  wins: 0,
  winners: 0,
  partials: 0,
  losses: 0,
  timeExits: 0,
  tp1Hits: 0,
  tp2Hits: 0,
  sumR: 0,
  sumWinR: 0,
  sumLossR: 0,
};

/** What the statistics need from a closed trade: the fields of `TradeOutcome` (and of `signal_outcomes`). */
export type StatsRecord = Pick<
  TradeOutcome,
  'result' | 'countsInStats' | 'realizedRNet' | 'durationS' | 'tp1Hit' | 'tp2Hit' | 'closedAt'
>;

/** The counts after one more closed trade. A trade that does not count in the statistics changes nothing. */
export function addResult(counts: BucketCounts, record: StatsRecord): BucketCounts {
  if (!record.countsInStats) return counts;
  const net = record.realizedRNet;
  if (net === null || !Number.isFinite(net)) {
    throw new RangeError('a counted result needs its net R');
  }
  return {
    n: counts.n + 1,
    wins: counts.wins + (record.result === 'WIN' ? 1 : 0),
    winners: counts.winners + (net > 0 ? 1 : 0),
    partials: counts.partials + (record.result === 'PARTIAL_WIN' ? 1 : 0),
    losses: counts.losses + (record.result === 'LOSS' ? 1 : 0),
    timeExits: counts.timeExits + (record.result === 'TIME_EXIT' ? 1 : 0),
    tp1Hits: counts.tp1Hits + (record.tp1Hit ? 1 : 0),
    tp2Hits: counts.tp2Hits + (record.tp2Hit ? 1 : 0),
    sumR: counts.sumR + net,
    sumWinR: counts.sumWinR + (net > 0 ? net : 0),
    sumLossR: counts.sumLossR + (net < 0 ? net : 0),
  };
}

/** The counts of two buckets together (the order does not matter). */
export function mergeCounts(a: BucketCounts, b: BucketCounts): BucketCounts {
  return {
    n: a.n + b.n,
    wins: a.wins + b.wins,
    winners: a.winners + b.winners,
    partials: a.partials + b.partials,
    losses: a.losses + b.losses,
    timeExits: a.timeExits + b.timeExits,
    tp1Hits: a.tp1Hits + b.tp1Hits,
    tp2Hits: a.tp2Hits + b.tp2Hits,
    sumR: a.sumR + b.sumR,
    sumWinR: a.sumWinR + b.sumWinR,
    sumLossR: a.sumLossR + b.sumLossR,
  };
}

/** The counts of a list of closed trades, from nothing. */
export function countResults(records: Iterable<StatsRecord>): BucketCounts {
  let counts = EMPTY_COUNTS;
  for (const record of records) counts = addResult(counts, record);
  return counts;
}
