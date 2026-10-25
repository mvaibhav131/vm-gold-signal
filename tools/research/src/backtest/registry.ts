import { COST_SCENARIOS, type StrategyKey } from '@vmgs/core';

import type { BacktestRun } from './run';
import type { Split, SplitKey } from './splits';

export const EXPERIMENT_KINDS = ['BACKTEST', 'ABLATION_BASELINE', 'ABLATION_VARIANT'] as const;
export type ExperimentKind = (typeof EXPERIMENT_KINDS)[number];

/**
 * One line of the experiment registry (`02` section 15): the fields of the `experiments` table, one record
 * for each strategy of a run. Failed variants are kept: nothing is ever removed.
 */
export interface ExperimentRecord {
  /** The run: every record of one command has the same one. */
  readonly runId: string;
  readonly createdAt: string;
  readonly gitCommit: string;
  /** The working tree had changes that the commit does not hold. */
  readonly gitDirty: boolean;
  readonly kind: ExperimentKind;
  readonly strategyKey: StrategyKey;
  readonly version: string;
  /** The strategy config, and for a variant the changes made to it. */
  readonly params: unknown;
  readonly dataSpec: Readonly<Record<string, unknown>>;
  readonly split: Readonly<Record<string, { readonly from: string; readonly until: string }>>;
  /** The last period the run went through: no bar after it was read. */
  readonly through: SplitKey;
  /** The test period was open in this run. */
  readonly holdout: boolean;
  /** How many records of this strategy the registry holds, this one included: the multiple-testing log. */
  readonly trialsInFamily: number;
  readonly costModel: Readonly<Record<string, unknown>>;
  readonly metrics: unknown;
  readonly notes: string | null;
}

const iso = (ms: number): string => (Number.isFinite(ms) ? new Date(ms).toISOString() : 'open');

export function splitSpecOf(split: Split): ExperimentRecord['split'] {
  return Object.fromEntries(
    Object.values(split).map((period) => [
      period.key,
      { from: iso(period.from), until: iso(period.until) },
    ]),
  );
}

export const COST_MODEL: ExperimentRecord['costModel'] = {
  scenarios: COST_SCENARIOS,
  bars: 'M1 bid bars; ask = bid + the spread; a stop and a target in one bar are settled against the trade; a delayed fill drifts from the open towards the adverse extreme of its minute',
};

/** The registry lines of a run: one per strategy, with the numbers of that strategy. */
export function recordsOfRun(
  run: BacktestRun,
  context: {
    readonly runId: string;
    readonly kind: ExperimentKind;
    readonly now: number;
    readonly git: { readonly commit: string; readonly dirty: boolean };
    readonly history: readonly ExperimentRecord[];
    readonly params: (strategyKey: StrategyKey) => unknown;
    readonly files: readonly string[];
    readonly notes: string | null;
  },
): ExperimentRecord[] {
  const { replay } = run;
  const seen = new Map<StrategyKey, number>();
  for (const record of context.history) {
    seen.set(record.strategyKey, (seen.get(record.strategyKey) ?? 0) + 1);
  }
  return run.strategies.map(({ strategyKey, version }) => {
    const trials = (seen.get(strategyKey) ?? 0) + 1;
    return {
      runId: context.runId,
      createdAt: new Date(context.now).toISOString(),
      gitCommit: context.git.commit,
      gitDirty: context.git.dirty,
      kind: context.kind,
      strategyKey,
      version,
      params: context.params(strategyKey),
      dataSpec: {
        source: 'HistData XAUUSD M1 (bid bars, UTC-5 converted to UTC)',
        files: context.files,
        from: replay.firstAt === null ? null : iso(replay.firstAt),
        to: replay.lastAt === null ? null : iso(replay.lastAt),
        bars: replay.bars,
        spreadUsd: run.spreadUsd,
        spreadModel: 'constant, no recorded spreads for the past',
      },
      split: splitSpecOf(run.split),
      through: run.through,
      holdout: run.holdout,
      trialsInFamily: trials,
      costModel: COST_MODEL,
      metrics: {
        gate: run.gate.strategies.find((row) => row.strategyKey === strategyKey) ?? null,
        rows: run.rows
          .filter((row) => row.strategyKey === strategyKey)
          .map((row) => ({
            period: row.period,
            scenario: row.scenario,
            signals: row.signals,
            unfinished: row.unfinished,
            skipped: row.skipped,
            stats: row.stats,
          })),
      },
      notes: context.notes,
    };
  });
}

/** The registry as it is stored: one JSON record on each line. */
export function serializeRecords(records: readonly ExperimentRecord[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

export function parseRegistry(text: string): ExperimentRecord[] {
  const records: ExperimentRecord[] = [];
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      records.push(JSON.parse(line) as ExperimentRecord);
    } catch {
      throw new Error(`the registry has a line that is not JSON (line ${String(index + 1)})`);
    }
  });
  return records;
}

/**
 * The holdout is opened once. A second look at it makes it a validation set (whatever is tuned after seeing it
 * is tuned on it), so it needs `again` and is recorded as such.
 */
export function guardHoldout(
  history: readonly ExperimentRecord[],
  strategies: readonly StrategyKey[],
  options: { readonly holdout: boolean; readonly again: boolean },
): void {
  if (!options.holdout || options.again) return;
  const opened = history.filter(
    (record) => record.holdout && strategies.includes(record.strategyKey),
  );
  const first = opened[0];
  if (first === undefined) return;
  throw new Error(
    `the test period was already opened for ${first.strategyKey} by run ${first.runId} on ${first.createdAt.slice(0, 10)}: ` +
      'looking again makes it a validation set. Run again with --holdout-again to accept that (it is recorded).',
  );
}

export function holdoutViews(
  history: readonly ExperimentRecord[],
  strategyKey: StrategyKey,
): number {
  return history.filter((record) => record.holdout && record.strategyKey === strategyKey).length;
}
