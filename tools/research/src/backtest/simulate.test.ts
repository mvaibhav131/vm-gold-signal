import { COST_SCENARIOS } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { BAR_GAP_MS, lowerBound, simulateTrade } from './simulate';
import { MINUTE, bar, planAt, quiet, spreadAt } from './test-data';
import type { TradeResult } from './types';

const A = COST_SCENARIOS.A;

const closed = (result: TradeResult) => {
  if (result.kind !== 'CLOSED') throw new Error(`not closed: ${result.kind}`);
  return result.outcome;
};

describe('lowerBound', () => {
  const bars = [bar(0, 1, 1, 1, 1), bar(2, 1, 1, 1, 1), bar(5, 1, 1, 1, 1)];
  it('is the first bar at or after the time, or the end', () => {
    expect(lowerBound(bars, bars[1]?.ts ?? 0)).toBe(1);
    expect(lowerBound(bars, (bars[1]?.ts ?? 0) + 1)).toBe(2);
    expect(lowerBound(bars, 0)).toBe(0);
    expect(lowerBound(bars, (bars[2]?.ts ?? 0) + 1)).toBe(3);
    expect(lowerBound(bars, bars[0]?.ts ?? 0, 1)).toBe(1);
  });
});

describe('simulateTrade: scenario A, a BUY', () => {
  const plan = planAt('BUY');

  it('plans as the tests expect: the fill is 1000.17, R is 4.17, the targets are 1 and 2 R', () => {
    expect([plan.entry, plan.riskDistance, plan.tp1, plan.tp2]).toEqual([
      1000.17, 4.17, 1004.34, 1008.51,
    ]);
  });

  it('fills at the confirming quote and wins at TP2 after TP1: 1.5 R for the half and the half', () => {
    const bars = [
      bar(0, 1000, 1001, 999.5, 1000.5),
      bar(1, 1001, 1005, 1001, 1004),
      bar(2, 1004, 1009, 1003, 1008),
    ];
    const result = simulateTrade(plan, bars, spreadAt, A);
    expect(result).toMatchObject({ kind: 'CLOSED', fillAt: plan.decidedAt });
    expect(closed(result)).toMatchObject({
      result: 'WIN',
      tp1Hit: true,
      tp2Hit: true,
      ambiguous: false,
    });
    expect(closed(result).realizedRGross).toBeCloseTo(1.5, 2);
  });

  it('is a loss of one R when the bid reaches the stop', () => {
    const bars = [bar(0, 1000, 1001, 999.5, 1000.5), bar(1, 1000.5, 1001, 995.9, 996)];
    const outcome = closed(simulateTrade(plan, bars, spreadAt, A));
    expect(outcome).toMatchObject({ result: 'LOSS', exitReason: 'STOP', tp1Hit: false });
    expect(outcome.realizedRGross).toBeCloseTo(-1, 2);
  });

  it('takes the stop when the stop and the target are in the same bar, and says it was ambiguous', () => {
    const bars = [bar(0, 1000, 1001, 999.5, 1000.5), bar(1, 1000.5, 1005, 995, 1000)];
    const outcome = closed(simulateTrade(plan, bars, spreadAt, A));
    expect(outcome).toMatchObject({ result: 'LOSS', ambiguous: true });
  });

  it('can be hit by the first bar of the decision minute itself', () => {
    const outcome = closed(simulateTrade(plan, [bar(0, 1000, 1000.5, 995, 996)], spreadAt, A));
    expect(outcome.result).toBe('LOSS');
  });

  it('closes at the time stop after two hours of nothing, and counts it', () => {
    const bars = [bar(0, 1000, 1000.2, 999.8, 1000), ...quiet(1, 130, 1000)];
    const outcome = closed(simulateTrade(plan, bars, spreadAt, A));
    expect(outcome).toMatchObject({
      result: 'TIME_EXIT',
      countsInStats: true,
      exitReason: 'TIME_STOP',
    });
    expect(outcome.closedAt).toBe(plan.timeStopAt);
  });

  it('leaves a trade that the data does not finish, and says so', () => {
    const result = simulateTrade(
      plan,
      [bar(0, 1000, 1000.2, 999.8, 1000), ...quiet(1, 30, 1000)],
      spreadAt,
      A,
    );
    expect(result).toEqual({ kind: 'UNFINISHED', fillAt: plan.decidedAt });
  });

  it('closes as data invalid after five missing minutes, and not after four', () => {
    const base = bar(0, 1000, 1000.2, 999.8, 1000);
    const four = simulateTrade(plan, [base, bar(5, 1000, 1000.2, 999.8, 1000)], spreadAt, A);
    expect(four.kind).toBe('UNFINISHED');
    const six = simulateTrade(plan, [base, bar(6, 1000, 1000.2, 999.8, 1000)], spreadAt, A);
    expect(closed(six)).toMatchObject({ result: 'DATA_INVALID', countsInStats: false });
    expect(BAR_GAP_MS).toBe(5 * MINUTE);
  });

  it('decides on the first bar after a missing minute, inside the entry validity', () => {
    const result = simulateTrade(
      plan,
      [bar(1, 1000, 1000.2, 999.8, 1000), bar(2, 1000, 1000.2, 999.8, 1000)],
      spreadAt,
      A,
    );
    expect(result).toMatchObject({ kind: 'UNFINISHED', fillAt: plan.decidedAt + MINUTE });
  });

  it('has no quote when the bars end before it, or start after the entry could be valid', () => {
    expect(simulateTrade(plan, [], spreadAt, A)).toEqual({ kind: 'SKIPPED', reason: 'NO_TICK' });
    const late = simulateTrade(plan, [bar(4, 1000, 1001, 999, 1000)], spreadAt, A);
    expect(late).toEqual({ kind: 'SKIPPED', reason: 'ENTRY_EXPIRED' });
  });
});

describe('simulateTrade: a SELL is followed on the ask', () => {
  const plan = planAt('SELL');

  it('is stopped by the spread: a bid high of 1003.9 is an ask of 1004.02, through the stop at 1004', () => {
    const bars = [bar(0, 1000, 1000.5, 999.5, 1000), bar(1, 1000, 1003.9, 999.8, 1001)];
    expect(closed(simulateTrade(plan, bars, spreadAt, A)).result).toBe('LOSS');
    const buy = simulateTrade(planAt('BUY'), bars, spreadAt, A);
    expect(buy.kind).toBe('UNFINISHED');
  });

  it('wins at TP2 when the ask falls to it, the mirror of the BUY', () => {
    // fill 999.95, R 4.05; TP1 995.9, TP2 991.85 on the ask, that is a bid of 991.73
    const bars = [
      bar(0, 1000, 1000.2, 999.5, 999.6),
      bar(1, 999.6, 999.7, 995.7, 996),
      bar(2, 996, 996.1, 991.5, 992),
    ];
    const outcome = closed(simulateTrade(plan, bars, spreadAt, A));
    expect(outcome).toMatchObject({ result: 'WIN', tp1Hit: true, tp2Hit: true });
    expect(outcome.realizedRGross).toBeCloseTo(1.5, 2);
  });
});

describe('simulateTrade: the cost scenarios', () => {
  const plan = planAt('BUY');
  const stopped = [bar(0, 1000, 1000.6, 999.5, 1000), bar(1, 1000, 1000.5, 995.9, 996)];

  it('B fills 0.25 worse and loses more than one R: the unit stays the R of the signal', () => {
    const outcome = closed(simulateTrade(plan, stopped, spreadAt, COST_SCENARIOS.B));
    expect(outcome.result).toBe('LOSS');
    expect(outcome.realizedRGross).toBeCloseTo(-(4.17 + 0.25) / 4.17, 2);
  });

  it('B is skipped when the slippage takes the fill beyond the maximum valid entry', () => {
    const wide = { ...plan, maxValidEntry: plan.entry + 0.1 };
    expect(simulateTrade(wide, stopped, spreadAt, COST_SCENARIOS.B)).toEqual({
      kind: 'SKIPPED',
      reason: 'BEYOND_MAX_VALID_ENTRY',
    });
  });

  it('C orders 20 s into the minute and meets a third of the way to the high, plus the spread and the slippage', () => {
    const result = simulateTrade(plan, stopped, spreadAt, COST_SCENARIOS.C);
    // 1000 + (1000.6 - 1000) / 3 = 1000.2, ask 1000.32, fill 1000.37
    expect(result).toMatchObject({ kind: 'CLOSED', fillAt: plan.decidedAt + 20_000 });
    expect(closed(result).realizedRGross).toBeCloseTo((996 - 1000.37) / 4.17, 2);
  });

  it('C starts to follow the trade at the next bar: the rest of the minute of the fill is not used', () => {
    const lowInFillMinute = [
      bar(0, 1000, 1000.6, 995, 1000.2),
      bar(1, 1000.2, 1001, 999, 1000.5),
      ...quiet(2, 5, 1000.5),
    ];
    expect(simulateTrade(plan, lowInFillMinute, spreadAt, COST_SCENARIOS.A).kind).toBe('CLOSED');
    expect(simulateTrade(plan, lowInFillMinute, spreadAt, COST_SCENARIOS.C).kind).toBe(
      'UNFINISHED',
    );
  });

  it('C is skipped when the price of the delayed minute has run beyond the maximum valid entry', () => {
    const fast = [bar(0, 1000, 1003, 999.5, 1002), bar(1, 1002, 1003, 1001, 1002)];
    expect(simulateTrade(plan, fast, spreadAt, COST_SCENARIOS.C)).toEqual({
      kind: 'SKIPPED',
      reason: 'BEYOND_MAX_VALID_ENTRY',
    });
  });

  it('does not fill after the entry has expired: a delay of 181 s', () => {
    expect(
      simulateTrade(plan, stopped, spreadAt, { simSlippageUsd: 0.05, execDelaySec: 181 }),
    ).toEqual({
      kind: 'SKIPPED',
      reason: 'ENTRY_EXPIRED',
    });
  });

  it('meets the open of a bar when the delay is a whole number of minutes', () => {
    const bars = [bar(0, 1000, 1001, 999.5, 1000.1), bar(1, 1000.1, 1000.5, 995.9, 996)];
    const result = simulateTrade(plan, bars, spreadAt, { simSlippageUsd: 0.05, execDelaySec: 60 });
    // the open of the second bar: 1000.1 + 0.12 + 0.05, and the bar goes on to hit the stop
    expect(result).toMatchObject({ kind: 'CLOSED', fillAt: plan.decidedAt + 60_000 });
    expect(closed(result).realizedRGross).toBeCloseTo((996 - 1000.27) / 4.17, 2);
  });

  it('settles a delayed SELL against the trade too: towards the low of the minute', () => {
    const sell = planAt('SELL');
    const bars = [bar(0, 1000, 1000.2, 999.4, 999.6), bar(1, 999.6, 1004.2, 999.5, 1004)];
    const result = simulateTrade(sell, bars, spreadAt, COST_SCENARIOS.C);
    // bid 1000 - (1000 - 999.4) / 3 = 999.8, fill 999.75; the next bar's ask high 1004.32 is through the stop
    expect(closed(result).realizedRGross).toBeCloseTo((999.75 - 1004) / 4.05, 2);
  });
});
