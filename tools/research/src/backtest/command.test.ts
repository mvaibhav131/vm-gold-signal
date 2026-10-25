import { describe, expect, it } from 'vitest';

import { ablateCommand, backtestCommand, type BacktestInput } from './command';
import type { ExperimentRecord } from './registry';
import { wavyBars } from './test-data';

const BASE: BacktestInput = {
  bars: wavyBars(),
  strategies: ['trend_pullback'],
  spreadUsd: 0.12,
  through: 'VALIDATION',
  holdoutAgain: false,
  runId: 'r1',
  now: Date.UTC(2026, 9, 25, 12, 0, 0),
  git: { commit: 'abc123', dirty: false },
  history: [],
  files: ['a.csv'],
  notes: null,
};

describe('backtestCommand', () => {
  it('makes the report, its name and one registry record for each strategy, with the default config as the params', () => {
    const result = backtestCommand(BASE);
    expect(result.reportName).toBe('backtest-r1.md');
    expect(result.report.startsWith('# Backtest report r1')).toBe(true);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      kind: 'BACKTEST',
      strategyKey: 'trend_pullback',
      trialsInFamily: 1,
      through: 'VALIDATION',
    });
    expect((result.records[0]?.params as { version: string }).version).toBe('0.1.0');
    expect(result.run.strategies.map((s) => s.strategyKey)).toEqual(['trend_pullback']);
  });

  it('runs all five strategies when none is named', () => {
    const result = backtestCommand({ ...BASE, strategies: [] });
    expect(result.records.map((record) => record.strategyKey)).toEqual([
      'trend_pullback',
      'sweep_reversal',
      'squeeze_retest',
      'trendline_retest',
      'pattern_breakout',
    ]);
  });

  it('counts the trials from the history it is given', () => {
    const first = backtestCommand(BASE).records;
    const second = backtestCommand({ ...BASE, history: first, runId: 'r2' });
    expect(second.records[0]?.trialsInFamily).toBe(2);
  });

  it('goes through the period it is told, and opens the test only when it is told to', () => {
    expect(backtestCommand(BASE).run.holdout).toBe(false);
    const train = backtestCommand({ ...BASE, through: 'TRAIN' });
    expect(train.run).toMatchObject({ through: 'TRAIN', holdout: false });
    expect(train.run.gate.outOfSample).toBe(false);
    const open = backtestCommand({ ...BASE, through: 'TEST' });
    expect(open.run.holdout).toBe(true);
    expect(open.records[0]).toMatchObject({ holdout: true, through: 'TEST' });
  });

  it('refuses a second look at the test period unless it is asked for as one', () => {
    const history: ExperimentRecord[] = backtestCommand({ ...BASE, through: 'TEST' }).records.map(
      (record) => ({ ...record }),
    );
    expect(() => backtestCommand({ ...BASE, through: 'TEST', history })).toThrow('already opened');
    const again = backtestCommand({ ...BASE, through: 'TEST', holdoutAgain: true, history });
    expect(again.records[0]?.trialsInFamily).toBe(2);
  });

  it('is deterministic: the same input gives the same records and the same report', () => {
    const a = backtestCommand(BASE);
    const b = backtestCommand({ ...BASE, bars: wavyBars() });
    expect(JSON.stringify(a.records)).toBe(JSON.stringify(b.records));
    expect(a.report).toBe(b.report);
  });
});

describe('ablateCommand', () => {
  const input = { ...BASE, variants: [['gates.maxSpreadToStop=0.2']] };

  it('runs the baseline once and the variant on the same bars, and records both with the changes of the variant', () => {
    const result = ablateCommand(input);
    expect(result.reportName).toBe('ablation-r1.md');
    expect(result.records.map((record) => record.kind)).toEqual([
      'ABLATION_BASELINE',
      'ABLATION_VARIANT',
    ]);
    expect(result.records.map((record) => record.trialsInFamily)).toEqual([1, 2]);
    const variant = result.records[1];
    expect(variant?.version).toBe('0.1.1002');
    expect(variant?.params).toMatchObject({ assignments: ['gates.maxSpreadToStop=0.2'] });
    expect(result.baseline.replay.bars).toBe(result.variants[0]?.run.replay.bars);
    expect(result.report).toContain('# Ablation r1');
  });

  it('runs several variants over one baseline, each a trial of its own with its own version', () => {
    const result = ablateCommand({
      ...input,
      variants: [['gates.maxSpreadToStop=0.2'], ['gates.stopAtr=[0.8,3]', 'gates.tp1MaxAtr=3']],
    });
    expect(result.variants.map((variant) => variant.assignments)).toEqual([
      ['gates.maxSpreadToStop=0.2'],
      ['gates.stopAtr=[0.8,3]', 'gates.tp1MaxAtr=3'],
    ]);
    expect(result.records.map((record) => record.kind)).toEqual([
      'ABLATION_BASELINE',
      'ABLATION_VARIANT',
      'ABLATION_VARIANT',
    ]);
    expect(result.records.map((record) => record.version)).toEqual([
      '0.1.0',
      '0.1.1002',
      '0.1.1003',
    ]);
    expect(result.records.map((record) => record.trialsInFamily)).toEqual([1, 2, 3]);
  });

  it('makes the same changes to every strategy it is given, and compares each with its own baseline', () => {
    const result = ablateCommand({
      ...input,
      strategies: ['trend_pullback', 'trendline_retest'],
    });
    expect(result.variants[0]?.verdicts.map((verdict) => verdict.strategyKey)).toEqual([
      'trend_pullback',
      'trendline_retest',
    ]);
    const variants = result.records.filter((record) => record.kind === 'ABLATION_VARIANT');
    expect(variants.map((record) => [record.strategyKey, record.version])).toEqual([
      ['trend_pullback', '0.1.1002'],
      ['trendline_retest', '0.1.1002'],
    ]);
  });

  it('gives the variant a version from the trials so far, so that the second run is not the first', () => {
    const first = ablateCommand(input);
    const second = ablateCommand({ ...input, history: first.records, runId: 'r2' });
    expect(second.records[1]?.version).toBe('0.1.1004');
  });

  it('does not admit a variant of a short market: too few half years and trades', () => {
    expect(ablateCommand(input).variants[0]?.verdicts[0]?.admitted).toBe(false);
  });

  it('never admits on the training: being better there is a candidate, and the report says so', () => {
    const result = ablateCommand({ ...input, through: 'TRAIN' });
    const verdict = result.variants[0]?.verdicts[0];
    expect(verdict).toMatchObject({ outOfSample: false, admitted: false });
    expect(result.report).toContain('never an admission');
  });

  it('needs a variant, and refuses one that the config schema refuses or that names what does not exist', () => {
    expect(() => ablateCommand({ ...input, variants: [] })).toThrow('at least one variant');
    expect(() => ablateCommand({ ...input, variants: [['quality.min=10']] })).toThrow();
    expect(() => ablateCommand({ ...input, variants: [['quality.nope=1']] })).toThrow(
      'no "quality.nope"',
    );
  });

  it('guards the test period like a plain run does', () => {
    const first = ablateCommand({ ...input, through: 'TEST' });
    expect(() => ablateCommand({ ...input, through: 'TEST', history: first.records })).toThrow(
      'already opened',
    );
  });
});
