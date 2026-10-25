import { describe, expect, it } from 'vitest';

import type { VariantResult } from './command';
import { renderAblation } from './reportAblation';
import type { ReportMeta } from './report';
import { runBacktest, type BacktestRun } from './run';
import { pullbackSpec } from '../../../../packages/core/src/engine/test-data';
import { wavyBars } from './test-data';
import type { AblationVerdict } from './ablation';

const META: ReportMeta = {
  runId: 'r1',
  createdAt: '2026-10-25T12:00:00.000Z',
  git: { commit: 'abc123', dirty: false },
  files: ['a.csv'],
  notes: null,
};

const BARS = wavyBars();
const run = (through: 'TRAIN' | 'VALIDATION'): BacktestRun =>
  runBacktest(BARS, { specs: [pullbackSpec()], spreadUsd: 0.12, through });

const verdict = (change: Partial<AblationVerdict> = {}): AblationVerdict => ({
  strategyKey: 'trend_pullback',
  period: 'TRAIN',
  outOfSample: false,
  rows: (['A', 'B', 'C'] as const).map((scenario) => ({
    scenario,
    baseline: { n: 40, expectancyR: 0.1, profitFactor: 1.2 },
    variant: { n: 35, expectancyR: 0.25, profitFactor: 1.6 },
    better: true,
  })),
  stability: [],
  betterShare: null,
  meetsCriteria: true,
  admitted: false,
  reasons: [],
  ...change,
});

const variantOf = (
  baseline: BacktestRun,
  assignments: string[],
  v: AblationVerdict,
): VariantResult => ({
  assignments,
  run: baseline,
  verdicts: [v],
});

describe('renderAblation', () => {
  const baseline = run('TRAIN');

  it('says that the training is no admission, and that nothing after it was read', () => {
    const text = renderAblation(baseline, [variantOf(baseline, ['a=1'], verdict())], META);
    expect(text).toContain('# Ablation r1');
    expect(text).toContain('Compared on the **TRAIN** period; the runs went through TRAIN.');
    expect(text).toContain('never an admission');
    expect(text).toContain('Nothing after the end of the training was read.');
  });

  it('shows every variant with its changes and one row for each strategy', () => {
    const text = renderAblation(
      baseline,
      [variantOf(baseline, ['a=1', 'b=2'], verdict()), variantOf(baseline, ['c=3'], verdict())],
      META,
    );
    expect(text).toContain('Variants tried in this run: 2');
    expect(text).toContain('## Variant 1: `a=1`, `b=2`');
    expect(text).toContain('## Variant 2: `c=3`');
    expect(text).toContain(
      '| trend_pullback | 40 | 0.100 | 35 / 35 / 35 | 0.250 / 0.250 / 0.250 | 1.20 to 1.60 |',
    );
  });

  it('says what became of the variant: a candidate on the training, admitted out of sample, or no with the first reason', () => {
    const candidate = renderAblation(baseline, [variantOf(baseline, ['a=1'], verdict())], META);
    expect(candidate).toContain('better in sample (a tuning look, not an admission)');
    const validation = run('VALIDATION');
    const admitted = renderAblation(
      validation,
      [
        variantOf(
          validation,
          ['a=1'],
          verdict({ outOfSample: true, admitted: true, period: 'VALIDATION' }),
        ),
      ],
      META,
    );
    expect(admitted).toContain('| ADMITTED |');
    expect(admitted).toContain(
      'This period is out of sample: a variant that meets every criterion on it is admitted.',
    );
    const no = renderAblation(
      baseline,
      [
        variantOf(
          baseline,
          ['a=1'],
          verdict({ meetsCriteria: false, reasons: ['scenario B: only 12 trades (need 30)', 'x'] }),
        ),
      ],
      META,
    );
    expect(no).toContain('no: scenario B: only 12 trades (need 30)');
    expect(no).not.toContain('| x |');
  });

  it('counts the signals of every half year for the baseline and each variant', () => {
    const text = renderAblation(baseline, [variantOf(baseline, ['a=1'], verdict())], META);
    expect(text).toContain('## Signals per half year (all strategies, scenario A)');
    expect(text).toContain('| Half year | Baseline | Variant 1 |');
    expect(text).toContain('| 2024H1 |');
  });

  it('warns about trials, and prints the notes when there are some', () => {
    const text = renderAblation(baseline, [variantOf(baseline, ['a=1'], verdict())], {
      ...META,
      notes: 'a note',
    });
    expect(text).toContain('rests on many trials is weaker');
    expect(text).toContain('## Notes\n\na note');
  });

  it('marks a run on a changed tree', () => {
    const text = renderAblation(baseline, [], { ...META, git: { commit: 'abc', dirty: true } });
    expect(text).toContain('commit abc (with uncommitted changes)');
  });
});
