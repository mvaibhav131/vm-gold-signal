import { EVIDENCE_MIN_SAMPLE, sampleLabel, type SampleLabel } from '../evidence';
import { roundTo } from '../trade/round';
import { addResult, EMPTY_COUNTS, type BucketCounts, type StatsRecord } from './counts';
import { wilson } from './wilson';

/** The figures of a bucket as shown (rule C6: a percentage and an interval only from 30 trades). */
export interface RateStats {
  readonly n: number;
  /** Trades with net R above zero. */
  readonly winners: number;
  readonly sampleLabel: SampleLabel;
  /** 3 decimals; null below 30 trades. */
  readonly winRate: number | null;
  /** The 95% Wilson interval, 3 decimals; null below 30 trades. */
  readonly ci95: [number, number] | null;
  /** The mean net R, 2 decimals; null without a trade. Shown at any sample size: it is not a percentage. */
  readonly expectancyR: number | null;
  /** Gains over losses in net R, 2 decimals; null while there is no loss. */
  readonly profitFactor: number | null;
  readonly tp1Rate: number | null;
  readonly tp2Rate: number | null;
}

export function rateStats(counts: BucketCounts): RateStats {
  const { n } = counts;
  const shown = n >= EVIDENCE_MIN_SAMPLE;
  return {
    n,
    winners: counts.winners,
    sampleLabel: sampleLabel(n),
    winRate: shown ? roundTo(counts.winners / n, 3) : null,
    ci95: shown ? wilson(counts.winners, n) : null,
    expectancyR: n > 0 ? roundTo(counts.sumR / n, 2) : null,
    profitFactor: counts.sumLossR < 0 ? roundTo(counts.sumWinR / -counts.sumLossR, 2) : null,
    tp1Rate: shown ? roundTo(counts.tp1Hits / n, 3) : null,
    tp2Rate: shown ? roundTo(counts.tp2Hits / n, 3) : null,
  };
}

/**
 * The deepest fall of the running total of net R, from its highest point to a later low, as a
 * positive number (0 for no fall). The total starts at 0, so a first loss is already a fall.
 */
export function maxDrawdown(netRs: Iterable<number>): number {
  let equity = 0;
  let peak = 0;
  let deepest = 0;
  for (const net of netRs) {
    equity += net;
    peak = Math.max(peak, equity);
    deepest = Math.max(deepest, peak - equity);
  }
  return deepest;
}

/** The counted trades in the order they closed (ties keep the order they came in). */
function inClosingOrder(records: readonly StatsRecord[]): StatsRecord[] {
  return records.filter((record) => record.countsInStats).sort((a, b) => a.closedAt - b.closedAt);
}

function netOf(record: StatsRecord): number {
  if (record.realizedRNet === null) throw new RangeError('a counted result needs its net R');
  return record.realizedRNet;
}

/** One point for each counted trade: when it closed and the total net R so far (2 decimals). */
export function equityCurve(
  records: readonly StatsRecord[],
): { readonly t: number; readonly netR: number }[] {
  let total = 0;
  return inClosingOrder(records).map((record) => {
    total += netOf(record);
    return { t: record.closedAt, netR: roundTo(total, 2) };
  });
}

/** The run of the same kind (net R above zero, or not) that the newest counted trade ends. */
export function currentStreak(
  records: readonly StatsRecord[],
): { readonly type: 'WIN' | 'LOSS'; readonly length: number } | null {
  const ordered = inClosingOrder(records);
  const last = ordered.at(-1);
  if (last === undefined) return null;
  const won = netOf(last) > 0;
  let length = 0;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const record = ordered[i];
    if (record === undefined || netOf(record) > 0 !== won) break;
    length += 1;
  }
  return { type: won ? 'WIN' : 'LOSS', length };
}

/** The numbers of `GET /analytics/overview` for a list of closed trades (04_API_and_Notifications section 2). */
export interface Overview extends RateStats {
  readonly resolvedValid: number;
  readonly wins: number;
  readonly partials: number;
  readonly losses: number;
  readonly timeExits: number;
  readonly cancelled: number;
  readonly dataInvalid: number;
  /** 2 decimals. */
  readonly netR: number;
  /** A positive number, 2 decimals. */
  readonly maxDrawdownR: number;
  /** Whole seconds; null without a counted trade. */
  readonly avgDurationS: number | null;
  readonly currentStreak: { readonly type: 'WIN' | 'LOSS'; readonly length: number } | null;
}

/**
 * Everything the overview shows, from the closed trades of a range and a scope. Cancelled and
 * data-invalid signals are counted apart and are in no rate (02_Signal_Engine section 11).
 */
export function summarizeResults(records: readonly StatsRecord[]): Overview {
  const ordered = inClosingOrder(records);
  let counts = EMPTY_COUNTS;
  let seconds = 0;
  for (const record of ordered) {
    counts = addResult(counts, record);
    seconds += record.durationS;
  }
  return {
    ...rateStats(counts),
    resolvedValid: counts.n,
    wins: counts.wins,
    partials: counts.partials,
    losses: counts.losses,
    timeExits: counts.timeExits,
    cancelled: records.filter((record) => record.result === 'CANCELLED').length,
    dataInvalid: records.filter((record) => record.result === 'DATA_INVALID').length,
    netR: roundTo(counts.sumR, 2),
    maxDrawdownR: roundTo(maxDrawdown(ordered.map(netOf)), 2),
    avgDurationS: counts.n > 0 ? Math.round(seconds / counts.n) : null,
    currentStreak: currentStreak(ordered),
  };
}
