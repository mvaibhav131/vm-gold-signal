import { describe, expect, it } from 'vitest';

import { addResult, EMPTY_COUNTS } from '../stats/counts';
import { bucketKeys } from '../stats/evidence';
import { ALL_STRATEGIES, causeChangeDelta, closedDelta, createdDelta, monthOf } from './delta';
import { SIGNAL, closed, record } from './test-data';

describe('monthOf', () => {
  it('is the first day of the UTC month of the decision', () => {
    expect(monthOf(Date.UTC(2026, 9, 23, 11, 30))).toBe('2026-10-01');
    expect(monthOf(Date.UTC(2026, 9, 31, 23, 59, 59, 999))).toBe('2026-10-01');
    expect(monthOf(Date.UTC(2026, 10, 1, 0, 0, 0))).toBe('2026-11-01');
    expect(monthOf(Date.UTC(2026, 11, 31, 23, 0, 0))).toBe('2026-12-01');
    expect(monthOf(Date.UTC(2027, 0, 1, 0, 0, 0))).toBe('2027-01-01');
  });
});

describe('createdDelta', () => {
  it('adds one generated signal to the month of the strategy and to the month of all strategies', () => {
    const delta = createdDelta(SIGNAL);
    expect(delta.buckets).toEqual([]);
    expect(delta.groups).toEqual([]);
    expect(delta.causes).toEqual([]);
    expect(delta.monthly.map((row) => [row.month, row.strategyKey, row.generated])).toEqual([
      ['2026-10-01', ALL_STRATEGIES, 1],
      ['2026-10-01', 'trend_pullback', 1],
    ]);
    expect(delta.monthly[0]).toMatchObject({ resolvedValid: 0, netR: 0, cancelled: 0 });
  });
});

describe('closedDelta of a counted result', () => {
  it('adds a win to its five buckets, with the counts of the trade', () => {
    const delta = closedDelta(closed('WIN', 2));
    const keys = bucketKeys({
      strategyKey: SIGNAL.strategyKey,
      strategyVersion: SIGNAL.version,
      side: SIGNAL.side,
      session: SIGNAL.session,
      regime: SIGNAL.regime,
      volBucket: SIGNAL.volBucket,
    });
    expect(delta.buckets.map((row) => [row.scope, row.level, row.bucketKey])).toEqual(
      keys.map((key, level) => ['FORWARD', level, key]),
    );
    expect(delta.buckets[0]).toEqual({
      scope: 'FORWARD',
      level: 0,
      bucketKey: keys[0],
      ...addResult(EMPTY_COUNTS, record('WIN', 2)),
    });
    expect(delta.buckets[0]).toMatchObject({
      n: 1,
      wins: 1,
      winners: 1,
      tp1Hits: 1,
      tp2Hits: 1,
      sumR: 2,
      sumWinR: 2,
      sumLossR: 0,
    });
  });

  it('adds it to the month, the state of each group and the cause of its review', () => {
    const delta = closedDelta(closed('LOSS', -1.04, 'NO_FOLLOW_THROUGH'));
    expect(delta.monthly).toHaveLength(2);
    for (const row of delta.monthly) {
      expect(row).toMatchObject({
        generated: 0,
        resolvedValid: 1,
        wins: 0,
        winners: 0,
        losses: 1,
        netR: -1.04,
        sumWinR: 0,
        sumLossR: -1.04,
      });
    }
    expect(delta.groups).toHaveLength(7);
    expect(delta.groups.find((row) => row.groupKey === 'trigger')).toEqual({
      scope: 'FORWARD',
      strategyKey: 'trend_pullback',
      groupKey: 'trigger',
      state: 'WEAK',
      n: 1,
      wins: 0,
      sumR: -1.04,
    });
    expect(delta.causes).toEqual([
      {
        month: '2026-10-01',
        strategyKey: 'trend_pullback',
        causeCode: 'NO_FOLLOW_THROUGH',
        n: 1,
        sumR: -1.04,
      },
    ]);
  });

  it('counts a winner by the sign of its net R, whatever the result: a time exit above zero is one, a partial win at zero is not', () => {
    const exit = closedDelta(closed('TIME_EXIT', 0.2));
    expect(exit.monthly[0]).toMatchObject({ timeExits: 1, winners: 1, wins: 0, sumWinR: 0.2 });
    expect(exit.groups[0]).toMatchObject({ wins: 1, sumR: 0.2 });
    const partial = closedDelta(closed('PARTIAL_WIN', 0, 'NORMAL_LOSS'));
    expect(partial.monthly[0]).toMatchObject({ partials: 1, winners: 0, netR: 0, sumWinR: 0 });
    expect(partial.groups[0]).toMatchObject({ n: 1, wins: 0, sumR: 0 });
    expect(partial.buckets[0]).toMatchObject({ partials: 1, winners: 0, tp1Hits: 1, tp2Hits: 0 });
  });

  it('files a closing in the month of the decision, not of the close', () => {
    const late = closedDelta({
      ...closed('WIN', 1),
      generatedAt: Date.UTC(2026, 9, 31, 23, 50),
      outcome: record('WIN', 1, { closedAt: Date.UTC(2026, 10, 1, 1, 0) }),
    });
    expect(late.monthly.map((row) => row.month)).toEqual(['2026-10-01', '2026-10-01']);
  });

  it('counts a state of a group once even if the signal lists it twice, and keeps a state that is NA', () => {
    const delta = closedDelta(
      closed('WIN', 1, null, {
        groups: [
          { key: 'trend', state: 'STRONG' },
          { key: 'trend', state: 'STRONG' },
          { key: 'reward', state: 'NA' },
        ],
      }),
    );
    expect(delta.groups.map((row) => [row.groupKey, row.state, row.n])).toEqual([
      ['trend', 'STRONG', 1],
      ['reward', 'NA', 1],
    ]);
  });

  it('carries the scope to the buckets and the groups', () => {
    const delta = closedDelta(closed('WIN', 1), 'BACKTEST_OOS');
    expect(new Set(delta.buckets.map((row) => row.scope))).toEqual(new Set(['BACKTEST_OOS']));
    expect(new Set(delta.groups.map((row) => row.scope))).toEqual(new Set(['BACKTEST_OOS']));
  });

  it('refuses a counted result without its net R', () => {
    expect(() => closedDelta(closed('WIN', null))).toThrow(RangeError);
  });
});

describe('closedDelta of a result that is not counted', () => {
  it('adds a cancelled signal to the month only', () => {
    const delta = closedDelta(closed('CANCELLED', null));
    expect(delta.buckets).toEqual([]);
    expect(delta.groups).toEqual([]);
    expect(delta.causes).toEqual([]);
    expect(
      delta.monthly.map((row) => [
        row.strategyKey,
        row.cancelled,
        row.dataInvalid,
        row.resolvedValid,
      ]),
    ).toEqual([
      [ALL_STRATEGIES, 1, 0, 0],
      ['trend_pullback', 1, 0, 0],
    ]);
  });

  it('adds a data-invalid signal to the month only', () => {
    const delta = closedDelta(closed('DATA_INVALID', null));
    expect(delta.buckets).toEqual([]);
    expect(delta.monthly[0]).toMatchObject({ dataInvalid: 1, cancelled: 0, resolvedValid: 0 });
  });

  it('adds nothing for an outcome that is neither counted nor cancelled nor invalid', () => {
    const odd = { ...closed('WIN', 1), outcome: record('WIN', 1, { countsInStats: false }) };
    expect(closedDelta(odd)).toEqual({ buckets: [], monthly: [], groups: [], causes: [] });
  });
});

describe('causeChangeDelta', () => {
  const trade = { strategyKey: SIGNAL.strategyKey, generatedAt: SIGNAL.generatedAt, netR: -1.04 };

  it('moves the result from the old cause to the new one', () => {
    expect(causeChangeDelta(trade, 'NO_FOLLOW_THROUGH', 'STOP_HUNT_REVERSAL').causes).toEqual([
      {
        month: '2026-10-01',
        strategyKey: 'trend_pullback',
        causeCode: 'NO_FOLLOW_THROUGH',
        n: -1,
        sumR: 1.04,
      },
      {
        month: '2026-10-01',
        strategyKey: 'trend_pullback',
        causeCode: 'STOP_HUNT_REVERSAL',
        n: 1,
        sumR: -1.04,
      },
    ]);
  });

  it('changes nothing when the cause stays', () => {
    expect(causeChangeDelta(trade, 'NORMAL_LOSS', 'NORMAL_LOSS').causes).toEqual([]);
  });

  it('only adds when there was no cause, and only takes away when there is none now', () => {
    expect(causeChangeDelta(trade, null, 'NORMAL_LOSS').causes.map((row) => row.n)).toEqual([1]);
    expect(causeChangeDelta(trade, 'NORMAL_LOSS', null).causes.map((row) => row.n)).toEqual([-1]);
    expect(causeChangeDelta(trade, null, null).causes).toEqual([]);
  });
});
