import { describe, expect, it } from 'vitest';

import { EMPTY_COUNTS, countResults } from './counts';
import { currentStreak, equityCurve, maxDrawdown, rateStats, summarizeResults } from './metrics';
import { T0, bucket, record, recordsOf, sample40 } from './test-data';
import { wilson } from './wilson';

describe('rateStats: no percentage below 30 trades (rule C6)', () => {
  it('shows nothing at 29 and everything at 30', () => {
    const at29 = rateStats(bucket(15, 14));
    expect(at29).toMatchObject({
      n: 29,
      sampleLabel: 'INSUFFICIENT',
      winRate: null,
      ci95: null,
      tp1Rate: null,
      tp2Rate: null,
    });
    const at30 = rateStats(bucket(15, 15));
    expect(at30.sampleLabel).toBe('LOW_SAMPLE');
    expect(at30).toMatchObject({ n: 30, winRate: 0.5 });
    expect(at30.ci95).toEqual(wilson(15, 30));
    expect(at30.tp1Rate).toBe(0.5);
    expect(at30.tp2Rate).toBe(0.5);
  });

  it('labels a low sample up to 99 and a normal one from 100', () => {
    expect(rateStats(bucket(50, 49)).sampleLabel).toBe('LOW_SAMPLE');
    expect(rateStats(bucket(50, 50)).sampleLabel).toBe('NORMAL');
  });

  it('shows the expectancy and the profit factor at any size, for they are not percentages', () => {
    const small = rateStats(bucket(2, 1));
    expect(small).toMatchObject({ n: 3, expectancyR: 0.67, profitFactor: 3, winRate: null });
  });

  it('shows the expectancy from the first trade on', () => {
    expect(rateStats(bucket(1, 0))).toMatchObject({ n: 1, expectancyR: 1.5, winRate: null });
  });

  it('has nothing without a trade', () => {
    expect(rateStats(EMPTY_COUNTS)).toEqual({
      n: 0,
      winners: 0,
      sampleLabel: 'INSUFFICIENT',
      winRate: null,
      ci95: null,
      expectancyR: null,
      profitFactor: null,
      tp1Rate: null,
      tp2Rate: null,
    });
  });
});

describe('expectancy and profit factor (checked by hand)', () => {
  const stats = (nets: number[]) =>
    rateStats(countResults(recordsOf(nets.map((net) => [net > 0 ? 'WIN' : 'LOSS', net] as const))));

  it('is the mean net R, and gains over losses', () => {
    // +1.5 -1 -1 +0.5 +2 -0.5: gains 4, losses 2.5, sum 1.5 over 6 trades
    const s = stats([1.5, -1, -1, 0.5, 2, -0.5]);
    expect(s.expectancyR).toBe(0.25);
    expect(s.profitFactor).toBe(1.6);
  });

  it('has no profit factor while there is no loss, and a zero one when there is no gain', () => {
    expect(stats([1, 2, 0.5]).profitFactor).toBeNull();
    expect(stats([-1, -2]).profitFactor).toBe(0);
    expect(stats([0, 0]).profitFactor).toBeNull();
  });

  it('rounds to 2 decimals', () => {
    expect(stats([1, 1, -1]).expectancyR).toBe(0.33);
    expect(stats([1, -1, -1]).expectancyR).toBe(-0.33);
    expect(stats([5, -3]).profitFactor).toBe(1.67);
  });

  it('counts a time exit above zero as a gain and a partial win with costs by its net R', () => {
    const s = rateStats(
      countResults(
        recordsOf([
          ['TIME_EXIT', 0.4],
          ['PARTIAL_WIN', -0.02],
          ['LOSS', -1],
        ]),
      ),
    );
    expect(s.profitFactor).toBe(0.39); // 0.4 / 1.02
  });
});

describe('maxDrawdown', () => {
  it('is the deepest fall from a high point, starting from zero', () => {
    expect(maxDrawdown([])).toBe(0);
    expect(maxDrawdown([1, 1, 1])).toBe(0);
    expect(maxDrawdown([-1])).toBe(1);
    expect(maxDrawdown([-1, -1, -1])).toBe(3);
    // 1.5, 0.5, -0.5: a fall of 2 from the high of 1.5
    expect(maxDrawdown([1.5, -1, -1, 0.5])).toBe(2);
    // the second fall is deeper: 3 -> -1 is 4, the first is 1
    expect(maxDrawdown([2, 1, -1, -1, 4, -3, -2, 1])).toBe(5);
  });

  it('is the same as the largest fall found by looking at every pair of points', () => {
    let state = 99;
    const rand = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    for (let round = 0; round < 200; round += 1) {
      const nets = Array.from(
        { length: 1 + Math.floor(rand() * 40) },
        () => Math.round((rand() * 5 - 2) * 100) / 100,
      );
      const equity = [0];
      for (const net of nets) equity.push((equity.at(-1) ?? 0) + net);
      let deepest = 0;
      for (let i = 0; i < equity.length; i += 1) {
        for (let j = i + 1; j < equity.length; j += 1) {
          deepest = Math.max(deepest, (equity[i] ?? 0) - (equity[j] ?? 0));
        }
      }
      expect(maxDrawdown(nets), JSON.stringify(nets)).toBeCloseTo(deepest, 9);
    }
  });
});

describe('equityCurve', () => {
  it('has a point for each counted trade, in the order they closed, with the running total', () => {
    const list = [
      record('LOSS', -1.05, 30),
      record('WIN', 1.46, 10),
      record('CANCELLED', null, 20),
      record('PARTIAL_WIN', 0.25, 40),
      record('DATA_INVALID', null, 5),
    ];
    expect(equityCurve(list)).toEqual([
      { t: T0 + 10 * 60_000, netR: 1.46 },
      { t: T0 + 30 * 60_000, netR: 0.41 },
      { t: T0 + 40 * 60_000, netR: 0.66 },
    ]);
  });

  it('is empty without a counted trade', () => {
    expect(equityCurve([])).toEqual([]);
    expect(equityCurve([record('CANCELLED', null)])).toEqual([]);
  });

  it('keeps the order of two trades that closed together', () => {
    const list = [record('WIN', 1, 5), record('LOSS', -1, 5), record('WIN', 2, 5)];
    expect(equityCurve(list).map((point) => point.netR)).toEqual([1, 0, 2]);
  });

  it('does not change the list it was given', () => {
    const list = [record('LOSS', -1, 30), record('WIN', 1, 10)];
    equityCurve(list);
    expect(list.map((item) => item.closedAt)).toEqual([T0 + 30 * 60_000, T0 + 10 * 60_000]);
  });
});

describe('currentStreak', () => {
  it('is the run of the same kind that the newest trade ends', () => {
    expect(currentStreak([])).toBeNull();
    expect(currentStreak([record('CANCELLED', null)])).toBeNull();
    expect(
      currentStreak(
        recordsOf([
          ['WIN', 1],
          ['LOSS', -1],
          ['WIN', 1],
          ['WIN', 1],
        ]),
      ),
    ).toEqual({
      type: 'WIN',
      length: 2,
    });
    expect(
      currentStreak(
        recordsOf([
          ['WIN', 1],
          ['WIN', 1],
          ['LOSS', -1],
        ]),
      ),
    ).toEqual({
      type: 'LOSS',
      length: 1,
    });
    expect(
      currentStreak(
        recordsOf([
          ['LOSS', -1],
          ['LOSS', -1],
          ['LOSS', -1],
        ]),
      ),
    ).toEqual({
      type: 'LOSS',
      length: 3,
    });
  });

  it('counts by net R above zero: a flat trade and a partial win with costs are not wins', () => {
    expect(
      currentStreak(
        recordsOf([
          ['WIN', 1],
          ['PARTIAL_WIN', 0],
          ['TIME_EXIT', -0.1],
        ]),
      ),
    ).toEqual({
      type: 'LOSS',
      length: 2,
    });
    expect(
      currentStreak(
        recordsOf([
          ['LOSS', -1],
          ['TIME_EXIT', 0.2],
          ['PARTIAL_WIN', 0.4],
        ]),
      ),
    ).toEqual({
      type: 'WIN',
      length: 2,
    });
  });

  it('ends on a flat trade as a non-win, and the run goes back over the flat trades before it', () => {
    expect(
      currentStreak(
        recordsOf([
          ['WIN', 1],
          ['LOSS', -1],
          ['PARTIAL_WIN', 0],
        ]),
      ),
    ).toEqual({ type: 'LOSS', length: 2 });
    expect(currentStreak(recordsOf([['TIME_EXIT', 0]]))).toEqual({ type: 'LOSS', length: 1 });
  });

  it('skips the trades that do not count, and sorts by the time they closed', () => {
    const list = [
      record('WIN', 1, 30),
      record('LOSS', -1, 10),
      record('CANCELLED', null, 40),
      record('WIN', 1, 20),
    ];
    expect(currentStreak(list)).toEqual({ type: 'WIN', length: 2 });
  });
});

describe('summarizeResults, a sample checked by hand', () => {
  // Ten trades four times: gains 5.96 and losses 4.22 in each block, 20 of the 40 above zero,
  // a fall of 2 R in the first block (1.5, 0.5, -0.5) that the later blocks never beat.
  const reversed = [...sample40()].reverse();
  const overview = summarizeResults(reversed);

  it('counts the results apart and the signals that did not count', () => {
    expect(overview).toMatchObject({
      resolvedValid: 40,
      wins: 12,
      partials: 8,
      losses: 16,
      timeExits: 4,
      cancelled: 2,
      dataInvalid: 1,
      winners: 20,
    });
  });

  it('gives the rates, with the interval of the Wilson method', () => {
    expect(overview.sampleLabel).toBe('LOW_SAMPLE');
    expect(overview.winRate).toBe(0.5);
    expect(overview.ci95).toEqual([0.352, 0.648]);
    expect(overview.tp1Rate).toBe(0.5); // wins and partial wins reached TP1: 5 of 10
    expect(overview.tp2Rate).toBe(0.3); // the 3 wins of each 10
  });

  it('gives the money figures', () => {
    expect(overview.netR).toBe(6.96); // 1.74 a block
    expect(overview.expectancyR).toBe(0.17); // 6.96 / 40 = 0.174
    expect(overview.profitFactor).toBe(1.41); // 5.96 / 4.22 = 1.4123
    expect(overview.maxDrawdownR).toBe(2);
    expect(overview.avgDurationS).toBe(1842); // 18420 s a block over 10
  });

  it('ends on the loss of the newest time exit, after a partial win', () => {
    expect(overview.currentStreak).toEqual({ type: 'LOSS', length: 1 });
  });

  it('is the same whatever the order of the list', () => {
    expect(summarizeResults(sample40())).toEqual(overview);
  });

  it('is built from the counts: below 30 trades it has no percentage', () => {
    const few = summarizeResults(sample40().slice(0, 12));
    expect(few).toMatchObject({ resolvedValid: 12, winRate: null, ci95: null, tp1Rate: null });
    expect(few.expectancyR).not.toBeNull();
  });

  it('has nothing to show without a trade, and counts only what is left apart', () => {
    expect(summarizeResults([])).toMatchObject({
      resolvedValid: 0,
      netR: 0,
      expectancyR: null,
      profitFactor: null,
      maxDrawdownR: 0,
      avgDurationS: null,
      currentStreak: null,
      cancelled: 0,
      dataInvalid: 0,
    });
    expect(
      summarizeResults([record('CANCELLED', null), record('DATA_INVALID', null, 1)]),
    ).toMatchObject({ resolvedValid: 0, cancelled: 1, dataInvalid: 1, avgDurationS: null });
  });

  it('rounds the average duration to whole seconds', () => {
    const list = [
      record('WIN', 1, 0, { durationS: 100 }),
      record('LOSS', -1, 1, { durationS: 101 }),
    ];
    expect(summarizeResults(list).avgDurationS).toBe(101);
  });

  it('already shows the duration, the money and the drawdown of a single trade, rounded to 2 decimals', () => {
    const one = summarizeResults([record('LOSS', -0.456, 0, { durationS: 300 })]);
    expect(one).toMatchObject({
      resolvedValid: 1,
      avgDurationS: 300,
      netR: -0.46,
      maxDrawdownR: 0.46,
      expectancyR: -0.46,
    });
  });
});
