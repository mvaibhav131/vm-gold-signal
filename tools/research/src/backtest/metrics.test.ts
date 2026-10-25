import { describe, expect, it } from 'vitest';

import { statsOf, tallyOf } from './metrics';
import { outcome, signalOf } from './test-data';
import type { TradeResult } from './types';

describe('statsOf', () => {
  it('has the mean net R, the profit factor, the net R and the drawdown of the counted trades', () => {
    const stats = statsOf([
      outcome(1, { closedAt: 1 }),
      outcome(-1, { closedAt: 2 }),
      outcome(-1, { closedAt: 3 }),
      outcome(2, { closedAt: 4 }),
    ]);
    expect(stats).toMatchObject({
      n: 4,
      winners: 2,
      expectancyR: 0.25,
      netR: 1,
      profitFactor: 1.5,
      maxDrawdownR: 2,
      winRate: null,
      ci95: null,
    });
  });

  it('orders the drawdown by the time the trades closed, not the order they are given', () => {
    const late = outcome(-1, { closedAt: 9 });
    const early = outcome(2, { closedAt: 1 });
    expect(statsOf([late, early]).maxDrawdownR).toBe(1);
    expect(statsOf([late, outcome(-1, { closedAt: 5 }), early]).maxDrawdownR).toBe(2);
  });

  it('has no expectancy and no profit factor without trades, and no profit factor without a loss', () => {
    expect(statsOf([])).toMatchObject({ n: 0, expectancyR: null, profitFactor: null, netR: 0 });
    expect(statsOf([outcome(1)]).profitFactor).toBeNull();
  });

  it('keeps the trades that do not count out of every rate, and counts the data invalid ones', () => {
    const invalid = outcome(0, {
      result: 'DATA_INVALID',
      countsInStats: false,
      realizedRNet: null,
    });
    const stats = statsOf([outcome(1), invalid, invalid]);
    expect(stats).toMatchObject({ n: 1, dataInvalid: 2, expectancyR: 1 });
  });

  it('counts the ambiguous trades and the time exits', () => {
    const stats = statsOf([
      outcome(-1, { ambiguous: true }),
      outcome(0.2, { result: 'TIME_EXIT' }),
    ]);
    expect(stats).toMatchObject({ ambiguous: 1, timeExits: 1 });
  });

  it('shows the win rate with its interval and the TP1 rate from 30 trades, and not from 29', () => {
    const trades = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        outcome(i % 2 === 0 ? 1 : -1, { tp1Hit: i % 2 === 0 }),
      );
    expect(statsOf(trades(29)).winRate).toBeNull();
    const stats = statsOf(trades(30));
    expect(stats.winRate).toBe(0.5);
    expect(stats.tp1Rate).toBe(0.5);
    expect(stats.ci95?.[0]).toBeGreaterThan(0.3);
    expect(stats.ci95?.[1]).toBeLessThan(0.7);
  });

  it('rounds the expectancy to three decimals', () => {
    expect(statsOf([outcome(1), outcome(0), outcome(0)]).expectancyR).toBe(0.333);
  });
});

describe('tallyOf', () => {
  it('counts what became of the signals under a scenario: closed, skipped by reason, unfinished', () => {
    const skipped: TradeResult = { kind: 'SKIPPED', reason: 'BEYOND_MAX_VALID_ENTRY' };
    const unfinished: TradeResult = { kind: 'UNFINISHED', fillAt: 0 };
    const signals = [
      signalOf([1, skipped, 1]),
      signalOf([-1, skipped, unfinished]),
      signalOf([unfinished, 1, 1]),
    ];
    const a = tallyOf(signals, 'A');
    expect(a).toMatchObject({ signals: 3, unfinished: 1, skipped: {} });
    expect(a.stats.n).toBe(2);
    const b = tallyOf(signals, 'B');
    expect(b.skipped).toEqual({ BEYOND_MAX_VALID_ENTRY: 2 });
    expect(b.stats.n).toBe(1);
    expect(tallyOf(signals, 'C').unfinished).toBe(1);
  });
});
