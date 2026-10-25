import { describe, expect, it } from 'vitest';

import { causeChangeDelta, closedDelta, createdDelta } from './delta';
import {
  RollupTables,
  diffRollups,
  repairRollups,
  rollupsOfTrades,
  subtractRollups,
} from './tables';
import { SIGNAL, closed, randomCases, record, seeded, type RandomCase } from './test-data';
import { EMPTY_DELTA, type LedgerTrade, type RollupDelta } from './types';

/** The tables as the events of the cases build them, one after the other, the way the worker writes them. */
function incremental(cases: readonly RandomCase[]): RollupDelta {
  const tables = new RollupTables();
  for (const { trade, preliminaryCause } of cases) {
    tables.apply(createdDelta(trade));
    if (trade.outcome === null) continue;
    tables.apply(closedDelta({ ...trade, outcome: trade.outcome, primaryCause: preliminaryCause }));
    if (trade.primaryCause !== preliminaryCause) {
      tables.apply(
        causeChangeDelta(
          { ...trade, netR: trade.outcome.realizedRNet ?? 0 },
          preliminaryCause,
          trade.primaryCause,
        ),
      );
    }
  }
  return tables.snapshot();
}

describe('RollupTables', () => {
  it('adds the numbers of an event to the row of the same key, with three decimals (0.1 + 0.2 is 0.3)', () => {
    const tables = new RollupTables()
      .apply(closedDelta(closed('WIN', 0.1)))
      .apply(closedDelta(closed('WIN', 0.2)));
    const [row] = tables.snapshot().buckets;
    expect(row).toMatchObject({ n: 2, wins: 2, winners: 2, sumR: 0.3, sumWinR: 0.3 });
  });

  it('keeps a table of rows in the order of their keys (scope, level), and has nothing for nothing', () => {
    expect(new RollupTables().snapshot()).toEqual(EMPTY_DELTA);
    const keys = new RollupTables().apply(closedDelta(closed('LOSS', -1))).snapshot().buckets;
    expect(keys.map((row) => row.level)).toEqual([0, 1, 2, 3, 4]);
    const mixed = new RollupTables()
      .apply(closedDelta(closed('LOSS', -1), 'FORWARD'))
      .apply(closedDelta(closed('LOSS', -1), 'BACKTEST_OOS'))
      .snapshot().buckets;
    expect(mixed.map((row) => row.scope)).toEqual([
      ...Array<string>(5).fill('BACKTEST_OOS'),
      ...Array<string>(5).fill('FORWARD'),
    ]);
  });

  it('drops a row that went back to zero: a cause that lost its last result is not a row', () => {
    const tables = new RollupTables()
      .apply(closedDelta(closed('LOSS', -1.04, 'NO_FOLLOW_THROUGH')))
      .apply(
        causeChangeDelta({ ...SIGNAL, netR: -1.04 }, 'NO_FOLLOW_THROUGH', 'STOP_HUNT_REVERSAL'),
      );
    expect(tables.snapshot().causes.map((row) => [row.causeCode, row.n, row.sumR])).toEqual([
      ['STOP_HUNT_REVERSAL', 1, -1.04],
    ]);
  });

  it('gives the same table whatever the order of the events', () => {
    const cases = randomCases(7, 120);
    const forward = incremental(cases);
    const reversed = incremental([...cases].reverse());
    expect(reversed).toEqual(forward);
  });

  it('gives the same table when two halves are made apart and then joined (the order does not matter either)', () => {
    const cases = randomCases(11, 200);
    const first = incremental(cases.slice(0, 77));
    const second = incremental(cases.slice(77));
    const joined = new RollupTables().apply(first).apply(second).snapshot();
    expect(joined).toEqual(incremental(cases));
  });
});

describe('rollupsOfTrades: the tables of one recomputation equal those the events built', () => {
  it.each([1, 2, 3, 4, 5, 6])(
    'seed %i: 250 signals, every kind of result, final reviews that moved a cause',
    (seed) => {
      const cases = randomCases(seed, 250);
      const expected = rollupsOfTrades(cases.map((item) => item.trade));
      expect(incremental(cases)).toEqual(expected);
      expect(diffRollups(incremental(cases), expected)).toEqual([]);
      // the generator really has all the cases it claims to have
      const results = new Set(cases.map((item) => item.trade.outcome?.result ?? 'OPEN'));
      expect(results).toEqual(
        new Set(['OPEN', 'WIN', 'PARTIAL_WIN', 'LOSS', 'TIME_EXIT', 'CANCELLED', 'DATA_INVALID']),
      );
      expect(cases.some((item) => item.trade.primaryCause !== item.preliminaryCause)).toBe(true);
      expect(new Set(expected.monthly.map((row) => row.month)).size).toBeGreaterThanOrEqual(3);
    },
  );

  it('counts every signal as generated, in its month, and the monthly rows of all strategies are the sum of the strategies', () => {
    const cases = randomCases(21, 300);
    const rows = rollupsOfTrades(cases.map((item) => item.trade)).monthly;
    const all = rows.filter((row) => row.strategyKey === '*');
    expect(all.reduce((sum, row) => sum + row.generated, 0)).toBe(300);
    for (const month of new Set(rows.map((row) => row.month))) {
      const mine = rows.filter((row) => row.month === month);
      const total = mine.find((row) => row.strategyKey === '*');
      const parts = mine.filter((row) => row.strategyKey !== '*');
      expect(total?.generated).toBe(parts.reduce((sum, row) => sum + row.generated, 0));
      expect(total?.resolvedValid).toBe(parts.reduce((sum, row) => sum + row.resolvedValid, 0));
      expect(total?.winners).toBe(parts.reduce((sum, row) => sum + row.winners, 0));
    }
  });

  it('keeps the relations of the numbers: results add up to the counted ones, R splits into gains and losses', () => {
    const rows = rollupsOfTrades(randomCases(31, 400).map((item) => item.trade));
    for (const row of rows.monthly) {
      expect(row.wins + row.partials + row.losses + row.timeExits).toBe(row.resolvedValid);
      expect(row.winners).toBeLessThanOrEqual(row.resolvedValid);
      expect(row.sumWinR).toBeGreaterThanOrEqual(0);
      expect(row.sumLossR).toBeLessThanOrEqual(0);
      expect(row.netR).toBeCloseTo(row.sumWinR + row.sumLossR, 6);
      expect(row.generated).toBeGreaterThanOrEqual(
        row.resolvedValid + row.cancelled + row.dataInvalid,
      );
    }
    for (const row of rows.buckets) {
      expect(row.wins + row.partials + row.losses + row.timeExits).toBe(row.n);
      expect(row.tp2Hits).toBeLessThanOrEqual(row.tp1Hits + row.tp2Hits);
      expect(row.sumR).toBeCloseTo(row.sumWinR + row.sumLossR, 6);
    }
    // the widest level holds every counted trade of its strategy and side once
    const widest = rows.buckets.filter((row) => row.level === 4);
    const counted = rows.monthly.filter((row) => row.strategyKey === '*');
    expect(widest.reduce((sum, row) => sum + row.n, 0)).toBe(
      counted.reduce((sum, row) => sum + row.resolvedValid, 0),
    );
    for (const level of [0, 1, 2, 3]) {
      const total = rows.buckets
        .filter((row) => row.level === level)
        .reduce((sum, row) => sum + row.n, 0);
      expect(total).toBe(widest.reduce((sum, row) => sum + row.n, 0));
    }
  });

  it('leaves out of the failures every result that was not reviewed', () => {
    const trades: LedgerTrade[] = [
      { ...SIGNAL, outcome: record('WIN', 1), primaryCause: null },
      { ...SIGNAL, outcome: record('LOSS', -1), primaryCause: 'NORMAL_LOSS' },
      { ...SIGNAL, outcome: null, primaryCause: null },
    ];
    expect(rollupsOfTrades(trades).causes).toEqual([
      {
        month: '2026-10-01',
        strategyKey: 'trend_pullback',
        causeCode: 'NORMAL_LOSS',
        n: 1,
        sumR: -1,
      },
    ]);
  });

  it('is deterministic', () => {
    const cases = randomCases(5, 100).map((item) => item.trade);
    expect(rollupsOfTrades(cases)).toEqual(rollupsOfTrades(cases));
    const random = seeded(5);
    expect(random()).toBe(seeded(5)());
  });
});

describe('subtractRollups', () => {
  it('gives what the events of the second half added to the tables of the first half', () => {
    const cases = randomCases(61, 150);
    const first = incremental(cases.slice(0, 90));
    const all = incremental(cases);
    expect(subtractRollups(all, first)).toEqual(incremental(cases.slice(90)));
    expect(subtractRollups(all, all)).toEqual(EMPTY_DELTA);
    expect(subtractRollups(first, EMPTY_DELTA)).toEqual(first);
  });
});

describe('repairRollups', () => {
  const expected = rollupsOfTrades(randomCases(51, 120).map((item) => item.trade));

  it('makes damaged tables the recomputed ones: wrong numbers, missing rows and rows that should not be there', () => {
    const damaged: RollupDelta = {
      buckets: expected.buckets
        .filter((_row, index) => index !== 4)
        .map((row, index) => (index === 1 ? { ...row, n: row.n + 3, sumR: row.sumR - 1 } : row)),
      monthly: expected.monthly.map((row, index) => (index === 0 ? { ...row, winners: 99 } : row)),
      groups: [
        ...expected.groups.slice(2),
        {
          scope: 'FORWARD',
          strategyKey: 'trend_pullback',
          groupKey: 'trend',
          state: 'NA',
          n: 9,
          wins: 1,
          sumR: 2,
        },
      ],
      causes: [
        ...expected.causes,
        { month: '2020-01-01', strategyKey: 'x', causeCode: 'TIME_DECAY', n: 1, sumR: -1 },
      ],
    };
    const found = diffRollups(damaged, expected);
    expect(found.length).toBeGreaterThanOrEqual(5);
    const repaired = repairRollups(damaged, found);
    expect(diffRollups(repaired, expected)).toEqual([]);
    expect(new RollupTables().apply(repaired).snapshot()).toEqual(expected);
  });

  it('leaves tables that agree as they are', () => {
    expect(repairRollups(expected, diffRollups(expected, expected))).toEqual(expected);
  });
});

describe('diffRollups', () => {
  const base = rollupsOfTrades(randomCases(41, 60).map((item) => item.trade));

  it('is empty for tables that agree, whatever the order and the rows of zeros', () => {
    expect(diffRollups(base, base)).toEqual([]);
    const zero = { ...base.causes[0], causeCode: 'TIME_DECAY' as const, n: 0, sumR: 0 };
    expect(
      diffRollups(
        { ...base, causes: [...base.causes, zero as (typeof base.causes)[number]] },
        base,
      ),
    ).toEqual([]);
    expect(diffRollups({ ...base, buckets: [...base.buckets].reverse() }, base)).toEqual([]);
  });

  it('names a number that is wrong, with the stored row and the expected one', () => {
    const wrong = {
      ...base,
      monthly: base.monthly.map((row, index) =>
        index === 0 ? { ...row, netR: row.netR + 0.5 } : row,
      ),
    };
    const found = diffRollups(wrong, base);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ table: 'stats_monthly' });
    expect(found[0]?.stored).toMatchObject({ netR: (base.monthly[0]?.netR ?? 0) + 0.5 });
    expect(found[0]?.expected).toEqual(base.monthly[0]);
  });

  it('names a row that is missing, and a row that should not be there', () => {
    const missing = { ...base, groups: base.groups.slice(1) };
    expect(diffRollups(missing, base)).toMatchObject([
      { table: 'evidence_group_stats', stored: null, expected: base.groups[0] },
    ]);
    const extra = {
      ...base,
      causes: [
        ...base.causes,
        { month: '2026-01-01', strategyKey: 'x', causeCode: 'TIME_DECAY' as const, n: 2, sumR: -1 },
      ],
    };
    expect(diffRollups(extra, base)).toMatchObject([
      { table: 'failure_cause_stats', expected: null },
    ]);
  });

  it('tolerates less than half of a thousandth of R and not more', () => {
    const near = {
      ...base,
      buckets: base.buckets.map((row, index) =>
        index === 0 ? { ...row, sumR: row.sumR + 0.0004 } : row,
      ),
    };
    expect(diffRollups(near, base)).toEqual([]);
    const far = {
      ...base,
      buckets: base.buckets.map((row, index) =>
        index === 0 ? { ...row, sumR: row.sumR + 0.001 } : row,
      ),
    };
    expect(diffRollups(far, base)).toHaveLength(1);
  });

  it('finds a difference in every table, in the order of table and key', () => {
    const shifted: RollupDelta = {
      buckets: base.buckets.map((row, i) => (i === 3 ? { ...row, n: row.n + 1 } : row)),
      monthly: base.monthly.map((row, i) =>
        i === 2 ? { ...row, generated: row.generated + 1 } : row,
      ),
      groups: base.groups.map((row, i) => (i === 1 ? { ...row, wins: row.wins + 1 } : row)),
      causes: base.causes.map((row, i) => (i === 0 ? { ...row, n: row.n + 1 } : row)),
    };
    expect(diffRollups(shifted, base).map((item) => item.table)).toEqual([
      'stats_bucket',
      'stats_monthly',
      'evidence_group_stats',
      'failure_cause_stats',
    ]);
  });
});
