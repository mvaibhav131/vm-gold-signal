import {
  EVIDENCE_MIN_SAMPLE,
  countResults,
  maxDrawdown,
  wilson,
  type FillSkip,
  type TradeOutcome,
} from '@vmgs/core';

import type { BacktestSignal, ScenarioKey } from './types';

const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/** What a list of results says: all rates are of the counted trades (WIN, PARTIAL_WIN, LOSS, TIME_EXIT). */
export interface Stats {
  readonly n: number;
  /** Trades with net R above zero. */
  readonly winners: number;
  /** The mean net R, 3 decimals; null without a trade. */
  readonly expectancyR: number | null;
  readonly netR: number;
  /** Gains over losses; null while there is no loss. */
  readonly profitFactor: number | null;
  /** From 30 trades only (rule C6). */
  readonly winRate: number | null;
  readonly ci95: readonly [number, number] | null;
  readonly maxDrawdownR: number;
  readonly tp1Rate: number | null;
  readonly timeExits: number;
  /** A stop and a target in one bar: the stop was taken. */
  readonly ambiguous: number;
  /** Closed as `DATA_INVALID` (a hole in the bars): in no rate. */
  readonly dataInvalid: number;
}

export function statsOf(outcomes: readonly TradeOutcome[]): Stats {
  const counted = outcomes.filter((outcome) => outcome.countsInStats);
  const counts = countResults(counted);
  const { n } = counts;
  const nets = [...counted].sort((a, b) => a.closedAt - b.closedAt).map((o) => o.realizedRNet ?? 0);
  const shown = n >= EVIDENCE_MIN_SAMPLE;
  return {
    n,
    winners: counts.winners,
    expectancyR: n > 0 ? round(counts.sumR / n, 3) : null,
    netR: round(counts.sumR, 2),
    profitFactor: counts.sumLossR < 0 ? round(counts.sumWinR / -counts.sumLossR, 2) : null,
    winRate: shown ? round(counts.winners / n, 3) : null,
    ci95: shown ? wilson(counts.winners, n) : null,
    maxDrawdownR: round(maxDrawdown(nets), 2),
    tp1Rate: shown ? round(counts.tp1Hits / n, 3) : null,
    timeExits: counts.timeExits,
    ambiguous: counted.filter((outcome) => outcome.ambiguous).length,
    dataInvalid: outcomes.filter((outcome) => outcome.result === 'DATA_INVALID').length,
  };
}

/** How the signals of a scenario ended: the statistics of the closed trades, and what never became a trade. */
export interface ScenarioTally {
  readonly signals: number;
  readonly stats: Stats;
  readonly skipped: Readonly<Partial<Record<FillSkip, number>>>;
  readonly unfinished: number;
}

export function tallyOf(signals: readonly BacktestSignal[], scenario: ScenarioKey): ScenarioTally {
  const outcomes: TradeOutcome[] = [];
  const skipped: Partial<Record<FillSkip, number>> = {};
  let unfinished = 0;
  for (const signal of signals) {
    const result = signal.results[scenario];
    if (result.kind === 'CLOSED') outcomes.push(result.outcome);
    else if (result.kind === 'SKIPPED') skipped[result.reason] = (skipped[result.reason] ?? 0) + 1;
    else unfinished += 1;
  }
  return { signals: signals.length, stats: statsOf(outcomes), skipped, unfinished };
}
