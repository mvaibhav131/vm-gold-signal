import { EVIDENCE_MIN_SAMPLE, type StrategyKey } from '@vmgs/core';

import type { BacktestRun, MetricRow } from './run';
import { SCENARIO_KEYS, type ScenarioKey } from './types';

/** A variant is stable when it is better in at least this share of the half years that have trades in both runs, and in at least three of them. */
export const STABLE_SHARE = 2 / 3;
export const MIN_SUB_PERIODS = 3;

export interface AblationRow {
  readonly scenario: ScenarioKey;
  readonly baseline: {
    readonly n: number;
    readonly expectancyR: number | null;
    readonly profitFactor: number | null;
  };
  readonly variant: {
    readonly n: number;
    readonly expectancyR: number | null;
    readonly profitFactor: number | null;
  };
  readonly better: boolean;
}

export interface AblationVerdict {
  readonly strategyKey: StrategyKey;
  /** The period the comparison is made on: the last one the runs went through. */
  readonly period: string;
  /** False on the training: there the variant is chosen, so being better is a tuning result and never an admission. */
  readonly outOfSample: boolean;
  readonly rows: readonly AblationRow[];
  readonly stability: readonly {
    readonly period: string;
    readonly baselineR: number;
    readonly variantR: number;
    readonly better: boolean;
  }[];
  readonly betterShare: number | null;
  /** The variant meets every criterion on this period (on the training: in sample). */
  readonly meetsCriteria: boolean;
  /** It meets them out of sample: only this admits the feature. */
  readonly admitted: boolean;
  readonly reasons: readonly string[];
}

const pfOf = (row: MetricRow): number =>
  row.stats.profitFactor ?? (row.stats.n > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
const expOf = (row: MetricRow): number => row.stats.expectancyR ?? Number.NEGATIVE_INFINITY;

function rowOf(
  run: BacktestRun,
  strategyKey: StrategyKey,
  period: string,
  scenario: ScenarioKey,
): MetricRow {
  const found = run.rows.find(
    (row) => row.strategyKey === strategyKey && row.period === period && row.scenario === scenario,
  );
  if (found === undefined)
    throw new Error(`the run has no ${strategyKey} row for ${period} ${scenario}`);
  return found;
}

const brief = (row: MetricRow) => ({
  n: row.stats.n,
  expectancyR: row.stats.expectancyR,
  profitFactor: row.stats.profitFactor,
});

/**
 * Feature admission (`02` section 15): the baseline against the baseline plus the feature, on the same
 * out-of-sample data. The feature is admitted only when, in all three cost scenarios, it has at least 30
 * trades and a higher expectancy and profit factor than the baseline, and it is better in most of the half
 * years (stably), not in one lucky stretch.
 */
export function compareRuns(
  baseline: BacktestRun,
  variant: BacktestRun,
  strategyKey: StrategyKey,
): AblationVerdict {
  const period = baseline.gate.period;
  const reasons: string[] = [];
  const rows = SCENARIO_KEYS.map((scenario): AblationRow => {
    const base = rowOf(baseline, strategyKey, period, scenario);
    const test = rowOf(variant, strategyKey, period, scenario);
    const better = expOf(test) > expOf(base) && pfOf(test) > pfOf(base);
    if (test.stats.n < EVIDENCE_MIN_SAMPLE) {
      reasons.push(
        `scenario ${scenario}: only ${String(test.stats.n)} trades (need ${String(EVIDENCE_MIN_SAMPLE)})`,
      );
    } else if (!better) {
      reasons.push(
        `scenario ${scenario}: expectancy and profit factor are not both higher than the baseline`,
      );
    }
    return { scenario, baseline: brief(base), variant: brief(test), better };
  });

  const stability = baseline.periods
    .filter((candidate) => /^\d{4}H[12]$/.test(candidate.key))
    .flatMap((candidate) => {
      const base = rowOf(baseline, strategyKey, candidate.key, 'A');
      const test = rowOf(variant, strategyKey, candidate.key, 'A');
      if (base.stats.n === 0 || test.stats.n === 0) return [];
      const baselineR = base.stats.expectancyR ?? 0;
      const variantR = test.stats.expectancyR ?? 0;
      return [{ period: candidate.key, baselineR, variantR, better: variantR > baselineR }];
    });
  const betterShare =
    stability.length === 0
      ? null
      : stability.filter((item) => item.better).length / stability.length;
  if (stability.length < MIN_SUB_PERIODS) {
    reasons.push(
      `only ${String(stability.length)} half years have trades in both runs (need ${String(MIN_SUB_PERIODS)})`,
    );
  } else if ((betterShare ?? 0) < STABLE_SHARE) {
    reasons.push('the variant is better in too few of the half years (not stable)');
  }
  return {
    strategyKey,
    period,
    outOfSample: baseline.gate.outOfSample,
    rows,
    stability,
    betterShare,
    meetsCriteria: reasons.length === 0,
    admitted: reasons.length === 0 && baseline.gate.outOfSample,
    reasons,
  };
}
