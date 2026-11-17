import { describe, expect, it } from 'vitest';

import { judgeTrend, trendStop } from './rules';

describe('judgeTrend', () => {
  it('is UP when the fast average is over the middle one and the price over the slow one', () => {
    expect(judgeTrend(4010, 4005, 4000, 3990)).toBe('UP');
  });

  it('is DOWN when it is the other way round on every count', () => {
    expect(judgeTrend(3980, 3985, 3990, 4000)).toBe('DOWN');
  });

  it('has no trend when the three disagree, and none on a tie', () => {
    expect(judgeTrend(3980, 4005, 4000, 3990)).toBeNull(); // averages up, price under the slow one
    expect(judgeTrend(4010, 3985, 3990, 4000)).toBeNull(); // averages down, price over the slow one
    expect(judgeTrend(4010, 4000, 4000, 3990)).toBeNull(); // fast = middle
    expect(judgeTrend(3990, 4005, 4000, 3990)).toBeNull(); // price = slow
  });
});

describe('trendStop', () => {
  it('puts the stop that many ATR(1h) beyond the close, against the trade', () => {
    expect(trendStop('BUY', 4000, 8, 2.5)).toBe(3980);
    expect(trendStop('SELL', 4000, 8, 2.5)).toBe(4020);
  });
});
