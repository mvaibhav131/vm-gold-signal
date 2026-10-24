import { keyTime, type PullbackSetup, type SweepSetup } from '@vmgs/core';
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

  it('the same for a sweep reversal, with the swept level in its key', () => {
    const sweep: SweepSetup = {
      strategyKey: 'sweep_reversal',
      side: 'SELL',
      setupKey: `sweep_reversal:5m:PDH:2026-10-22@${keyTime(Date.UTC(2026, 9, 23, 7, 40))}`,
      at: Date.UTC(2026, 9, 23, 7, 55),
      close: 4031.2,
      stopLoss: 4038.6,
      facts: {
        levelId: 'PDH:2026-10-22',
        level: 4036.5,
        sweepOpenTime: Date.UTC(2026, 9, 23, 7, 40),
        reclaimOpenTime: Date.UTC(2026, 9, 23, 7, 40),
        sweepLow: 4037.9,
        depthAtr: 1.1,
        wickRatio: 0.7,
        candlesSinceReclaim: 2,
        chochLevel: 4033.4,
        displacementAtr: 1.6,
        atr: 3.2,
        choch15m: false,
        rsiDivergence: true,
      },
    };
    expect(strategyKeySchema.parse(sweep.strategyKey)).toBe('sweep_reversal');
    expect(sideSchema.parse(sweep.side)).toBe('SELL');
    expect(setupKeySchema.parse(sweep.setupKey)).toBe(
      'sweep_reversal:5m:PDH:2026-10-22@2026-10-23T07:40:00Z',
    );
    expect(priceSchema.parse(sweep.stopLoss)).toBe(4038.6);
  });
});
