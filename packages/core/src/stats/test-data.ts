import type { Result } from '../domain';
import { addResult, EMPTY_COUNTS, type BucketCounts, type StatsRecord } from './counts';

const MINUTE = 60_000;
export const T0 = Date.UTC(2026, 9, 1, 8, 0, 0);

/** A closed trade for the statistics. `at` is the number of minutes after `T0` that it closed. */
export function record(
  result: Result,
  net: number | null,
  at = 0,
  change: Partial<StatsRecord> = {},
): StatsRecord {
  const counts = result !== 'CANCELLED' && result !== 'DATA_INVALID';
  return {
    result,
    countsInStats: counts,
    realizedRNet: net,
    durationS: 600,
    tp1Hit: result === 'WIN' || result === 'PARTIAL_WIN',
    tp2Hit: result === 'WIN',
    closedAt: T0 + at * MINUTE,
    ...change,
  };
}

/** The buckets of a list of `[result, net R]` pairs, one minute apart. */
export function recordsOf(pairs: readonly (readonly [Result, number])[]): StatsRecord[] {
  return pairs.map(([result, net], index) => record(result, net, index));
}

/** A bucket with `wins` wins (+1.5 R) and `losses` losses (-1 R). */
export function bucket(wins: number, losses: number): BucketCounts {
  let counts = EMPTY_COUNTS;
  for (let i = 0; i < wins; i += 1) counts = addResult(counts, record('WIN', 1.5, i));
  for (let i = 0; i < losses; i += 1) counts = addResult(counts, record('LOSS', -1, wins + i));
  return counts;
}

/** The ten trades of the hand-checked sample: net R, result, duration in seconds. */
export const BLOCK: readonly (readonly [Result, number, number])[] = [
  ['WIN', 1.5, 600],
  ['LOSS', -1, 300],
  ['LOSS', -1, 300],
  ['PARTIAL_WIN', 0.5, 1800],
  ['WIN', 2, 2400],
  ['LOSS', -1, 900],
  ['WIN', 1.5, 3000],
  ['LOSS', -1.04, 420],
  ['PARTIAL_WIN', 0.46, 1500],
  ['TIME_EXIT', -0.18, 7200],
];

/** Forty trades: the block four times, one minute apart, plus two cancelled and one data-invalid signal. */
export function sample40(): StatsRecord[] {
  const list: StatsRecord[] = [];
  for (let block = 0; block < 4; block += 1) {
    BLOCK.forEach(([result, net, durationS], index) => {
      list.push(record(result, net, block * 10 + index, { durationS }));
    });
  }
  list.push(record('CANCELLED', null, 3, { durationS: 0 }));
  list.push(record('CANCELLED', null, 17, { durationS: 0 }));
  list.push(record('DATA_INVALID', null, 25, { durationS: 480 }));
  return list;
}
