import { CAUSE_CODES, QUALITY_GROUPS, causeCategory, type StrategyKey } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import {
  CALIBRATION_BANDS,
  DRIFT_WINDOW,
  NEWS_BASELINE_SHARE,
  breakdownOf,
  calibrationOf,
  driftOf,
  equityOf,
  failuresOf,
  forwardRecordsOf,
  groupEffectivenessOf,
  inRange,
  monthlyOf,
  newsImpactOf,
  type AnalyticsRecord,
} from './analytics';
import { BACKTEST_SPEC, buildBacktest } from './backtest';
import { summarize, wilson } from './history';
import { buildSimSignal } from './signals';
import { buildTrades } from './trades';

// The preview started on a Friday at 12:00 UTC.
const ANCHOR = Date.parse('2026-10-23T12:00:00Z');
const trades = buildTrades(ANCHOR);
const forward = forwardRecordsOf([], trades, ANCHOR);
const backtest = buildBacktest(trades[0]?.generatedMs ?? ANCHOR);
const rowsOf = (records: readonly AnalyticsRecord[]) => records.map((r) => r.row);
const validOf = (records: readonly AnalyticsRecord[]) =>
  records.filter((r) => r.row.countsInStats === true);

describe('the Wilson interval (checked by hand)', () => {
  it('is the interval that the simulated signals quote as their evidence', () => {
    // 118 wins of 214: centre 0.5506, half width 0.0661
    expect(wilson(118, 214)).toEqual([0.484, 0.617]);
    expect(wilson(35, 64)).toEqual([0.426, 0.663]);
  });

  it('stops at 0 and at 1, and is not a point for a share of 0 or 1', () => {
    expect(wilson(0, 30)).toEqual([0, 0.114]);
    expect(wilson(30, 30)).toEqual([0.886, 1]);
  });
});

describe('the simulated out-of-sample backtest', () => {
  it('has exactly the numbers of the spec: valid results, wins, cancelled and data-invalid signals', () => {
    for (const spec of BACKTEST_SPEC) {
      const rows = rowsOf(backtest).filter((row) => row.strategyKey === spec.key);
      expect(rows, spec.key).toHaveLength(spec.valid + spec.cancelled + spec.invalid);
      expect(
        rows.filter((row) => row.countsInStats === true),
        spec.key,
      ).toHaveLength(spec.valid);
      expect(
        rows.filter((row) => row.isWin === true),
        spec.key,
      ).toHaveLength(spec.wins);
      expect(
        rows.filter((row) => row.result === 'CANCELLED'),
        spec.key,
      ).toHaveLength(spec.cancelled);
      expect(
        rows.filter((row) => row.result === 'DATA_INVALID'),
        spec.key,
      ).toHaveLength(spec.invalid);
    }
    expect(backtest).toHaveLength(318);
  });

  it('is the twelve whole months (display time zone) before the month in which the forward test starts', () => {
    // IST is UTC+5:30: 2025-07-01 00:00 IST is 2025-06-30 18:30 UTC
    const times = rowsOf(backtest).map((row) => Date.parse(row.generatedAt));
    expect(Math.min(...times)).toBeGreaterThanOrEqual(Date.parse('2025-06-30T18:30:00Z'));
    expect(Math.max(...times)).toBeLessThan(Date.parse('2026-06-30T18:30:00Z'));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(Math.max(...times)).toBeLessThan(trades[0]?.generatedMs ?? 0);
  });

  it('has weekday signals only, valid ids, numbers in time order and a grade for every signal', () => {
    const rows = rowsOf(backtest);
    rows.forEach((row, i) => {
      expect(row.seq).toBe(i + 1);
      expect([0, 6], `seq ${String(row.seq)}`).not.toContain(new Date(row.generatedAt).getUTCDay());
      expect(row.qualityScore).toBeGreaterThanOrEqual(65);
      expect(row.mode).toBe('BACKTEST');
      expect(row.strategyStatus).toBe('BACKTESTED');
    });
    expect(new Set(rows.map((row) => row.signalId)).size).toBe(rows.length);
  });

  it('gives a review with a cause to every result except a win, a cancelled and a data-invalid signal', () => {
    for (const { row } of backtest) {
      const reviewed =
        row.result !== 'WIN' && row.result !== 'CANCELLED' && row.result !== 'DATA_INVALID';
      expect(row.primaryCause !== null, `seq ${String(row.seq)} ${String(row.result)}`).toBe(
        reviewed,
      );
      if (row.result === 'TIME_EXIT' && (row.realizedRNet ?? 0) <= 0) {
        expect(row.primaryCause).toBe('TIME_DECAY');
      }
    }
    const causes = new Set(
      rowsOf(backtest).flatMap((row) => (row.primaryCause ? [row.primaryCause] : [])),
    );
    expect([...causes].sort()).toEqual([...CAUSE_CODES].sort());
  });

  it('is the same on every run for the same start', () => {
    expect(JSON.stringify(buildBacktest(trades[0]?.generatedMs ?? 0))).toBe(
      JSON.stringify(backtest),
    );
  });

  it('agrees with the evidence that the simulated signals quote for themselves (same scope, same numbers)', () => {
    const byStrategy = new Map(
      breakdownOf(backtest, 'strategy').items.map((item) => [item.key, item]),
    );
    for (const trade of trades) {
      const { evidence, strategyKey } = trade.signal;
      if (evidence.scope !== 'BACKTEST_OOS') continue;
      const row = byStrategy.get(strategyKey);
      expect(row, strategyKey).toBeDefined();
      expect([evidence.n, evidence.wins], `seq ${String(trade.seq)}`).toEqual([row?.n, row?.wins]);
      expect(evidence.winRate).toBe(row?.winRate);
      expect(evidence.ci).toEqual(row?.ci95);
      expect([evidence.expectancyR, evidence.profitFactor], `seq ${String(trade.seq)}`).toEqual([
        row?.expectancyR,
        row?.profitFactor,
      ]);
      const own = summarize(rowsOf(backtest).filter((r) => r.strategyKey === strategyKey));
      expect([evidence.tp1Rate, evidence.tp2Rate], `seq ${String(trade.seq)}`).toEqual([
        own.tp1Rate,
        own.tp2Rate,
      ]);
    }
    // the sweep reversal has too few backtest results to quote: its signals say "insufficient" on forward numbers
    expect(byStrategy.get('sweep_reversal')).toMatchObject({ n: 24, winRate: null, ci95: null });
  });
});

describe('overview of each scope', () => {
  it('forward: the numbers of the simulated history (hand-checked sums: 14 + 6 + 15 + 4 = 39 valid)', () => {
    expect(summarize(rowsOf(forward))).toMatchObject({
      generated: 41,
      resolvedValid: 39,
      wins: 14,
      partials: 6,
      losses: 15,
      timeExits: 4,
      cancelled: 1,
      dataInvalid: 1,
      winRate: 0.538,
      ci95: [0.386, 0.684],
      netR: 6.34,
      expectancyR: 0.16,
      profitFactor: 1.38,
      maxDrawdownR: 3.68,
    });
  });

  it('backtest: 302 valid results, a percentage with its interval and no open signal', () => {
    expect(summarize(rowsOf(backtest))).toMatchObject({
      generated: 318,
      resolvedValid: 302,
      wins: 102,
      partials: 55,
      losses: 124,
      timeExits: 21,
      cancelled: 11,
      dataInvalid: 5,
      winRate: 0.543,
      ci95: [0.487, 0.598],
      netR: 34.9,
      expectancyR: 0.12,
      profitFactor: 1.25,
      maxDrawdownR: 12.52,
    });
    expect(backtest.every(({ row }) => row.state === 'CLOSED')).toBe(true);
  });

  it('counts an open signal as generated and nothing else', () => {
    const open = forwardRecordsOf([buildSimSignal('buy', ANCHOR)], trades, ANCHOR);
    expect(open).toHaveLength(42);
    expect(summarize(rowsOf(open))).toMatchObject({ generated: 42, resolvedValid: 39 });
    expect(open[0]?.groups).toBeNull();
  });
});

describe('monthly', () => {
  it('forward: one row for each month since the first signal, and the months add up to the overview', () => {
    const { items } = monthlyOf(forward, 12);
    expect(items.map((m) => [m.month, m.generated, m.resolvedValid, m.netR])).toEqual([
      ['2026-07', 7, 7, 2.21],
      ['2026-08', 12, 11, 0.87],
      ['2026-09', 13, 12, 3.56],
      ['2026-10', 9, 9, -0.3],
    ]);
    // every month has fewer than 30 valid results: no percentage
    expect(items.every((m) => m.winRate === null)).toBe(true);
  });

  it('backtest: twelve months 2025-07 to 2026-06, which add up to the overview', () => {
    const { items } = monthlyOf(backtest, 12);
    expect(items.map((m) => m.month)).toEqual([
      '2025-07',
      '2025-08',
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
    ]);
    const total = summarize(rowsOf(backtest));
    const sum = (pick: (m: (typeof items)[number]) => number) =>
      items.reduce((acc, m) => acc + pick(m), 0);
    expect(sum((m) => m.generated)).toBe(total.generated);
    expect(sum((m) => m.resolvedValid)).toBe(total.resolvedValid);
    expect(sum((m) => m.wins)).toBe(total.wins);
    expect(sum((m) => m.partials)).toBe(total.partials);
    expect(sum((m) => m.losses)).toBe(total.losses);
    expect(sum((m) => m.timeExits)).toBe(total.timeExits);
    expect(sum((m) => m.cancelled)).toBe(total.cancelled);
    expect(sum((m) => m.dataInvalid)).toBe(total.dataInvalid);
    expect(sum((m) => m.netR)).toBeCloseTo(total.netR, 1);
  });

  it('keeps only the last N months, counted from the newest one', () => {
    const { items } = monthlyOf(backtest, 3);
    expect(items.map((m) => m.month)).toEqual(['2026-04', '2026-05', '2026-06']);
    expect(monthlyOf(forward, 1).items.map((m) => m.month)).toEqual(['2026-10']);
  });

  it('lists a month without any signal between two months that have some (all counts 0)', () => {
    const base = validOf(forward)[0];
    if (!base) throw new Error('fixture');
    const at = (iso: string): AnalyticsRecord => ({
      ...base,
      row: { ...base.row, generatedAt: iso, closedAt: iso },
    });
    const { items } = monthlyOf([at('2026-01-10T06:00:00Z'), at('2026-03-10T06:00:00Z')], 12);
    expect(items.map((m) => [m.month, m.generated])).toEqual([
      ['2026-01', 1],
      ['2026-02', 0],
      ['2026-03', 1],
    ]);
    expect(items[1]).toMatchObject({
      resolvedValid: 0,
      netR: 0,
      winRate: null,
      profitFactor: null,
    });
    expect(monthlyOf([], 12).items).toEqual([]);
  });

  it('puts a signal in the month of the display time zone, not of UTC', () => {
    const base = validOf(forward)[0];
    if (!base) throw new Error('fixture');
    // 2026-01-31 20:00 UTC is 2026-02-01 01:30 IST
    const late: AnalyticsRecord = {
      ...base,
      row: { ...base.row, generatedAt: '2026-01-31T20:00:00Z' },
    };
    expect(monthlyOf([late], 12).items.map((m) => m.month)).toEqual(['2026-02']);
  });
});

describe('breakdown', () => {
  const dimensions = [
    'strategy',
    'side',
    'session',
    'regime',
    'volatility',
    'news',
    'grade',
  ] as const;

  it('covers every valid result exactly once in every dimension, the biggest sample first', () => {
    for (const records of [forward, backtest]) {
      const valid = validOf(records);
      for (const by of dimensions) {
        const { items } = breakdownOf(records, by);
        expect(
          items.reduce((sum, item) => sum + item.n, 0),
          by,
        ).toBe(valid.length);
        expect(
          items.reduce((sum, item) => sum + item.wins, 0),
          by,
        ).toBe(valid.filter((r) => r.row.isWin === true).length);
        const sizes = items.map((item) => item.n);
        expect(
          [...sizes].sort((a, b) => b - a),
          by,
        ).toEqual(sizes);
      }
    }
  });

  it('shows a percentage only from 30 valid results and marks every sample under 100 (rule C6)', () => {
    for (const records of [forward, backtest]) {
      for (const by of dimensions) {
        for (const item of breakdownOf(records, by).items) {
          expect(item.winRate === null, `${by} ${item.key}`).toBe(item.n < 30);
          expect(item.ci95 === null, `${by} ${item.key}`).toBe(item.n < 30);
          expect(item.lowSample, `${by} ${item.key}`).toBe(item.n < 100);
        }
      }
    }
  });

  it('backtest by strategy: the numbers of the spec, with the interval of the evidence', () => {
    expect(breakdownOf(backtest, 'strategy').items).toEqual([
      expect.objectContaining({
        key: 'trend_pullback',
        n: 214,
        wins: 118,
        winRate: 0.551,
        ci95: [0.484, 0.617],
        lowSample: false,
      }),
      expect.objectContaining({
        key: 'squeeze_retest',
        n: 64,
        wins: 35,
        winRate: 0.547,
        ci95: [0.426, 0.663],
        lowSample: true,
      }),
      expect.objectContaining({
        key: 'sweep_reversal',
        n: 24,
        wins: 11,
        winRate: null,
        ci95: null,
        lowSample: true,
      }),
    ]);
  });

  it('forward by strategy: all under 30, so counts only', () => {
    expect(
      breakdownOf(forward, 'strategy').items.map((i) => [i.key, i.n, i.wins, i.winRate]),
    ).toEqual([
      ['trend_pullback', 24, 13, null],
      ['sweep_reversal', 11, 5, null],
      ['squeeze_retest', 4, 3, null],
    ]);
  });

  it('uses the grade names as keys and leaves out a key that has no valid result', () => {
    expect(breakdownOf(backtest, 'grade').items.map((i) => [i.key, i.n, i.wins])).toEqual([
      ['Strong', 158, 94],
      ['Moderate', 144, 70],
    ]);
    expect(breakdownOf(forward, 'news').items.map((i) => i.key)).toEqual(['CLEAR']);
  });

  it('computes expectancy and profit factor from the net R of the results (checked by hand)', () => {
    // squeeze_retest forward: seq 6 +1.47, 7... pick the four results and sum them
    const rows = validOf(forward)
      .map((r) => r.row)
      .filter((row) => row.strategyKey === 'squeeze_retest');
    const net = rows.reduce((sum, row) => sum + (row.realizedRNet ?? 0), 0);
    const gain = rows
      .filter((r) => (r.realizedRNet ?? 0) > 0)
      .reduce((s, r) => s + (r.realizedRNet ?? 0), 0);
    const loss = rows
      .filter((r) => (r.realizedRNet ?? 0) < 0)
      .reduce((s, r) => s - (r.realizedRNet ?? 0), 0);
    const item = breakdownOf(forward, 'strategy').items.find((i) => i.key === 'squeeze_retest');
    expect(item?.expectancyR).toBe(Math.round((net / rows.length) * 100) / 100);
    expect(item?.profitFactor).toBe(Math.round((gain / loss) * 100) / 100);
  });

  it('can be limited to a date range, from included and to excluded', () => {
    const second = rowsOf(forward)[1]?.generatedAt ?? '';
    const all = breakdownOf(forward, 'side').items.reduce((sum, i) => sum + i.n, 0);
    const none = breakdownOf(forward, 'side', { from: second, to: second }).items;
    expect(none).toEqual([]);
    const upTo = breakdownOf(forward, 'side', { to: second }).items.reduce(
      (sum, i) => sum + i.n,
      0,
    );
    expect(upTo).toBeLessThan(all);
    expect(
      inRange(forward, { from: second }).length + inRange(forward, { to: second }).length,
    ).toBe(forward.length);
  });

  it('marks a sample under 100 as low and one of 100 as normal; a percentage shows from 30', () => {
    const base = validOf(forward)[0];
    if (!base) throw new Error('fixture');
    const many = (count: number): AnalyticsRecord[] =>
      Array.from({ length: count }, (_, i) => ({ ...base, row: { ...base.row, seq: 9000 + i } }));
    const only = (count: number) => breakdownOf(many(count), 'side').items;
    expect(only(99)).toHaveLength(1);
    expect([only(99)[0]?.n, only(99)[0]?.lowSample]).toEqual([99, true]);
    expect([only(100)[0]?.n, only(100)[0]?.lowSample]).toEqual([100, false]);
    expect([only(29)[0]?.winRate, only(30)[0]?.winRate === null]).toEqual([null, false]);
  });
});

describe('failure analysis', () => {
  it('ranks the primary causes by count and then by R lost, with their categories', () => {
    for (const records of [forward, backtest]) {
      const { causes } = failuresOf(records);
      const reviewed = validOf(records).filter((r) => r.row.primaryCause !== null);
      expect(causes.reduce((sum, c) => sum + c.n, 0)).toBe(reviewed.length);
      for (const cause of causes) {
        expect(cause.category).toBe(causeCategory(cause.code));
        expect(cause.share).toBeCloseTo(cause.n / reviewed.length, 3);
      }
      for (let i = 1; i < causes.length; i += 1) {
        const [a, b] = [causes[i - 1], causes[i]];
        if (!a || !b) continue;
        expect(a.n > b.n || (a.n === b.n && a.sumR <= b.sumR)).toBe(true);
      }
    }
  });

  it('forward: the numbers of the simulated history', () => {
    const { causes, weakGroups } = failuresOf(forward);
    expect(causes.slice(0, 3).map((c) => [c.code, c.n, c.sumR])).toEqual([
      ['NORMAL_LOSS', 9, -3.68],
      ['NO_FOLLOW_THROUGH', 3, -3.1],
      ['HTF_STRUCTURE_BREAK', 3, -1.69],
    ]);
    expect(causes.find((c) => c.code === 'SPREAD_COST')).toMatchObject({
      n: 1,
      sumR: 0.25,
      category: 'EXECUTION',
    });
    expect(weakGroups[0]).toMatchObject({ group: 'trend', n: 6 });
    expect(causes.reduce((sum, c) => sum + c.n, 0)).toBe(25);
  });

  it('counts a result in a group ranking once if the group was weak, and leaves out a group that never was', () => {
    const { weakGroups } = failuresOf(backtest);
    const reviewed = validOf(backtest).filter((r) => r.row.primaryCause !== null);
    for (const entry of weakGroups) {
      const n = reviewed.filter((r) => r.weak.some((w) => w.group === entry.group)).length;
      expect(entry.n).toBe(n);
      expect(entry.share).toBeCloseTo(n / reviewed.length, 3);
    }
    expect(weakGroups.map((w) => w.group).every((g) => QUALITY_GROUPS.includes(g))).toBe(true);
    expect(weakGroups.every((w) => w.n > 0)).toBe(true);
  });

  it('is empty for a scope without a review, with no division by zero', () => {
    expect(failuresOf([])).toEqual({ causes: [], weakGroups: [] });
  });
});

describe('evidence-group effectiveness', () => {
  it('has, for every strategy and group, rows whose counts add up to the valid results of the strategy', () => {
    for (const records of [forward, backtest]) {
      const { items } = groupEffectivenessOf(records);
      for (const key of ['trend_pullback', 'sweep_reversal', 'squeeze_retest'] as StrategyKey[]) {
        const valid = validOf(records).filter((r) => r.row.strategyKey === key);
        for (const group of QUALITY_GROUPS) {
          const rows = items.filter((i) => i.strategy === key && i.group === group);
          expect(
            rows.reduce((sum, r) => sum + r.n, 0),
            `${key} ${group}`,
          ).toBe(valid.length);
          expect(
            rows.reduce((sum, r) => sum + r.wins, 0),
            `${key} ${group}`,
          ).toBe(valid.filter((r) => r.row.isWin === true).length);
        }
      }
    }
  });

  it('shows a percentage only from 30 results, for each group and state', () => {
    for (const item of groupEffectivenessOf(backtest).items) {
      expect(item.winRate === null, `${item.strategy} ${item.group} ${item.state}`).toBe(
        item.n < 30,
      );
      expect(item.ci95 === null).toBe(item.n < 30);
    }
    const strong = groupEffectivenessOf(backtest).items.find(
      (i) => i.strategy === 'trend_pullback' && i.group === 'trigger' && i.state === 'STRONG',
    );
    expect(strong).toMatchObject({ n: 58, wins: 41, winRate: 0.707 });
  });

  it('can be limited to one strategy, and lists the states in the order STRONG, OK, WEAK, FAIL', () => {
    const { items } = groupEffectivenessOf(backtest, 'squeeze_retest');
    expect(new Set(items.map((i) => i.strategy))).toEqual(new Set(['squeeze_retest']));
    const states = items.filter((i) => i.group === 'structure').map((i) => i.state);
    const order = ['STRONG', 'OK', 'WEAK', 'FAIL', 'NA'];
    expect(states).toEqual([...states].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  });

  it('skips the open signals, which have no groups yet', () => {
    const open = forwardRecordsOf([buildSimSignal('buy', ANCHOR)], trades, ANCHOR);
    expect(groupEffectivenessOf(open)).toEqual(groupEffectivenessOf(forward));
  });
});

describe('score calibration', () => {
  it('has the six bands in a row without a gap, every valid result in exactly one of them', () => {
    expect(CALIBRATION_BANDS.map(([from, to]) => [from, to])).toEqual([
      [65, 69],
      [70, 74],
      [75, 79],
      [80, 84],
      [85, 89],
      [90, 100],
    ]);
    for (const records of [forward, backtest]) {
      const { items } = calibrationOf(records);
      expect(items).toHaveLength(6);
      expect(items.reduce((sum, i) => sum + i.n, 0)).toBe(validOf(records).length);
      items.forEach((item, i) => {
        const next = items[i + 1];
        if (next) expect(next.bandFrom).toBe(item.bandTo + 1);
        expect(item.winRate === null).toBe(item.n < 30);
      });
    }
  });

  it('puts a score of 69.99 in the first band and 70 in the second (the band edge is the next band)', () => {
    const base = validOf(forward)[0];
    if (!base) throw new Error('fixture');
    const at = (score: number): AnalyticsRecord => ({
      ...base,
      row: { ...base.row, qualityScore: score },
    });
    const { items } = calibrationOf([at(69.99), at(70), at(100), at(65)]);
    expect(items.map((i) => i.n)).toEqual([2, 1, 0, 0, 0, 1]);
  });

  it('backtest: the numbers of the simulated results', () => {
    expect(calibrationOf(backtest).items.map((i) => [i.n, i.wins, i.winRate])).toEqual([
      [53, 24, 0.453],
      [91, 46, 0.505],
      [136, 76, 0.559],
      [22, 18, null],
      [0, 0, null],
      [0, 0, null],
    ]);
  });
});

describe('equity curve', () => {
  it('has one point for each valid result, in the order they closed, ending at the net R of the overview', () => {
    for (const records of [forward, backtest]) {
      const { items } = equityOf(records);
      expect(items).toHaveLength(validOf(records).length);
      const times = items.map((p) => Date.parse(p.t));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(items.at(-1)?.netR).toBe(summarize(rowsOf(records)).netR);
    }
  });

  it('has a deepest fall from the highest point that equals the max drawdown of the overview', () => {
    for (const records of [forward, backtest]) {
      let peak = 0;
      let fall = 0;
      for (const point of equityOf(records).items) {
        peak = Math.max(peak, point.netR);
        fall = Math.max(fall, peak - point.netR);
      }
      expect(fall).toBeCloseTo(summarize(rowsOf(records)).maxDrawdownR, 1);
    }
  });

  it('adds each result to the one before (net R of the result = the step)', () => {
    const items = equityOf(forward).items;
    const valid = validOf(forward)
      .map((r) => r.row)
      .sort((a, b) => Date.parse(a.closedAt ?? '') - Date.parse(b.closedAt ?? ''));
    items.forEach((point, i) => {
      const step = point.netR - (items[i - 1]?.netR ?? 0);
      expect(step).toBeCloseTo(valid[i]?.realizedRNet ?? 0, 1);
    });
  });

  it('can be limited to a date range', () => {
    const from = rowsOf(backtest)[150]?.generatedAt ?? '';
    const part = equityOf(backtest, { from }).items;
    expect(part.length).toBeLessThan(302);
    expect(part[0]?.netR).toBeCloseTo(
      validOf(backtest).find((r) => r.row.generatedAt >= from)?.row.realizedRNet ?? 0,
      1,
    );
    expect(equityOf([]).items).toEqual([]);
  });

  it('puts results that closed at the same time in the order of their signal numbers', () => {
    const base = validOf(forward)[0];
    if (!base) throw new Error('fixture');
    const at = (seq: number, net: number): AnalyticsRecord => ({
      ...base,
      row: {
        ...base.row,
        seq,
        closedAt: '2026-03-02T10:00:00Z',
        realizedRNet: net,
        isWin: net > 0,
      },
    });
    // the later signal is listed first: the order of the curve must not depend on it
    expect(equityOf([at(2, 1.4), at(1, -1.05)]).items.map((p) => p.netR)).toEqual([-1.05, 0.35]);
  });
});

describe('drift', () => {
  const template = validOf(forward)[0];
  /** `count` results of a strategy, oldest first, `wins` of them above zero (the wins come first). */
  const results = (
    strategy: StrategyKey,
    count: number,
    wins: number,
    start = 0,
  ): AnalyticsRecord[] =>
    Array.from({ length: count }, (_, i) => {
      if (!template) throw new Error('fixture');
      const win = i + start < wins;
      return {
        ...template,
        row: {
          ...template.row,
          seq: 5000 + i,
          strategyKey: strategy,
          isWin: win,
          result: win ? 'WIN' : 'LOSS',
          realizedRNet: win ? 1.4 : -1.05,
          closedAt: new Date(Date.parse('2026-01-01T10:00:00Z') + i * 3_600_000).toISOString(),
        },
      };
    });
  const evidence = { trend_pullback: [0.484, 0.617] as const };

  it('forward: every strategy has fewer than 30 results, so the status says insufficient data and there is no rate', () => {
    const { items } = driftOf(forward, {
      trend_pullback: [0.484, 0.617],
      squeeze_retest: [0.426, 0.663],
    });
    expect(items.map((i) => [i.strategy, i.n, i.rollingWinRate, i.status])).toEqual([
      ['trend_pullback', 24, null, 'INSUFFICIENT_DATA'],
      ['sweep_reversal', 11, null, 'INSUFFICIENT_DATA'],
      ['squeeze_retest', 4, null, 'INSUFFICIENT_DATA'],
    ]);
    expect(items.every((i) => i.window === DRIFT_WINDOW)).toBe(true);
    expect(items[0]?.evidenceCi95).toEqual([0.484, 0.617]);
    expect(items[1]?.evidenceCi95).toBeNull();
  });

  it('has no rate at 29 results and a rate at 30', () => {
    expect(driftOf(results('trend_pullback', 29, 15), evidence).items[0]).toMatchObject({
      n: 29,
      rollingWinRate: null,
      status: 'INSUFFICIENT_DATA',
    });
    expect(driftOf(results('trend_pullback', 30, 16), evidence).items[0]).toMatchObject({
      n: 30,
      rollingWinRate: 0.533,
      status: 'WITHIN_RANGE',
    });
  });

  it('is below the range under the interval, above it over the interval, and within it on the edge', () => {
    const status = (wins: number) =>
      driftOf(results('trend_pullback', 40, wins), evidence).items[0]?.status;
    expect(status(19)).toBe('BELOW_RANGE'); // 0.475 < 0.484
    expect(status(20)).toBe('WITHIN_RANGE'); // 0.500
    expect(status(24)).toBe('WITHIN_RANGE'); // 0.600
    expect(status(25)).toBe('ABOVE_RANGE'); // 0.625 > 0.617
    // exactly on the lower edge counts as within
    expect(
      driftOf(results('trend_pullback', 40, 20), { trend_pullback: [0.5, 0.617] }).items[0]?.status,
    ).toBe('WITHIN_RANGE');
    expect(
      driftOf(results('trend_pullback', 40, 24), { trend_pullback: [0.484, 0.6] }).items[0]?.status,
    ).toBe('WITHIN_RANGE');
  });

  it('looks only at the last 50 results', () => {
    // 60 results: the first 10 are wins that fall out of the window, the last 50 have 20 wins
    const records = results('trend_pullback', 60, 30);
    const last50 = records.slice(10);
    const wins = last50.filter((r) => r.row.isWin === true).length;
    const item = driftOf(records, evidence).items[0];
    expect(item?.n).toBe(50);
    expect(item?.rollingWinRate).toBe(wins / 50);
  });

  it('leaves out a strategy that has 30 results but nothing to compare with', () => {
    expect(driftOf(results('sweep_reversal', 35, 17), evidence).items).toEqual([]);
    // below 30 it is still listed, as insufficient data
    expect(driftOf(results('sweep_reversal', 10, 5), evidence).items[0]).toMatchObject({
      strategy: 'sweep_reversal',
      evidenceCi95: null,
      status: 'INSUFFICIENT_DATA',
    });
  });
});

describe('news impact', () => {
  const { items } = newsImpactOf();

  it('has a row for each topic and impact level of the table, topics in their order, HIGH first', () => {
    expect(items).toHaveLength(17);
    expect(items[0]).toMatchObject({ topic: 'FED_RATES', impact: 'HIGH' });
    expect(items[1]).toMatchObject({ topic: 'FED_RATES', impact: 'MEDIUM' });
    const war = items.filter((i) => i.topic === 'GEOPOLITICS_WAR').map((i) => i.impact);
    expect(war).toEqual(['HIGH', 'MEDIUM', 'LOW']);
  });

  it('shows a share, an interval and a lift only from 30 headlines, and marks every sample under 100', () => {
    for (const item of items) {
      const tag = `${item.topic} ${item.impact}`;
      expect(item.movedShare === null, tag).toBe(item.n < 30);
      expect(item.movedCi95 === null, tag).toBe(item.n < 30);
      expect(item.lift === null, tag).toBe(item.n < 30);
      expect(item.lowSample, tag).toBe(item.n < 100);
      expect(item.baselineShare).toBe(NEWS_BASELINE_SHARE);
    }
    expect(items.filter((i) => i.n < 30).map((i) => `${i.topic} ${i.impact}`)).toEqual([
      'CENTRAL_BANK_GOLD HIGH',
      'RISK_OFF HIGH',
    ]);
  });

  it('computes the share, the interval and the lift (checked by hand: 61 of 142 is 43.0%, lift 2.26)', () => {
    const fed = items[0];
    expect(fed?.movedShare).toBe(0.43);
    expect(fed?.movedCi95).toEqual(wilson(61, 142));
    expect(fed?.lift).toBe(2.26);
    expect(fed?.moved).toBe(61);
  });
});
