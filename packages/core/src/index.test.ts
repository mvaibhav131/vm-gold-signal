import { describe, expect, it } from 'vitest';

import { PRICE_DECIMALS, TRADED_SYMBOL } from './index';

describe('core constants', () => {
  it('trades only XAUUSD', () => {
    expect(TRADED_SYMBOL).toBe('XAUUSD');
  });

  it('stores prices with whole-number decimal places', () => {
    expect(Number.isInteger(PRICE_DECIMALS)).toBe(true);
    expect(PRICE_DECIMALS).toBeGreaterThan(0);
  });
});
