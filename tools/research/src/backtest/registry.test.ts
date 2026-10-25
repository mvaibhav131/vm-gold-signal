import { describe, expect, it } from 'vitest';

import { pullbackSpec } from '../../../../packages/core/src/engine/test-data';
import {
  COST_MODEL,
  guardHoldout,
  holdoutViews,
  parseRegistry,
  recordsOfRun,
  serializeRecords,
  splitSpecOf,
  type ExperimentRecord,
} from './registry';
import { runBacktest } from './run';
import { DEFAULT_SPLIT } from './splits';
import { wavyBars } from './test-data';

const RUN = runBacktest(wavyBars(), { specs: [pullbackSpec()], spreadUsd: 0.12 });
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

const context = (
  change: Partial<Parameters<typeof recordsOfRun>[1]> = {},
): Parameters<typeof recordsOfRun>[1] => ({
  runId: 'r1',
  kind: 'BACKTEST',
  now: NOW,
  git: { commit: 'abc123', dirty: false },
  history: [],
  params: (key) => ({ key }),
  files: ['a.csv', 'b.csv'],
  notes: null,
  ...change,
});

const [FIRST] = recordsOfRun(RUN, context());
if (FIRST === undefined) throw new Error('no record');

describe('recordsOfRun', () => {
  it('has one record for each strategy, with where it ran and with what', () => {
    const records = recordsOfRun(RUN, context({ notes: 'first look' }));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      runId: 'r1',
      createdAt: '2026-10-25T12:00:00.000Z',
      gitCommit: 'abc123',
      gitDirty: false,
      kind: 'BACKTEST',
      strategyKey: 'trend_pullback',
      version: '0.1.0',
      params: { key: 'trend_pullback' },
      holdout: false,
      trialsInFamily: 1,
      notes: 'first look',
    });
  });

  it('says what the data was: the files, the range, the bars and the spread assumption', () => {
    expect(FIRST.dataSpec).toMatchObject({
      files: ['a.csv', 'b.csv'],
      bars: RUN.replay.bars,
      spreadUsd: 0.12,
      spreadModel: 'constant, no recorded spreads for the past',
    });
    expect(FIRST.dataSpec.from).toBe(new Date(RUN.replay.firstAt ?? 0).toISOString());
    expect(FIRST.dataSpec.to).toBe(new Date(RUN.replay.lastAt ?? 0).toISOString());
  });

  it('keeps the split, the cost model and the metrics of that strategy only', () => {
    expect(FIRST.split).toEqual(splitSpecOf(DEFAULT_SPLIT));
    expect(FIRST.split.TEST).toEqual({
      from: '2026-01-01T00:00:00.000Z',
      until: '2100-01-01T00:00:00.000Z',
    });
    expect(FIRST.costModel).toBe(COST_MODEL);
    const metrics = FIRST.metrics as {
      gate: { strategyKey: string };
      rows: { period: string; scenario: string }[];
    };
    expect(metrics.gate.strategyKey).toBe('trend_pullback');
    expect(metrics.rows.length).toBe(
      RUN.rows.filter((row) => row.strategyKey === 'trend_pullback').length,
    );
    expect(metrics.rows.map((row) => row.scenario)).toContain('C');
  });

  it('counts the trials of a strategy from the registry, this one included, and the others apart', () => {
    const other: ExperimentRecord = { ...FIRST, strategyKey: 'sweep_reversal', runId: 'x' };
    const history = [FIRST, { ...FIRST, runId: 'r0' }, other];
    expect(recordsOfRun(RUN, context({ history }))[0]?.trialsInFamily).toBe(3);
    expect(recordsOfRun(RUN, context({ history: [other] }))[0]?.trialsInFamily).toBe(1);
  });

  it('records that the holdout was open', () => {
    const open = runBacktest(wavyBars(), {
      specs: [pullbackSpec()],
      spreadUsd: 0.12,
      through: 'TEST',
    });
    expect(recordsOfRun(open, context())[0]).toMatchObject({ holdout: true, through: 'TEST' });
    expect(FIRST).toMatchObject({ holdout: false, through: 'VALIDATION' });
  });
});

describe('the registry file', () => {
  it('is one JSON record on each line, and reads back the same', () => {
    const text = serializeRecords([FIRST, { ...FIRST, runId: 'r2' }]);
    expect(text.split('\n')).toHaveLength(3);
    expect(text.endsWith('\n')).toBe(true);
    expect(parseRegistry(text)).toEqual([FIRST, { ...FIRST, runId: 'r2' }]);
  });

  it('is empty for no records and for a blank file', () => {
    expect(serializeRecords([])).toBe('');
    expect(parseRegistry('\n  \n')).toEqual([]);
  });

  it('says which line is damaged', () => {
    expect(() => parseRegistry(`${JSON.stringify(FIRST)}\nnot json\n`)).toThrow('line 2');
  });
});

describe('guardHoldout', () => {
  const opened = {
    ...FIRST,
    holdout: true,
    runId: 'first-look',
    createdAt: '2026-10-01T00:00:00.000Z',
  };

  it('lets the first look at the test period through, and says nothing when the holdout is closed', () => {
    expect(() => {
      guardHoldout([FIRST], ['trend_pullback'], { holdout: true, again: false });
    }).not.toThrow();
    expect(() => {
      guardHoldout([opened], ['trend_pullback'], { holdout: false, again: false });
    }).not.toThrow();
  });

  it('refuses a second look, and names the run that made the first', () => {
    expect(() => {
      guardHoldout([opened], ['trend_pullback'], { holdout: true, again: false });
    }).toThrow('run first-look on 2026-10-01');
  });

  it('lets a second look through when it is asked for as such', () => {
    expect(() => {
      guardHoldout([opened], ['trend_pullback'], { holdout: true, again: true });
    }).not.toThrow();
  });

  it('is about the strategies of this run: the test period that another strategy used is not used up', () => {
    expect(() => {
      guardHoldout([opened], ['sweep_reversal'], { holdout: true, again: false });
    }).not.toThrow();
    expect(() => {
      guardHoldout([opened], ['sweep_reversal', 'trend_pullback'], { holdout: true, again: false });
    }).toThrow();
  });

  it('counts how many times the test period was opened for a strategy', () => {
    expect(holdoutViews([FIRST, opened, opened], 'trend_pullback')).toBe(2);
    expect(holdoutViews([FIRST, opened], 'sweep_reversal')).toBe(0);
  });
});
