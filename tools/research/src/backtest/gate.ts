import { EVIDENCE_MIN_SAMPLE, STRATEGY_KEYS, type StrategyKey } from '@vmgs/core';

import { tallyOf } from './metrics';
import { inPeriod, type Period, type Split, type SplitKey } from './splits';
import { SCENARIO_KEYS, type BacktestSignal, type ScenarioKey } from './types';

/**
 * PASS: a positive net expectancy in A, B and C on the out-of-sample period. COST_FRAGILE: positive in A
 * only, or too few trades left in B or C (it does not pass: `02` section 15). FAIL: not positive in A. INSUFFICIENT: fewer than 30 trades
 * in A, so there is nothing to say.
 */
export type GateVerdict = 'PASS' | 'COST_FRAGILE' | 'FAIL' | 'INSUFFICIENT';

export interface StrategyGate {
  readonly strategyKey: StrategyKey;
  readonly n: Readonly<Record<ScenarioKey, number>>;
  readonly expectancyR: Readonly<Record<ScenarioKey, number | null>>;
  readonly verdict: GateVerdict;
}

export interface GateReport {
  /** The period the gate was judged on: the validation, or the test when the holdout was opened. */
  readonly period: string;
  /** False for the training: that is where parameters are chosen, so it is no gate, only a description. */
  readonly outOfSample: boolean;
  readonly strategies: readonly StrategyGate[];
  /** `PASS` when at least one strategy passed, otherwise `NO_EDGE`. */
  readonly overall: 'PASS' | 'NO_EDGE';
  readonly passed: readonly StrategyKey[];
}

/**
 * A scenario shows a positive expectancy only on at least 30 trades: when the costs of B or C make the owner skip
 * most of the trades, what is left is too little to call positive, and the strategy is cost fragile.
 */
export function verdictOf(
  n: Readonly<Record<ScenarioKey, number>>,
  expectancy: Readonly<Record<ScenarioKey, number | null>>,
): GateVerdict {
  if (n.A < EVIDENCE_MIN_SAMPLE) return 'INSUFFICIENT';
  const positive = (key: ScenarioKey): boolean =>
    n[key] >= EVIDENCE_MIN_SAMPLE && (expectancy[key] ?? 0) > 0;
  if (!((expectancy.A ?? 0) > 0)) return 'FAIL';
  return positive('B') && positive('C') ? 'PASS' : 'COST_FRAGILE';
}

/**
 * The decision gate after B28 (`06` section 1): out of sample, with the costs of the three scenarios. The period
 * is the last one that the run went `through`: the validation, or the test (the honest one) when the holdout was
 * opened. A run that went through the training only has no gate: its period is in sample.
 */
export function evaluateGate(
  signals: readonly BacktestSignal[],
  split: Split,
  through: SplitKey,
  strategies: readonly StrategyKey[] = STRATEGY_KEYS,
): GateReport {
  const period: Period = split[through];
  const sample = inPeriod(signals, period);
  const rows = strategies.map((strategyKey): StrategyGate => {
    const own = sample.filter((signal) => signal.strategyKey === strategyKey);
    const tallies = Object.fromEntries(
      SCENARIO_KEYS.map((scenario) => [scenario, tallyOf(own, scenario).stats]),
    ) as Record<ScenarioKey, ReturnType<typeof tallyOf>['stats']>;
    const n = { A: tallies.A.n, B: tallies.B.n, C: tallies.C.n };
    const expectancyR = {
      A: tallies.A.expectancyR,
      B: tallies.B.expectancyR,
      C: tallies.C.expectancyR,
    };
    return { strategyKey, n, expectancyR, verdict: verdictOf(n, expectancyR) };
  });
  const passed = rows.filter((row) => row.verdict === 'PASS').map((row) => row.strategyKey);
  return {
    period: period.key,
    outOfSample: through !== 'TRAIN',
    strategies: rows,
    overall: passed.length > 0 ? 'PASS' : 'NO_EDGE',
    passed,
  };
}
