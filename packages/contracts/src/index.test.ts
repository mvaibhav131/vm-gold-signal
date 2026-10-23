import { describe, expect, it } from 'vitest';

import { priceSchema, symbolSchema } from './index';

describe('contracts', () => {
  it('accepts only the traded symbol', () => {
    expect(symbolSchema.safeParse('XAUUSD').success).toBe(true);
    expect(symbolSchema.safeParse('EURUSD').success).toBe(false);
  });

  it('accepts only finite positive prices', () => {
    expect(priceSchema.safeParse(4017.28).success).toBe(true);
    expect(priceSchema.safeParse(0).success).toBe(false);
    expect(priceSchema.safeParse(-1).success).toBe(false);
    expect(priceSchema.safeParse(Number.NaN).success).toBe(false);
    expect(priceSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });
});
