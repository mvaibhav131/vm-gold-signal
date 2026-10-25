import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { STRATEGY_KEYS, type StrategyKey } from '@vmgs/core';

import { parseArgs, throughOf, valueOf, variantsOf } from './args';
import { ablateCommand, backtestCommand } from './backtest/command';
import { parseRegistry, serializeRecords } from './backtest/registry';
import { sourcesOf } from './files';
import { importHistData } from './histdata/import';

export const DEFAULT_SPREAD_USD = 0.2;

function gitInfo(): { commit: string; dirty: boolean } {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty =
      execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';
    return { commit, dirty };
  } catch {
    return { commit: 'unknown', dirty: true };
  }
}

const stamp = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '').replace('T', '-');

function strategiesOf(text: string | undefined): StrategyKey[] {
  if (text === undefined) return [];
  return text.split(',').map((key) => {
    const found = STRATEGY_KEYS.find((candidate) => candidate === key.trim());
    if (found === undefined)
      throw new Error(`unknown strategy "${key}" (${STRATEGY_KEYS.join(', ')})`);
    return found;
  });
}

/**
 * `backtest:run` and `backtest:ablate` with the files and the registry on disk: the report goes to
 * `<out>/backtest-<run>.md` (or `ablation-...`), and the experiment lines are appended to `<out>/experiments.jsonl`.
 */
export function backtestCli(
  command: 'backtest:run' | 'backtest:ablate',
  rest: readonly string[],
  base: string,
  print: (line: string) => void,
): void {
  const args = parseArgs(rest);
  const spread = Number(valueOf(args, 'spread') ?? DEFAULT_SPREAD_USD);
  if (!(spread >= 0) || !Number.isFinite(spread))
    throw new Error('--spread must be a number of USD');
  const out = resolve(base, valueOf(args, 'out') ?? 'reports');
  const registryPath = join(out, 'experiments.jsonl');
  const history = existsSync(registryPath) ? parseRegistry(readFileSync(registryPath, 'utf8')) : [];

  const sources = sourcesOf(args.positional, base);
  const { bars, report: imported } = importHistData(sources, { spreadAt: () => 0 });
  if (bars.length === 0) throw new Error('the backtest reads M1 bar files (the name has _M1_)');
  print(
    `read ${String(imported.minutes)} minutes from ${String(sources.length)} file(s); ${String(imported.rejected.DUPLICATE ?? 0)} duplicate rows left out`,
  );

  const now = Date.now();
  const common = {
    bars,
    strategies: strategiesOf(valueOf(args, 'strategy')),
    spreadUsd: spread,
    through: throughOf(args),
    holdoutAgain: args.flags.has('holdout-again'),
    runId: stamp(now),
    now,
    git: gitInfo(),
    history,
    files: sources.map((source) => source.name),
    notes: valueOf(args, 'notes') ?? null,
  };

  mkdirSync(out, { recursive: true });
  if (command === 'backtest:run') {
    const result = backtestCommand(common);
    writeFileSync(join(out, result.reportName), result.report);
    appendFileSync(registryPath, serializeRecords(result.records));
    print(`gate (${result.run.gate.period}): ${result.run.gate.overall}`);
    for (const row of result.run.gate.strategies) print(`  ${row.strategyKey}: ${row.verdict}`);
    print(
      `report ${join(out, result.reportName)}; ${String(result.records.length)} registry lines`,
    );
    return;
  }
  const result = ablateCommand({ ...common, variants: variantsOf(args) });
  writeFileSync(join(out, result.reportName), result.report);
  appendFileSync(registryPath, serializeRecords(result.records));
  result.variants.forEach((variant, index) => {
    print(`variant ${String(index + 1)}: ${variant.assignments.join(', ')}`);
    for (const verdict of variant.verdicts) {
      const [a] = verdict.rows;
      const state = verdict.admitted
        ? 'admitted'
        : verdict.meetsCriteria
          ? 'better in sample'
          : 'no';
      print(
        `  ${verdict.strategyKey}: ${String(a?.baseline.n ?? 0)} to ${String(a?.variant.n ?? 0)} trades in A, ${state}`,
      );
    }
  });
  print(`report ${join(out, result.reportName)}; ${String(result.records.length)} registry lines`);
}
