import type { StrategyKey, StrategySpec } from '@vmgs/core';

import type { BidBar } from '../histdata/format';
import { evaluateGate, type GateReport } from './gate';
import { tallyOf, type ScenarioTally } from './metrics';
import { replay, type ReplayResult } from './replay';
import {
  DEFAULT_SPLIT,
  halfYears,
  inPeriod,
  periodsThrough,
  readUntil,
  type Period,
  type Split,
  type SplitKey,
} from './splits';
import { SCENARIO_KEYS, type BacktestSignal, type ScenarioKey } from './types';

export interface BacktestOptions {
  readonly specs: readonly StrategySpec[];
  /** The spread of gold in USD, the same all the time: there are no recorded spreads for the past (`02` section 2.1). */
  readonly spreadUsd: number;
  readonly split?: Split;
  /** The last period the run goes through (default the validation): no bar after it is read. `TEST` opens the holdout. */
  readonly through?: SplitKey;
}

/** One strategy (or `ALL`) in one period under one scenario. */
export interface MetricRow extends ScenarioTally {
  readonly strategyKey: StrategyKey | 'ALL';
  readonly period: string;
  readonly scenario: ScenarioKey;
}

export interface BacktestRun {
  readonly strategies: readonly { readonly strategyKey: StrategyKey; readonly version: string }[];
  readonly spreadUsd: number;
  readonly split: Split;
  readonly through: SplitKey;
  /** The test period was read in this run. */
  readonly holdout: boolean;
  readonly replay: ReplayResult;
  /** The periods the rows are in: the splits that were read, the whole range and its half years. */
  readonly periods: readonly Period[];
  readonly rows: readonly MetricRow[];
  readonly gate: GateReport;
}

/** The rows of a list of signals: every strategy and `ALL`, every period, every scenario. */
export function metricRows(
  signals: readonly BacktestSignal[],
  strategies: readonly StrategyKey[],
  periods: readonly Period[],
): MetricRow[] {
  const rows: MetricRow[] = [];
  for (const period of periods) {
    const inside = inPeriod(signals, period);
    for (const strategyKey of [...strategies, 'ALL' as const]) {
      const own =
        strategyKey === 'ALL'
          ? inside
          : inside.filter((signal) => signal.strategyKey === strategyKey);
      for (const scenario of SCENARIO_KEYS) {
        rows.push({ strategyKey, period: period.key, scenario, ...tallyOf(own, scenario) });
      }
    }
  }
  return rows;
}

/**
 * The backtest: the history through the engine (`replay`), the signals followed under the three cost
 * scenarios, the numbers by strategy, split and half year, and the decision gate. Deterministic: the same
 * bars and specs give the same run.
 */
export function runBacktest(bars: readonly BidBar[], options: BacktestOptions): BacktestRun {
  const split = options.split ?? DEFAULT_SPLIT;
  const through = options.through ?? 'VALIDATION';
  const until = readUntil(split, through);
  const result = replay(bars, {
    specs: options.specs,
    spreadAt: () => options.spreadUsd,
    ...(until === undefined ? {} : { until }),
  });
  const strategies = options.specs.map((spec) => spec.strategyKey);
  const end = result.lastAt === null ? split.TEST.from : result.lastAt + 1;
  const periods: Period[] = [
    ...periodsThrough(split, through),
    { key: 'ALL', from: Number.NEGATIVE_INFINITY, until: Number.POSITIVE_INFINITY },
    ...(result.firstAt === null ? [] : halfYears(result.firstAt, end)),
  ];
  return {
    strategies: options.specs.map((spec) => ({
      strategyKey: spec.strategyKey,
      version: spec.version,
    })),
    spreadUsd: options.spreadUsd,
    split,
    through,
    holdout: through === 'TEST',
    replay: result,
    periods,
    rows: metricRows(result.signals, strategies, periods),
    gate: evaluateGate(result.signals, split, through, strategies),
  };
}
