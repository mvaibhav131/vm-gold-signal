import { defaultStrategyConfig, strategySpecOf, type StrategyConfig } from '@vmgs/config';
import { STRATEGY_KEYS, type StrategyKey } from '@vmgs/core';

import type { BidBar } from '../histdata/format';
import { compareRuns, type AblationVerdict } from './ablation';
import { guardHoldout, recordsOfRun, type ExperimentRecord, type ExperimentKind } from './registry';
import { renderReport } from './report';
import { renderAblation } from './reportAblation';
import { runBacktest, type BacktestRun } from './run';
import type { SplitKey } from './splits';
import { variantOf } from './variant';

export interface Provenance {
  readonly runId: string;
  readonly now: number;
  readonly git: { readonly commit: string; readonly dirty: boolean };
  /** The registry as it stands: the trials and the holdout views are counted from it. */
  readonly history: readonly ExperimentRecord[];
  readonly files: readonly string[];
  readonly notes: string | null;
}

export interface BacktestInput extends Provenance {
  readonly bars: readonly BidBar[];
  readonly strategies: readonly StrategyKey[];
  readonly spreadUsd: number;
  /** The last period the run goes through: no bar after it is read. `TEST` opens the holdout. */
  readonly through: SplitKey;
  readonly holdoutAgain: boolean;
}

export interface CommandOutput {
  readonly run: BacktestRun;
  readonly records: readonly ExperimentRecord[];
  readonly report: string;
  readonly reportName: string;
}

const specsOf = (configs: readonly StrategyConfig[]) =>
  configs.map((config) => strategySpecOf(config, 'RESEARCH'));

const metaOf = (input: Provenance) => ({
  runId: input.runId,
  createdAt: new Date(input.now).toISOString(),
  git: input.git,
  files: input.files,
  notes: input.notes,
});

function recordsOf(
  run: BacktestRun,
  input: Provenance,
  kind: ExperimentKind,
  params: (key: StrategyKey) => unknown,
  history: readonly ExperimentRecord[],
): ExperimentRecord[] {
  return recordsOfRun(run, {
    runId: input.runId,
    kind,
    now: input.now,
    git: input.git,
    history,
    params,
    files: input.files,
    notes: input.notes,
  });
}

const guard = (input: BacktestInput, strategies: readonly StrategyKey[]): void => {
  guardHoldout(input.history, strategies, {
    holdout: input.through === 'TEST',
    again: input.holdoutAgain,
  });
};

/** `backtest:run`: the strategies with their default configs over the history, the report and the registry lines. */
export function backtestCommand(input: BacktestInput): CommandOutput {
  const strategies = input.strategies.length === 0 ? STRATEGY_KEYS : input.strategies;
  guard(input, strategies);
  const configs = strategies.map((key) => defaultStrategyConfig(key));
  const run = runBacktest(input.bars, {
    specs: specsOf(configs),
    spreadUsd: input.spreadUsd,
    through: input.through,
  });
  const records = recordsOf(
    run,
    input,
    'BACKTEST',
    (key) => configs.find((config) => config.strategyKey === key),
    input.history,
  );
  return {
    run,
    records,
    report: renderReport(run, metaOf(input)),
    reportName: `backtest-${input.runId}.md`,
  };
}

export interface AblationInput extends BacktestInput {
  /** Each variant is a list of `path=value` changes, made to the config of every strategy of the run. */
  readonly variants: readonly (readonly string[])[];
}

export interface VariantResult {
  readonly assignments: readonly string[];
  readonly run: BacktestRun;
  /** One for each strategy: the variant against its baseline. */
  readonly verdicts: readonly AblationVerdict[];
}

export interface AblationOutput {
  readonly baseline: BacktestRun;
  readonly variants: readonly VariantResult[];
  readonly records: readonly ExperimentRecord[];
  readonly report: string;
  readonly reportName: string;
}

/**
 * `backtest:ablate`: the strategies as they are, and for each variant the same strategies with the changes made, all
 * over the same bars. The baseline is run once. Every run is recorded, and each variant is one more trial of each
 * strategy (the number of trials is what tells how much a good result may be luck).
 */
export function ablateCommand(input: AblationInput): AblationOutput {
  const strategies = input.strategies.length === 0 ? STRATEGY_KEYS : input.strategies;
  if (input.variants.length === 0)
    throw new Error('give at least one variant (--set or --variant)');
  guard(input, strategies);
  const options = { spreadUsd: input.spreadUsd, through: input.through };
  const baseConfigs = strategies.map((key) => defaultStrategyConfig(key));
  const baseline = runBacktest(input.bars, { ...options, specs: specsOf(baseConfigs) });
  const baselineRecords = recordsOf(
    baseline,
    input,
    'ABLATION_BASELINE',
    (key) => baseConfigs.find((config) => config.strategyKey === key),
    input.history,
  );
  let history: readonly ExperimentRecord[] = [...input.history, ...baselineRecords];
  const records = [...baselineRecords];
  const variants: VariantResult[] = [];
  for (const assignments of input.variants) {
    const configs = baseConfigs.map((config) => {
      const trial =
        history.filter((record) => record.strategyKey === config.strategyKey).length + 1;
      return variantOf(config, assignments, trial);
    });
    const run = runBacktest(input.bars, { ...options, specs: specsOf(configs) });
    const made = recordsOf(
      run,
      input,
      'ABLATION_VARIANT',
      (key) => ({ assignments, config: configs.find((config) => config.strategyKey === key) }),
      history,
    );
    history = [...history, ...made];
    records.push(...made);
    variants.push({
      assignments,
      run,
      verdicts: strategies.map((key) => compareRuns(baseline, run, key)),
    });
  }
  return {
    baseline,
    variants,
    records,
    report: renderAblation(baseline, variants, metaOf(input)),
    reportName: `ablation-${input.runId}.md`,
  };
}
