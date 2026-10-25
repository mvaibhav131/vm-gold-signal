import { describe, expect, it } from 'vitest';

import { pullbackSpec } from '../../../../packages/core/src/engine/test-data';
import { renderReport, type ReportMeta } from './report';
import { runBacktest, type BacktestRun } from './run';
import { wavyBars } from './test-data';

const RUN = runBacktest(wavyBars(), { specs: [pullbackSpec()], spreadUsd: 0.12 });
const META: ReportMeta = {
  runId: '20261025-120000',
  createdAt: '2026-10-25T12:00:00.000Z',
  git: { commit: 'abc123', dirty: false },
  files: ['a.csv', 'b.csv'],
  notes: null,
};

describe('renderReport', () => {
  const text = renderReport(RUN, META);

  it('starts with the run and what it was made of', () => {
    expect(text.startsWith('# Backtest report 20261025-120000\n')).toBe(true);
    expect(text).toContain('commit abc123.');
    expect(text).toContain('a.csv, b.csv');
    expect(text).toContain(`${String(RUN.replay.bars)} bars`);
  });

  it('says the gate first, on the period it judged, with a verdict for each strategy', () => {
    expect(text.indexOf('## Decision gate')).toBeLessThan(text.indexOf('## What was run'));
    expect(text).toContain('Judged on the **VALIDATION** period (the test period was not read)');
    expect(text).toContain('The run went through VALIDATION: no bar from 2026-01-01 on was read.');
    expect(text).toContain('| trend_pullback | INSUFFICIENT: fewer than 30 trades in A |');
  });

  it('says plainly that too few trades are not evidence, and that nothing passed', () => {
    expect(text).toContain('**Result: no strategy shows a positive net expectancy after costs');
    expect(text).toContain('too few trades to say anything either way');
    expect(text).toContain('Decision gate after B28');
  });

  it('shows the cost scenarios, the split and the limits of the test', () => {
    expect(text).toContain('| A | 0.05 | 0 |');
    expect(text).toContain('| B | 0.3 | 0 |');
    expect(text).toContain('| C | 0.05 | 20 |');
    expect(text).toContain('The run went through VALIDATION: no bar from 2026-01-01 on was read.');
    expect(text).toContain('Limits of this test (bars, not ticks):');
    expect(text).toContain('Spread: 0.120 USD, always');
  });

  it('has a table for each period that was read, and none for the test that was not', () => {
    expect(text).toContain('## Results: TRAIN');
    expect(text).toContain('## Results: VALIDATION');
    expect(text).toContain('## Results: ALL');
    expect(text).not.toContain('## Results: TEST');
  });

  it('shows why setups did not become signals, with the counts', () => {
    expect(text).toContain('## Why setups did not become signals');
    expect(text).toContain(
      `${String(RUN.replay.setups)} setups on ${String(RUN.replay.closes)} closed 5m candles`,
    );
    expect(text).toContain('| Gate | Setups |');
  });

  it('has the half years of the stability table', () => {
    expect(text).toContain('## Stability by half year');
    expect(text).toContain('| 2024H1 |');
  });

  it('marks a run on a changed working tree, and prints the notes', () => {
    const marked = renderReport(RUN, {
      ...META,
      git: { commit: 'abc', dirty: true },
      notes: 'a note',
    });
    expect(marked).toContain('commit abc (with uncommitted changes)');
    expect(marked).toContain('## Notes\n\na note');
    expect(text).not.toContain('## Notes');
  });

  it('opens the test period section, and says so, when the holdout was open', () => {
    const open = runBacktest(wavyBars(), {
      specs: [pullbackSpec()],
      spreadUsd: 0.12,
      through: 'TEST',
    });
    const opened = renderReport(open, META);
    expect(opened).toContain('## Results: TEST');
    expect(opened).toContain('(the test period was opened for this run)');
    expect(opened).toContain('Judged on the **TEST** period');
  });

  it('says PASS only when a strategy passed, with the warning about chance and the forward test', () => {
    const passed: BacktestRun = {
      ...RUN,
      gate: {
        period: 'VALIDATION',
        outOfSample: true,
        strategies: [
          {
            strategyKey: 'trend_pullback',
            n: { A: 40, B: 40, C: 40 },
            expectancyR: { A: 0.2, B: 0.1, C: 0.1 },
            verdict: 'PASS',
          },
        ],
        overall: 'PASS',
        passed: ['trend_pullback'],
      },
    };
    const report = renderReport(passed, META);
    expect(report).toContain(
      '**Result: PASS.** trend_pullback show a positive net expectancy after costs in A, B and C',
    );
    expect(report).toContain('the forward test decides');
    expect(report).toContain('PASS: positive net expectancy in A, B and C');
    expect(report).not.toContain('no strategy shows');
  });

  it('describes a result that is not "too few" in its own words', () => {
    const failed: BacktestRun = {
      ...RUN,
      gate: {
        period: 'VALIDATION',
        outOfSample: true,
        strategies: [
          {
            strategyKey: 'trend_pullback',
            n: { A: 40, B: 40, C: 40 },
            expectancyR: { A: -0.1, B: -0.2, C: -0.2 },
            verdict: 'FAIL',
          },
        ],
        overall: 'NO_EDGE',
        passed: [],
      },
    };
    const report = renderReport(failed, META);
    expect(report).toContain('FAIL: expectancy is not positive in A');
    expect(report).toContain('See the verdicts above.');
    expect(report).not.toContain('too few trades to say anything');
  });
});
