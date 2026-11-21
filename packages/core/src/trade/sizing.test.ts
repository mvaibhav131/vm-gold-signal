import { describe, expect, it } from 'vitest';

import { LOT_STEP, OUNCES_PER_LOT, breakEvenWinRate, sizePosition } from './sizing';

// a BUY at 4000 with the stop 5 below it and the targets 1R and 2R above it
const PLAN = { entry: 4000, tp1: 4005, tp2: 4010 as number | null, riskDistance: 5 };
const ACCOUNT = { balanceUsd: 10_000, riskPct: 0.5 };

describe('sizePosition', () => {
  it('risks the same dollars whatever the stop: lots = budget / (stop x 100 oz)', () => {
    // $50 budget, a 5 dollar stop costs $500 per lot: 0.10 lot
    expect(sizePosition(PLAN, ACCOUNT)).toMatchObject({
      budgetUsd: 50,
      lots: 0.1,
      ounces: 10,
      riskUsd: 50,
      tp1Usd: 50,
      tp2Usd: 100,
      tp1R: 1,
      tp2R: 2,
      tooSmall: false,
    });
    // a stop three times as wide gets a third of the position and loses the same $50 (rounded down)
    const wide = sizePosition({ ...PLAN, riskDistance: 15 }, ACCOUNT);
    expect(wide.lots).toBe(0.03);
    expect(wide.riskUsd).toBe(45);
  });

  it('rounds the lots down, never up, so the stop never costs more than the budget', () => {
    for (const distance of [3.7, 4.2, 6.1, 11.9, 17.3, 24.9]) {
      const size = sizePosition({ ...PLAN, riskDistance: distance }, ACCOUNT);
      expect(size.riskUsd).toBeLessThanOrEqual(size.budgetUsd);
      // and one more step would have gone over it
      expect((size.lots + LOT_STEP) * OUNCES_PER_LOT * distance).toBeGreaterThan(size.budgetUsd);
    }
  });

  it('does not lose a step to floating point when the size fits exactly', () => {
    // $30 over a $10 stop at 100 oz is exactly 0.03 lot (0.03 / 0.01 is 2.9999999999999996 in floating point)
    expect(
      sizePosition({ ...PLAN, riskDistance: 10 }, { balanceUsd: 6000, riskPct: 0.5 }).lots,
    ).toBe(0.03);
  });

  it('says so when even the smallest lot is too much for the budget', () => {
    // $50 budget, a $60 stop: 0.01 lot would lose $60
    const size = sizePosition({ ...PLAN, riskDistance: 60 }, ACCOUNT);
    expect(size).toMatchObject({ lots: 0, ounces: 0, riskUsd: 0, tp1Usd: 0, tooSmall: true });
  });

  it('has no second target for a plan that has none, and prices the spread at the size', () => {
    const single = sizePosition({ ...PLAN, tp2: null }, ACCOUNT, 0.2);
    expect(single).toMatchObject({ tp2Usd: null, tp2R: null, spreadUsd: 2 });
  });

  it('works for a SELL: the distances are absolute', () => {
    const sell = sizePosition({ entry: 4000, tp1: 3995, tp2: 3990, riskDistance: 5 }, ACCOUNT);
    expect(sell).toMatchObject({ lots: 0.1, tp1Usd: 50, tp2Usd: 100, tp1R: 1, tp2R: 2 });
  });

  it('scales with the balance and the risk percent', () => {
    expect(sizePosition(PLAN, { balanceUsd: 50_000, riskPct: 1 }).lots).toBe(1);
    expect(sizePosition(PLAN, { balanceUsd: 1_000, riskPct: 0.5 }).lots).toBe(0.01);
  });

  it('refuses numbers that are not a trade', () => {
    for (const account of [
      { balanceUsd: 0, riskPct: 0.5 },
      { balanceUsd: -1, riskPct: 0.5 },
      { balanceUsd: Number.NaN, riskPct: 0.5 },
      { balanceUsd: 10_000, riskPct: 0 },
      { balanceUsd: 10_000, riskPct: 101 },
    ]) {
      expect(() => sizePosition(PLAN, account)).toThrow(RangeError);
    }
    expect(() => sizePosition({ ...PLAN, riskDistance: 0 }, ACCOUNT)).toThrow(RangeError);
    expect(() => sizePosition(PLAN, ACCOUNT, -0.1)).toThrow(RangeError);
  });
});

describe('breakEvenWinRate', () => {
  it('is 50 percent for 1:1 and a third for 1:2 when there is no cost', () => {
    expect(breakEvenWinRate(1)).toBe(0.5);
    expect(breakEvenWinRate(2)).toBeCloseTo(1 / 3, 12);
  });

  it('rises with the cost of the trade in R', () => {
    // 0.1R of cost on a 1:1 trade: (1.1) / 2
    expect(breakEvenWinRate(1, 0.1)).toBeCloseTo(0.55, 12);
    expect(breakEvenWinRate(2, 0.1)).toBeGreaterThan(breakEvenWinRate(2));
  });

  it('refuses a reward that is not above zero and a negative cost', () => {
    expect(() => breakEvenWinRate(0)).toThrow(RangeError);
    expect(() => breakEvenWinRate(1, -0.1)).toThrow(RangeError);
  });
});
