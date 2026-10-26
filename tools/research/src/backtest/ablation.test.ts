import { describe, expect, it } from 'vitest';

import { STABLE_SHARE, compareRuns } from './ablation';
import type { Stats } from './metrics';
import type { BacktestRun, MetricRow } from './run';
import { DEFAULT_SPLIT, halfYears } from './splits';
import { SCENARIO_KEYS, type ScenarioKey } from './types';

const stats = (n: number, expectancyR: number | null, profitFactor: number | null): Stats => ({
  n,
  winners: 0,
  expectancyR,
  netR: 0,
  profitFactor,
  winRate: null,
  ci95: null,
  maxDrawdownR: 0,
  tp1Rate: null,
  timeExits: 0,
  ambiguous: 0,
  dataInvalid: 0,
});

type Cell = readonly [n: number, expectancy: number | null, profitFactor: number | null];

/** A run with the numbers we say for the validation (all scenarios the same unless given) and each half year (scenario A). */
function fakeRun(
  validation: Cell | Readonly<Record<ScenarioKey, Cell>>,
  halves: Readonly<Record<string, Cell>>,
  through: 'TRAIN' | 'VALIDATION' = 'VALIDATION',
): BacktestRun {
  const cell = (scenario: ScenarioKey): Cell =>
    Array.isArray(validation)
      ? (validation as Cell)
      : (validation as Record<ScenarioKey, Cell>)[scenario];
  const periods = [
    DEFAULT_SPLIT[through],
    ...halfYears(Date.UTC(2022, 0, 1), Date.UTC(2025, 0, 1)),
  ];
  const rows: MetricRow[] = [];
  for (const period of periods) {
    for (const scenario of SCENARIO_KEYS) {
      const [n, e, pf] =
        period.key === through ? cell(scenario) : (halves[period.key] ?? [0, null, null]);
      rows.push({
        strategyKey: 'trend_pullback',
        period: period.key,
        scenario,
        signals: n,
        stats: stats(scenario === 'A' || period.key === through ? n : 0, e, pf),
        skipped: {},
        unfinished: 0,
      });
    }
  }
  return {
    strategies: [{ strategyKey: 'trend_pullback', version: '0.1.0' }],
    spreadUsd: 0.2,
    split: DEFAULT_SPLIT,
    through,
    holdout: false,
    replay: {
      signals: [],
      bars: 0,
      firstAt: null,
      lastAt: null,
      closes: 0,
      setups: 0,
      decisions: 0,
      rejectedSetups: 0,
      rejectedBy: {},
      duplicates: 0,
      noQuote: 0,
    },
    periods,
    rows,
    gate: {
      period: through,
      outOfSample: through !== 'TRAIN',
      strategies: [],
      overall: 'NO_EDGE',
      passed: [],
    },
  };
}

const HALVES_BASE = {
  '2022H1': [10, 0.1, 1.2],
  '2022H2': [10, 0.1, 1.2],
  '2023H1': [10, 0.1, 1.2],
  '2023H2': [10, 0.1, 1.2],
} as const;
const HALVES_BETTER = {
  '2022H1': [10, 0.3, 1.5],
  '2022H2': [10, 0.3, 1.5],
  '2023H1': [10, 0.3, 1.5],
  '2023H2': [10, 0.05, 1.1],
} as const;

describe('compareRuns', () => {
  const baseline = fakeRun([40, 0.1, 1.2], HALVES_BASE);

  it('admits a variant that is better in all three scenarios and in most half years', () => {
    const verdict = compareRuns(
      baseline,
      fakeRun([35, 0.25, 1.6], HALVES_BETTER),
      'trend_pullback',
    );
    expect(verdict.admitted).toBe(true);
    expect(verdict.meetsCriteria).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.period).toBe('VALIDATION');
    expect(verdict.betterShare).toBe(0.75);
    expect(verdict.rows.map((row) => row.better)).toEqual([true, true, true]);
    expect(verdict.stability).toHaveLength(4);
  });

  it('does not admit a variant with fewer than 30 trades in a scenario', () => {
    const verdict = compareRuns(
      baseline,
      fakeRun({ A: [40, 0.3, 2], B: [29, 0.3, 2], C: [40, 0.3, 2] }, HALVES_BETTER),
      'trend_pullback',
    );
    expect(verdict.admitted).toBe(false);
    expect(verdict.reasons).toEqual(['scenario B: only 29 trades (need 30)']);
  });

  it('wants both the expectancy and the profit factor to be higher, strictly, in every scenario', () => {
    const sameExpectancy = compareRuns(
      baseline,
      fakeRun([40, 0.1, 2], HALVES_BETTER),
      'trend_pullback',
    );
    expect(sameExpectancy.admitted).toBe(false);
    expect(sameExpectancy.reasons).toHaveLength(3);
    const lowerPf = compareRuns(baseline, fakeRun([40, 0.3, 1.2], HALVES_BETTER), 'trend_pullback');
    expect(lowerPf.reasons[0]).toContain('not both higher');
    const costs = compareRuns(
      baseline,
      fakeRun({ A: [40, 0.3, 2], B: [40, 0.3, 2], C: [40, 0.05, 2] }, HALVES_BETTER),
      'trend_pullback',
    );
    expect(costs.reasons).toEqual([
      'scenario C: expectancy and profit factor are not both higher than the baseline',
    ]);
  });

  it('reads a profit factor of none (no loss) as the best there is, and no trade as the worst', () => {
    const noLoss = compareRuns(
      fakeRun([40, 0.1, null], HALVES_BASE),
      fakeRun([40, 0.3, null], HALVES_BETTER),
      'trend_pullback',
    );
    expect(noLoss.rows[0]?.better).toBe(false);
    const vsNoLoss = compareRuns(
      fakeRun([40, 0.1, 1.2], HALVES_BASE),
      fakeRun([40, 0.3, null], HALVES_BETTER),
      'trend_pullback',
    );
    expect(vsNoLoss.rows[0]?.better).toBe(true);
  });

  it('does not admit a variant that is better in too few half years: a lucky stretch', () => {
    const lucky = {
      '2022H1': [10, 0.5, 2],
      '2022H2': [10, 0.05, 1],
      '2023H1': [10, 0.05, 1],
      '2023H2': [10, 0.05, 1],
    } as const;
    const verdict = compareRuns(baseline, fakeRun([40, 0.3, 2], lucky), 'trend_pullback');
    expect(verdict.admitted).toBe(false);
    expect(verdict.betterShare).toBe(0.25);
    expect(verdict.reasons).toEqual([
      'the variant is better in too few of the half years (not stable)',
    ]);
  });

  it('is stable at exactly two thirds', () => {
    const twoOfThree = {
      '2022H1': [10, 0.3, 2],
      '2022H2': [10, 0.3, 2],
      '2023H1': [10, 0.05, 1],
    } as const;
    const base3 = {
      '2022H1': [10, 0.1, 1],
      '2022H2': [10, 0.1, 1],
      '2023H1': [10, 0.1, 1],
    } as const;
    const verdict = compareRuns(
      fakeRun([40, 0.1, 1.2], base3),
      fakeRun([40, 0.3, 2], twoOfThree),
      'trend_pullback',
    );
    expect(verdict.admitted).toBe(true);
  });

  it('is not stable below two thirds: one of three and two of four are too few', () => {
    expect(STABLE_SHARE).toBe(2 / 3);
    const base = {
      '2022H1': [10, 0.1, 1],
      '2022H2': [10, 0.1, 1],
      '2023H1': [10, 0.1, 1],
      '2023H2': [10, 0.1, 1],
    } as const;
    const oneOfThree = {
      '2022H1': [10, 0.3, 2],
      '2022H2': [10, 0.05, 1],
      '2023H1': [10, 0.05, 1],
    } as const;
    const twoOfFour = {
      '2022H1': [10, 0.3, 2],
      '2022H2': [10, 0.3, 2],
      '2023H1': [10, 0.05, 1],
      '2023H2': [10, 0.05, 1],
    } as const;
    const unstable = ['the variant is better in too few of the half years (not stable)'];
    const third = compareRuns(
      fakeRun([40, 0.1, 1.2], base),
      fakeRun([40, 0.3, 2], oneOfThree),
      'trend_pullback',
    );
    expect(third.betterShare).toBe(1 / 3);
    expect(third.reasons).toEqual(unstable);
    const half = compareRuns(
      fakeRun([40, 0.1, 1.2], base),
      fakeRun([40, 0.3, 2], twoOfFour),
      'trend_pullback',
    );
    expect(half.betterShare).toBe(0.5);
    expect(half.reasons).toEqual(unstable);
    expect(half.admitted).toBe(false);
  });

  it('does not call a half year better when the variant earns exactly what the baseline does', () => {
    const same = {
      '2022H1': [10, 0.3, 2],
      '2022H2': [10, 0.3, 2],
      '2023H1': [10, 0.1, 1.2],
    } as const;
    const verdict = compareRuns(baseline, fakeRun([40, 0.3, 2], same), 'trend_pullback');
    expect(verdict.stability.map((item) => item.better)).toEqual([true, true, false]);
    expect(verdict.betterShare).toBe(2 / 3);
  });

  it('takes a variant with exactly 30 trades in every scenario', () => {
    const verdict = compareRuns(
      baseline,
      fakeRun([30, 0.25, 1.6], HALVES_BETTER),
      'trend_pullback',
    );
    expect(verdict.reasons).toEqual([]);
    expect(verdict.admitted).toBe(true);
  });

  it('needs three half years with trades in both runs, and leaves out those where either has none', () => {
    const few = {
      '2022H1': [10, 0.3, 2],
      '2022H2': [10, 0.3, 2],
      '2023H1': [0, null, null],
    } as const;
    const verdict = compareRuns(baseline, fakeRun([40, 0.3, 2], few), 'trend_pullback');
    expect(verdict.stability.map((item) => item.period)).toEqual(['2022H1', '2022H2']);
    expect(verdict.admitted).toBe(false);
    expect(verdict.reasons).toEqual(['only 2 half years have trades in both runs (need 3)']);
  });

  it('is only a candidate on the training: it meets the criteria there, and is not admitted', () => {
    const train = compareRuns(
      fakeRun([40, 0.1, 1.2], HALVES_BASE, 'TRAIN'),
      fakeRun([35, 0.25, 1.6], HALVES_BETTER, 'TRAIN'),
      'trend_pullback',
    );
    expect(train).toMatchObject({
      period: 'TRAIN',
      outOfSample: false,
      meetsCriteria: true,
      admitted: false,
    });
    const validation = compareRuns(
      baseline,
      fakeRun([35, 0.25, 1.6], HALVES_BETTER),
      'trend_pullback',
    );
    expect(validation).toMatchObject({ outOfSample: true, meetsCriteria: true, admitted: true });
  });

  it('says it when the run has no row for the strategy', () => {
    expect(() => compareRuns(baseline, baseline, 'sweep_reversal')).toThrow(
      'no sweep_reversal row',
    );
  });
});
