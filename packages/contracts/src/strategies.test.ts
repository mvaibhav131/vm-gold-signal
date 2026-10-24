import { keyTime, type PullbackSetup } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import { sideSchema, strategyKeySchema } from './enums';
import { priceSchema, setupKeySchema } from './primitives';

describe('what a strategy setup hands to a signal fits the contract', () => {
  const setup: PullbackSetup = {
    strategyKey: 'trend_pullback',
    side: 'BUY',
    setupKey: `trend_pullback:5m:leg-${keyTime(Date.UTC(2026, 9, 23, 5, 30))}`,
    at: Date.UTC(2026, 9, 23, 6, 5),
    close: 4017.37,
    stopLoss: 4010.9,
    facts: {
      legStart: { openTime: Date.UTC(2026, 9, 23, 5, 30), price: 4021.4 },
      legExtreme: 4011.2,
      zone: 'EMA',
      atr: 1.3,
      rsi: 54,
      rsiExtreme: 38,
      breakLevel: 4016.9,
      brokeLevel: true,
      displacement: false,
    },
  };

  it('has a strategy key, a side, a setup key and a stop that the schemas accept', () => {
    expect(strategyKeySchema.parse(setup.strategyKey)).toBe('trend_pullback');
    expect(sideSchema.parse(setup.side)).toBe('BUY');
    expect(setupKeySchema.parse(setup.setupKey)).toBe('trend_pullback:5m:leg-2026-10-23T05:30:00Z');
    expect(priceSchema.parse(setup.stopLoss)).toBe(4010.9);
  });
});
