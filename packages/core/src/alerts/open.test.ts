import { describe, expect, it } from 'vitest';

import { openRiskR, unrealisedR, type OpenFacts } from './open';

const buy: OpenFacts = {
  side: 'BUY',
  exitProfile: 'EP1_PARTIAL',
  entry: 4017.37,
  tp1: 4023.84,
  riskDistance: 6.47,
  status: 'ACTIVE',
};
const sell: OpenFacts = { ...buy, side: 'SELL', entry: 3982.63, tp1: 3976.16 };

describe('unrealisedR', () => {
  it('is the move in favour over the risk distance, for a BUY on the bid and a SELL on the ask', () => {
    expect(unrealisedR(buy, 4017.37)).toBe(0);
    expect(unrealisedR(buy, 4023.84)).toBeCloseTo(1, 12);
    expect(unrealisedR(buy, 4010.9)).toBeCloseTo(-1, 12);
    expect(unrealisedR(sell, 3976.16)).toBeCloseTo(1, 12);
    expect(unrealisedR(sell, 3989.1)).toBeCloseTo(-1, 12);
  });

  it('counts the half closed at TP1 for an EP1 trade that hit it: 0.5 R banked plus half of the rest', () => {
    const afterTp1 = { ...buy, status: 'TP1_HIT' as const };
    expect(unrealisedR(afterTp1, 4017.37)).toBeCloseTo(0.5, 12);
    expect(unrealisedR(afterTp1, 4030.31)).toBeCloseTo(1.5, 12);
    expect(unrealisedR(afterTp1, 4023.84)).toBeCloseTo(1, 12);
    expect(unrealisedR({ ...sell, status: 'TP1_HIT' }, 3969.69)).toBeCloseTo(1.5, 12);
  });

  it('a single-target trade has no banked half', () => {
    expect(unrealisedR({ ...buy, exitProfile: 'EP2_SINGLE', status: 'TP1_HIT' }, 4017.37)).toBe(0);
  });
});

describe('openRiskR', () => {
  it('is 1 R for each signal whose stop is still at its stop-loss, and nothing after TP1', () => {
    expect(openRiskR([])).toBe(0);
    expect(openRiskR(['ACTIVE'])).toBe(1);
    expect(openRiskR(['ACTIVE', 'TP1_HIT', 'ACTIVE'])).toBe(2);
    expect(openRiskR(['TP1_HIT'])).toBe(0);
  });
});
