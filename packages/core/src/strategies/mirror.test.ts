import { describe, expect, it } from 'vitest';

import { mirrorCandle, mirrorLevel } from './mirror';

describe('mirroring a market', () => {
  const candle = { openTime: 1000, o: 4010, h: 4015, l: 4005, c: 4012 };

  it('negates every price and swaps the high and the low', () => {
    expect(mirrorCandle(candle)).toEqual({
      openTime: 1000,
      o: -4010,
      h: -4005,
      l: -4015,
      c: -4012,
    });
  });

  it('keeps the high above the low and the body inside the range', () => {
    const m = mirrorCandle(candle);
    expect(m.h).toBeGreaterThanOrEqual(Math.max(m.o, m.c));
    expect(m.l).toBeLessThanOrEqual(Math.min(m.o, m.c));
  });

  it('mirroring twice gives the original back', () => {
    expect(mirrorCandle(mirrorCandle(candle))).toEqual(candle);
  });

  it('a liquidity high is a liquidity low at the negated price, and the other way round', () => {
    expect(mirrorLevel({ id: 'PDH:1', side: 'HIGH', price: 4060 })).toEqual({
      id: 'PDH:1',
      side: 'LOW',
      price: -4060,
    });
    expect(mirrorLevel({ id: 'PDL:1', side: 'LOW', price: 4030 })).toEqual({
      id: 'PDL:1',
      side: 'HIGH',
      price: -4030,
    });
  });
});
