import {
  ianaTimeZoneSchema,
  type BreakdownDimension,
  type BreakdownResponse,
  type CalibrationResponse,
  type DriftResponse,
  type DriftRow,
  type EquityResponse,
  type FailuresResponse,
  type GroupEffectivenessResponse,
  type GroupEffectivenessRow,
  type MonthlyResponse,
  type MonthlyRow,
  type NewsImpactResponse,
  type NewsImpactRow,
  type OverviewResponse,
} from '@vmgs/contracts';
import { defaultSettings } from '@vmgs/config';
import {
  EVIDENCE_MIN_SAMPLE,
  GROUP_STATES,
  NEWS_IMPACTS,
  NEWS_TOPICS,
  QUALITY_GROUPS,
  STRATEGY_KEYS,
  causeCategory,
  countResults,
  equityCurve,
  qualityGrade,
  rateStats,
  roundTo,
  sampleLabel,
  summarizeResults,
  wilson,
  zonedParts,
  type CauseCode,
  type NewsImpact,
  type StatsRecord,
} from '@vmgs/core';

import type { TopicStatRow, TradeRow } from './reader';

/** A signal that has an outcome (open signals have none). */
type ClosedTrade = TradeRow & { readonly outcome: StatsRecord };

/**
 * The signals that have closed, in the order they closed; two that closed in the same millisecond go by their number.
 * Every figure that depends on the order (the equity curve, the drawdown, the streak, the sums) is read in this order,
 * so the same data always gives the same answer.
 */
function closedInOrder(rows: readonly TradeRow[]): ClosedTrade[] {
  return rows
    .filter((row): row is ClosedTrade => row.outcome !== null)
    .sort((a, b) => a.outcome.closedAt - b.outcome.closedAt || a.seq - b.seq);
}

/** The results that count in the statistics, in the order they closed. */
function counted(rows: readonly TradeRow[]): ClosedTrade[] {
  return closedInOrder(rows).filter((row) => row.outcome.countsInStats);
}

function netOf(record: StatsRecord): number {
  if (record.realizedRNet === null) throw new RangeError('a counted result needs its net R');
  return record.realizedRNet;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The numbers of `GET /analytics/overview`: the figures of core over the closed signals, and the count of all. */
export function overviewOf(rows: readonly TradeRow[]): OverviewResponse {
  const s = summarizeResults(closedInOrder(rows).map((row) => row.outcome));
  return {
    // every signal of the range, an open one too
    generated: rows.length,
    resolvedValid: s.resolvedValid,
    wins: s.wins,
    partials: s.partials,
    losses: s.losses,
    timeExits: s.timeExits,
    cancelled: s.cancelled,
    dataInvalid: s.dataInvalid,
    winRate: s.winRate,
    ci95: s.ci95,
    netR: s.netR,
    expectancyR: s.expectancyR,
    profitFactor: s.profitFactor,
    maxDrawdownR: s.maxDrawdownR,
    avgDurationS: s.avgDurationS,
    tp1Rate: s.tp1Rate,
    tp2Rate: s.tp2Rate,
    currentStreak: s.currentStreak,
  };
}

/** The display time zone of the settings: the documented default when none was saved, an error when it is no zone. */
export function resolveTimeZone(stored: unknown): string {
  if (stored === null || stored === undefined) return defaultSettings().displayTz;
  const zone = ianaTimeZoneSchema.safeParse(stored);
  if (!zone.success) throw new Error('the stored display time zone is not a time zone');
  return zone.data;
}

const monthIndexOf = (ms: number, timeZone: string): number => {
  const { year, month } = zonedParts(ms, timeZone);
  return year * 12 + (month - 1);
};

const monthLabel = (index: number): string =>
  `${String(Math.floor(index / 12))}-${String((index % 12) + 1).padStart(2, '0')}`;

/**
 * One row for each of the last `months` calendar months of the zone, oldest first, ending at the newest month that has a
 * signal; the months before the first signal are left out and a month in between without one is a row of zeros. A
 * signal is in the month of its decision.
 */
export function monthlyOf(
  rows: readonly TradeRow[],
  months: number,
  timeZone: string,
): MonthlyResponse {
  const byMonth = new Map<number, TradeRow[]>();
  for (const row of rows) {
    const index = monthIndexOf(row.generatedAt, timeZone);
    const list = byMonth.get(index);
    if (list === undefined) byMonth.set(index, [row]);
    else list.push(row);
  }
  if (byMonth.size === 0) return { items: [] };
  const indexes = [...byMonth.keys()];
  const newest = Math.max(...indexes);
  const oldest = Math.max(Math.min(...indexes), newest - months + 1);
  const items: MonthlyRow[] = [];
  for (let index = oldest; index <= newest; index += 1) {
    const monthRows = byMonth.get(index) ?? [];
    const s = summarizeResults(closedInOrder(monthRows).map((row) => row.outcome));
    items.push({
      month: monthLabel(index),
      generated: monthRows.length,
      resolvedValid: s.resolvedValid,
      wins: s.wins,
      partials: s.partials,
      losses: s.losses,
      timeExits: s.timeExits,
      cancelled: s.cancelled,
      dataInvalid: s.dataInvalid,
      winRate: s.winRate,
      netR: s.netR,
      profitFactor: s.profitFactor,
    });
  }
  return { items };
}

const DIMENSION_KEY: Readonly<Record<BreakdownDimension, (row: TradeRow) => string>> = {
  strategy: (row) => row.strategyKey,
  side: (row) => row.side,
  session: (row) => row.session,
  regime: (row) => row.regime,
  volatility: (row) => row.volBucket,
  news: (row) => row.newsState,
  grade: (row) => qualityGrade(row.qualityScore) ?? 'Below the lowest grade',
};

/** Rows by one dimension, the biggest sample first. A key without a valid result is left out. */
export function breakdownOf(rows: readonly TradeRow[], by: BreakdownDimension): BreakdownResponse {
  const keyOf = DIMENSION_KEY[by];
  const groups = new Map<string, StatsRecord[]>();
  for (const row of counted(rows)) {
    const key = keyOf(row);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [row.outcome]);
    else list.push(row.outcome);
  }
  const items = [...groups].map(([key, records]) => {
    const stats = rateStats(countResults(records));
    return {
      key,
      n: stats.n,
      wins: stats.winners,
      winRate: stats.winRate,
      ci95: stats.ci95,
      expectancyR: stats.expectancyR,
      profitFactor: stats.profitFactor,
      lowSample: stats.sampleLabel !== 'NORMAL',
    };
  });
  items.sort((a, b) => b.n - a.n || compare(a.key, b.key));
  return { by, items };
}

/**
 * The primary cause of every reviewed result, ranked by count and then by R lost, and how often each group was weak
 * at entry. A share is of the reviewed results (the results that have a review), whatever their number.
 */
export function failuresOf(rows: readonly TradeRow[]): FailuresResponse {
  const reviewed = counted(rows).filter((row) => row.primaryCause !== null);
  const total = reviewed.length;
  const byCause = new Map<CauseCode, { n: number; sumR: number }>();
  for (const row of reviewed) {
    if (row.primaryCause === null) continue;
    const cause = byCause.get(row.primaryCause) ?? { n: 0, sumR: 0 };
    cause.n += 1;
    cause.sumR += netOf(row.outcome);
    byCause.set(row.primaryCause, cause);
  }
  const causes = [...byCause]
    .map(([code, cause]) => ({
      code,
      category: causeCategory(code),
      n: cause.n,
      share: roundTo(cause.n / total, 3),
      sumR: roundTo(cause.sumR, 2),
    }))
    .sort((a, b) => b.n - a.n || a.sumR - b.sumR || compare(a.code, b.code));
  const weakGroups = QUALITY_GROUPS.map((group) => {
    const n = reviewed.filter((row) => row.weakGroups.includes(group)).length;
    return { group, n, share: total === 0 ? 0 : roundTo(n / total, 3) };
  })
    .filter((entry) => entry.n > 0)
    .sort((a, b) => b.n - a.n || QUALITY_GROUPS.indexOf(a.group) - QUALITY_GROUPS.indexOf(b.group));
  return { causes, weakGroups };
}

/**
 * Win rate by strategy, evidence group and the state the group was in at entry: one row for each that occurred, in the
 * order of the strategies, the groups and the states.
 */
export function groupsOf(rows: readonly TradeRow[]): GroupEffectivenessResponse {
  const cells = new Map<string, StatsRecord[]>();
  for (const row of counted(rows)) {
    for (const { key, state } of row.groups) {
      const id = `${row.strategyKey}|${key}|${state}`;
      const list = cells.get(id);
      if (list === undefined) cells.set(id, [row.outcome]);
      else list.push(row.outcome);
    }
  }
  const items: GroupEffectivenessRow[] = [];
  for (const strategy of STRATEGY_KEYS) {
    for (const group of QUALITY_GROUPS) {
      for (const state of GROUP_STATES) {
        const records = cells.get(`${strategy}|${group}|${state}`);
        if (records === undefined) continue;
        const stats = rateStats(countResults(records));
        items.push({
          strategy,
          group,
          state,
          n: stats.n,
          wins: stats.winners,
          winRate: stats.winRate,
          ci95: stats.ci95,
          expectancyR: stats.expectancyR,
        });
      }
    }
  }
  return { items };
}

/** The score bands of the calibration view: the three grades split in bands of 5 (a signal needs a score of 65). */
export const CALIBRATION_BANDS = [
  [65, 69],
  [70, 74],
  [75, 79],
  [80, 84],
  [85, 89],
  [90, 100],
] as const;

/** Realised win rate by quality-score band. A band without a result is still listed, so the axis never changes. */
export function calibrationOf(rows: readonly TradeRow[]): CalibrationResponse {
  const valid = counted(rows);
  const items = CALIBRATION_BANDS.map(([bandFrom, bandTo], index) => {
    const next = CALIBRATION_BANDS[index + 1]?.[0];
    // the scores have 2 decimals: the band 65-69 holds 69.99 and the band 70-74 starts at 70
    const records = valid
      .filter(
        (row) => row.qualityScore >= bandFrom && (next === undefined || row.qualityScore < next),
      )
      .map((row) => row.outcome);
    const stats = rateStats(countResults(records));
    return {
      bandFrom,
      bandTo,
      n: stats.n,
      wins: stats.winners,
      winRate: stats.winRate,
      ci95: stats.ci95,
    };
  });
  return { items };
}

/** Cumulative net R after each valid result, in the order the results closed. */
export function equityOf(rows: readonly TradeRow[]): EquityResponse {
  const points = equityCurve(counted(rows).map((row) => row.outcome));
  return {
    items: points.map((point) => ({ t: new Date(point.t).toISOString(), netR: point.netR })),
  };
}

/** The window of the rolling win rate: the last 50 forward results of a strategy. */
export const DRIFT_WINDOW = 50;

/** The rate and the interval as they are shown: a rate on the edge of the interval is within it. */
export function driftStatus(
  rate: number | null,
  interval: readonly [number, number] | null,
): DriftRow['status'] {
  if (rate === null || interval === null) return 'INSUFFICIENT_DATA';
  if (rate < interval[0]) return 'BELOW_RANGE';
  return rate > interval[1] ? 'ABOVE_RANGE' : 'WITHIN_RANGE';
}

/**
 * The rolling win rate of the last 50 forward results of each strategy against the evidence interval of the same
 * strategy, which is the interval of its out-of-sample backtest. A strategy with no forward result is left out, and so
 * is one with 30 results or more and no interval to compare with: drift cannot be judged.
 */
export function driftOf(
  forward: readonly TradeRow[],
  backtest: readonly TradeRow[],
): DriftResponse {
  const forwardResults = counted(forward);
  const backtestResults = counted(backtest);
  const items: DriftRow[] = [];
  for (const strategy of STRATEGY_KEYS) {
    const recent = forwardResults
      .filter((row) => row.strategyKey === strategy)
      .slice(-DRIFT_WINDOW)
      .map((row) => row.outcome);
    if (recent.length === 0) continue;
    const stats = rateStats(countResults(recent));
    const interval = rateStats(
      countResults(
        backtestResults.filter((row) => row.strategyKey === strategy).map((row) => row.outcome),
      ),
    ).ci95;
    if (stats.winRate !== null && interval === null) continue;
    items.push({
      strategy,
      window: DRIFT_WINDOW,
      n: stats.n,
      rollingWinRate: stats.winRate,
      evidenceCi95: interval,
      status: driftStatus(stats.winRate, interval),
    });
  }
  return { items };
}

const IMPACT_RANK: Readonly<Record<NewsImpact, number>> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * Per topic and impact level, how often a headline was followed by a move of 1 ATR or more within 10 minutes, against
 * the ordinary windows. Topics in their order, the highest impact first. Rule C6: the share, its interval, the
 * baseline and the lift are shown from 30 headlines.
 */
export function newsImpactOf(stats: readonly TopicStatRow[]): NewsImpactResponse {
  const known = stats.flatMap((stat) => {
    const topic = NEWS_TOPICS.find((each) => each === stat.topic);
    const impact = NEWS_IMPACTS.find((each) => each === stat.impact);
    return topic === undefined || impact === undefined || stat.n <= 0
      ? []
      : [{ topic, impact, stat }];
  });
  known.sort(
    (a, b) =>
      NEWS_TOPICS.indexOf(a.topic) - NEWS_TOPICS.indexOf(b.topic) ||
      IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact],
  );
  const items = known.map(({ topic, impact, stat }): NewsImpactRow => {
    const shown = stat.n >= EVIDENCE_MIN_SAMPLE;
    const baseline = shown ? stat.baseline : null;
    return {
      topic,
      impact,
      n: stat.n,
      moved: stat.moved,
      movedShare: shown ? roundTo(stat.moved / stat.n, 3) : null,
      movedCi95: shown ? wilson(stat.moved, stat.n) : null,
      avgAbsMoveAtr: roundTo(stat.sumAbsAtr10m / stat.n, 2),
      baselineShare: baseline === null ? null : roundTo(baseline, 3),
      // a ratio over a baseline of zero says nothing
      lift:
        baseline === null || !(baseline > 0) ? null : roundTo(stat.moved / stat.n / baseline, 2),
      lowSample: sampleLabel(stat.n) !== 'NORMAL',
    };
  });
  return { items };
}
