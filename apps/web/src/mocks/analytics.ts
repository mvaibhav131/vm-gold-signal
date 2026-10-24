import {
  breakdownResponseSchema,
  calibrationResponseSchema,
  driftResponseSchema,
  equityResponseSchema,
  failuresResponseSchema,
  groupEffectivenessResponseSchema,
  monthlyResponseSchema,
  newsImpactResponseSchema,
  type BreakdownDimension,
  type BreakdownResponse,
  type BreakdownRow,
  type CalibrationResponse,
  type DriftResponse,
  type EquityResponse,
  type FailuresResponse,
  type GroupEffectivenessResponse,
  type GroupEffectivenessRow,
  type MonthlyResponse,
  type NewsImpactResponse,
  type SignalHistoryRow,
} from '@vmgs/contracts';
import {
  EVIDENCE_MIN_SAMPLE,
  EVIDENCE_NORMAL_SAMPLE,
  NEWS_TOPICS,
  QUALITY_GROUPS,
  STRATEGY_KEYS,
  causeCategory,
  qualityGrade,
  zonedParts,
  type GroupState,
  type NewsImpact,
  type NewsTopic,
  type QualityGroup,
  type StrategyKey,
} from '@vmgs/core';

import { allRows, round2, summarize, wilson } from './history';
import type { SimSignal } from './signals';
import { rowOfTrade, type Trade } from './trades';
import { round3 } from './world';

// The numbers of the Analytics screen, computed from the history rows by pure functions. The
// real API (phases B22 and B26) computes the same things from `signal_outcomes` and the rollup
// tables; these functions are the mock of it and show what each endpoint has to answer.

/** The time zone of the months of the monthly table: the display time zone of the default settings. */
export const ANALYTICS_TZ = 'Asia/Kolkata';

/** A history row with what the review of the groups needs: the state of each evidence group at entry. */
export interface AnalyticsRecord {
  readonly row: SignalHistoryRow;
  /** Null for a signal that is still open. */
  readonly groups: Readonly<Record<QualityGroup, GroupState>> | null;
  readonly weak: readonly { group: QualityGroup; state: 'WEAK' | 'FAIL' }[];
}

/** The forward results: the open signals (no groups yet) and the finished ones of the simulated history. */
export function forwardRecordsOf(
  open: readonly SimSignal[],
  trades: readonly Trade[],
  nowMs: number,
): AnalyticsRecord[] {
  const openRecords = allRows(open, [], nowMs).map((row) => ({ row, groups: null, weak: [] }));
  const finished = trades.map((trade): AnalyticsRecord => {
    const groups = Object.fromEntries(
      trade.signal.groupedScores.map((g) => [g.key, g.state]),
    ) as Record<QualityGroup, GroupState>;
    return { row: rowOfTrade(trade, nowMs), groups, weak: trade.weakGroups };
  });
  return [...openRecords, ...finished];
}

interface Range {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/** `from` is included and `to` is not, as in the history list. */
export function inRange(records: readonly AnalyticsRecord[], range: Range): AnalyticsRecord[] {
  return records.filter(({ row }) => {
    const at = Date.parse(row.generatedAt);
    if (range.from !== undefined && at < Date.parse(range.from)) return false;
    if (range.to !== undefined && at >= Date.parse(range.to)) return false;
    return true;
  });
}

const counted = (records: readonly AnalyticsRecord[]) =>
  records.filter(({ row }) => row.countsInStats === true);

const netOf = (row: SignalHistoryRow) => row.realizedRNet ?? 0;

/** What every row of a breakdown, of the group view and of the calibration says about a set of valid results. */
function resultStats(rows: readonly SignalHistoryRow[]) {
  const n = rows.length;
  const wins = rows.filter((row) => row.isWin === true).length;
  const gain = rows.filter((row) => netOf(row) > 0).reduce((sum, row) => sum + netOf(row), 0);
  const loss = rows.filter((row) => netOf(row) < 0).reduce((sum, row) => sum - netOf(row), 0);
  const shown = n >= EVIDENCE_MIN_SAMPLE;
  return {
    n,
    wins,
    winRate: shown ? round3(wins / n) : null,
    ci95: shown ? wilson(wins, n) : null,
    expectancyR: n > 0 ? round2(rows.reduce((sum, row) => sum + netOf(row), 0) / n) : null,
    profitFactor: loss > 0 ? round2(gain / loss) : null,
    lowSample: n < EVIDENCE_NORMAL_SAMPLE,
  };
}

// ---------------------------------------------------------------------------------------------
// Monthly table

const monthIndex = (ms: number) => {
  const { year, month } = zonedParts(ms, ANALYTICS_TZ);
  return year * 12 + (month - 1);
};

const monthLabel = (index: number) =>
  `${String(Math.floor(index / 12))}-${String((index % 12) + 1).padStart(2, '0')}`;

/**
 * One row for each of the last `months` months, oldest first, ending at the newest month that has a
 * signal; months before the first signal are left out. A signal belongs to the month it was generated in.
 */
export function monthlyOf(records: readonly AnalyticsRecord[], months: number): MonthlyResponse {
  if (records.length === 0) return monthlyResponseSchema.parse({ items: [] });
  const indexes = records.map(({ row }) => monthIndex(Date.parse(row.generatedAt)));
  const newest = Math.max(...indexes);
  const oldest = Math.max(Math.min(...indexes), newest - months + 1);
  const items = [];
  for (let index = oldest; index <= newest; index += 1) {
    const rows = records
      .filter(({ row }) => monthIndex(Date.parse(row.generatedAt)) === index)
      .map(({ row }) => row);
    const s = summarize(rows);
    items.push({
      month: monthLabel(index),
      generated: s.generated,
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
  return monthlyResponseSchema.parse({ items });
}

// ---------------------------------------------------------------------------------------------
// Breakdown

const DIMENSION_KEY: Readonly<Record<BreakdownDimension, (row: SignalHistoryRow) => string>> = {
  strategy: (row) => row.strategyKey,
  side: (row) => row.side,
  session: (row) => row.session,
  regime: (row) => row.regime,
  volatility: (row) => row.volBucket,
  news: (row) => row.newsState,
  grade: (row) => qualityGrade(row.qualityScore) ?? 'Below the lowest grade',
};

/** Rows by one dimension, the biggest sample first. A key without a valid result is left out. */
export function breakdownOf(
  records: readonly AnalyticsRecord[],
  by: BreakdownDimension,
  range: Range = {},
): BreakdownResponse {
  const valid = counted(inRange(records, range)).map(({ row }) => row);
  const keyOf = DIMENSION_KEY[by];
  const keys = [...new Set(valid.map(keyOf))];
  const items: BreakdownRow[] = keys
    .map((key) => ({ key, ...resultStats(valid.filter((row) => keyOf(row) === key)) }))
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  return breakdownResponseSchema.parse({ by, items });
}

// ---------------------------------------------------------------------------------------------
// Failure analysis

/** The primary cause of every reviewed result, ranked by count and then by R lost; and how often each group was weak at entry. */
export function failuresOf(
  records: readonly AnalyticsRecord[],
  range: Range = {},
): FailuresResponse {
  const reviewed = counted(inRange(records, range)).filter(({ row }) => row.primaryCause !== null);
  const total = reviewed.length;
  const byCause = new Map<string, AnalyticsRecord[]>();
  for (const record of reviewed) {
    const code = record.row.primaryCause ?? '';
    byCause.set(code, [...(byCause.get(code) ?? []), record]);
  }
  const causes = [...byCause.entries()]
    .map(([, list]) => {
      const sumR = round2(list.reduce((sum, { row }) => sum + netOf(row), 0));
      const first = list[0]?.row.primaryCause;
      if (!first) throw new Error('a cause without a code');
      return {
        code: first,
        category: causeCategory(first),
        n: list.length,
        share: round3(list.length / total),
        sumR,
      };
    })
    .sort((a, b) => b.n - a.n || a.sumR - b.sumR || a.code.localeCompare(b.code));
  const weakGroups = QUALITY_GROUPS.map((group) => {
    const n = reviewed.filter(({ weak }) => weak.some((w) => w.group === group)).length;
    return { group, n, share: total === 0 ? 0 : round3(n / total) };
  })
    .filter((entry) => entry.n > 0)
    .sort((a, b) => b.n - a.n || QUALITY_GROUPS.indexOf(a.group) - QUALITY_GROUPS.indexOf(b.group));
  return failuresResponseSchema.parse({ causes, weakGroups });
}

// ---------------------------------------------------------------------------------------------
// Evidence-group effectiveness

const STATE_ORDER: readonly GroupState[] = ['STRONG', 'OK', 'WEAK', 'FAIL', 'NA'];

/** Win rate by strategy, evidence group and the state the group was in at entry. */
export function groupEffectivenessOf(
  records: readonly AnalyticsRecord[],
  strategy?: StrategyKey,
): GroupEffectivenessResponse {
  const valid = counted(records).filter(
    (record) =>
      record.groups !== null && (strategy === undefined || record.row.strategyKey === strategy),
  );
  const items: GroupEffectivenessRow[] = [];
  for (const key of STRATEGY_KEYS) {
    for (const group of QUALITY_GROUPS) {
      for (const state of STATE_ORDER) {
        const rows = valid
          .filter((record) => record.row.strategyKey === key && record.groups?.[group] === state)
          .map(({ row }) => row);
        if (rows.length === 0) continue;
        const s = resultStats(rows);
        items.push({
          strategy: key,
          group,
          state,
          n: s.n,
          wins: s.wins,
          winRate: s.winRate,
          ci95: s.ci95,
          expectancyR: s.expectancyR,
        });
      }
    }
  }
  return groupEffectivenessResponseSchema.parse({ items });
}

// ---------------------------------------------------------------------------------------------
// Score calibration

/** The score bands of the calibration view: the three grades split in bands of 5 (a signal needs a score of at least 65). */
export const CALIBRATION_BANDS = [
  [65, 69],
  [70, 74],
  [75, 79],
  [80, 84],
  [85, 89],
  [90, 100],
] as const;

/** Realised win rate by quality-score band. A band without a result is still listed, so the axis is always the same. */
export function calibrationOf(records: readonly AnalyticsRecord[]): CalibrationResponse {
  const valid = counted(records).map(({ row }) => row);
  const items = CALIBRATION_BANDS.map(([bandFrom, bandTo], index) => {
    const next = CALIBRATION_BANDS[index + 1]?.[0];
    const rows = valid.filter(
      (row) => row.qualityScore >= bandFrom && (next === undefined || row.qualityScore < next),
    );
    const s = resultStats(rows);
    return { bandFrom, bandTo, n: s.n, wins: s.wins, winRate: s.winRate, ci95: s.ci95 };
  });
  return calibrationResponseSchema.parse({ items });
}

// ---------------------------------------------------------------------------------------------
// Equity curve

/** Cumulative net R after each valid result, in the order the results closed. */
export function equityOf(records: readonly AnalyticsRecord[], range: Range = {}): EquityResponse {
  const valid = counted(inRange(records, range))
    .map(({ row }) => row)
    .sort((a, b) => Date.parse(a.closedAt ?? '') - Date.parse(b.closedAt ?? '') || a.seq - b.seq);
  let sum = 0;
  const items = valid.map((row) => {
    sum += netOf(row);
    return { t: row.closedAt ?? row.generatedAt, netR: round2(sum) };
  });
  return equityResponseSchema.parse({ items });
}

// ---------------------------------------------------------------------------------------------
// Drift

export const DRIFT_WINDOW = 50;

/**
 * The rolling win rate of the last 50 forward results of a strategy against the evidence interval
 * of the same strategy. Below 30 results there is no percentage and the status says so. A strategy
 * with 30 results or more but no evidence interval to compare with is left out: drift cannot be judged.
 */
export function driftOf(
  forward: readonly AnalyticsRecord[],
  evidence: Readonly<Partial<Record<StrategyKey, readonly [number, number] | null>>>,
): DriftResponse {
  const items = [];
  for (const key of STRATEGY_KEYS) {
    const rows = counted(forward)
      .map(({ row }) => row)
      .filter((row) => row.strategyKey === key)
      .sort((a, b) => Date.parse(a.closedAt ?? '') - Date.parse(b.closedAt ?? ''))
      .slice(-DRIFT_WINDOW);
    if (rows.length === 0) continue;
    const n = rows.length;
    const interval = evidence[key] ?? null;
    if (n >= EVIDENCE_MIN_SAMPLE && interval === null) continue;
    const rate =
      n >= EVIDENCE_MIN_SAMPLE ? round3(rows.filter((r) => r.isWin === true).length / n) : null;
    let status: 'INSUFFICIENT_DATA' | 'WITHIN_RANGE' | 'BELOW_RANGE' | 'ABOVE_RANGE' =
      'INSUFFICIENT_DATA';
    if (rate !== null && interval !== null) {
      status =
        rate < interval[0] ? 'BELOW_RANGE' : rate > interval[1] ? 'ABOVE_RANGE' : 'WITHIN_RANGE';
    }
    items.push({
      strategy: key,
      window: DRIFT_WINDOW,
      n,
      rollingWinRate: rate,
      evidenceCi95: interval,
      status,
    });
  }
  return driftResponseSchema.parse({ items });
}

// ---------------------------------------------------------------------------------------------
// News impact

/** Share of ordinary 10-minute windows in which gold moved 1 ATR or more: what a headline is compared with. */
export const NEWS_BASELINE_SHARE = 0.19;

// [topic, impact, headlines, headlines followed by a move of 1 ATR or more within 10 minutes, average absolute move in ATR]
const NEWS_TABLE: readonly (readonly [NewsTopic, NewsImpact, number, number, number])[] = [
  ['FED_RATES', 'HIGH', 142, 61, 1.34],
  ['FED_RATES', 'MEDIUM', 188, 49, 0.82],
  ['USD_DOLLAR', 'HIGH', 77, 27, 1.12],
  ['USD_DOLLAR', 'MEDIUM', 160, 38, 0.74],
  ['INFLATION_JOBS', 'HIGH', 96, 51, 1.58],
  ['INFLATION_JOBS', 'MEDIUM', 61, 17, 0.9],
  ['GEOPOLITICS_WAR', 'HIGH', 54, 21, 1.21],
  ['GEOPOLITICS_WAR', 'MEDIUM', 133, 26, 0.68],
  ['GEOPOLITICS_WAR', 'LOW', 205, 29, 0.41],
  ['TRUMP_POLICY', 'HIGH', 41, 12, 0.97],
  ['TRUMP_POLICY', 'MEDIUM', 118, 24, 0.71],
  ['CENTRAL_BANK_GOLD', 'HIGH', 19, 9, 1.46],
  ['CENTRAL_BANK_GOLD', 'MEDIUM', 44, 10, 0.77],
  ['GOLD_DIRECT', 'HIGH', 36, 17, 1.25],
  ['GOLD_DIRECT', 'MEDIUM', 92, 21, 0.8],
  ['RISK_OFF', 'HIGH', 28, 11, 1.05],
  ['RISK_OFF', 'MEDIUM', 71, 15, 0.66],
];

/** Per topic and impact: how often a headline was followed by a move of 1 ATR or more, against ordinary windows. */
export function newsImpactOf(): NewsImpactResponse {
  const items = [...NEWS_TABLE]
    .sort(
      (a, b) =>
        NEWS_TOPICS.indexOf(a[0]) - NEWS_TOPICS.indexOf(b[0]) ||
        ['HIGH', 'MEDIUM', 'LOW'].indexOf(a[1]) - ['HIGH', 'MEDIUM', 'LOW'].indexOf(b[1]),
    )
    .map(([topic, impact, n, moved, avgAbsMoveAtr]) => {
      const shown = n >= EVIDENCE_MIN_SAMPLE;
      const share = shown ? round3(moved / n) : null;
      return {
        topic,
        impact,
        n,
        moved,
        movedShare: share,
        movedCi95: shown ? wilson(moved, n) : null,
        avgAbsMoveAtr,
        baselineShare: NEWS_BASELINE_SHARE,
        lift: share === null ? null : round2(share / NEWS_BASELINE_SHARE),
        lowSample: n < EVIDENCE_NORMAL_SAMPLE,
      };
    });
  return newsImpactResponseSchema.parse({ items });
}
