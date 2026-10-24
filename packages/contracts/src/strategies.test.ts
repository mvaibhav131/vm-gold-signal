import {
  keyTime,
  type PullbackSetup,
  type SqueezeSetup,
  type SweepSetup,
  type TrendlineRetestSetup,
} from '@vmgs/core';
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

  it('the same for a squeeze retest, keyed by the breakout candle', () => {
    const squeeze: SqueezeSetup = {
      strategyKey: 'squeeze_retest',
      side: 'BUY',
      setupKey: `squeeze_retest:5m:brk-${keyTime(Date.UTC(2026, 9, 23, 9, 5))}`,
      at: Date.UTC(2026, 9, 23, 9, 25),
      close: 4021.6,
      stopLoss: 4017.9,
      facts: {
        level: 4019.4,
        breakoutOpenTime: Date.UTC(2026, 9, 23, 9, 5),
        candlesSinceBreakout: 4,
        breakoutCloseAtr: 0.7,
        breakoutDisplacementAtr: 1.9,
        adx: 24,
        adxBefore: 21,
        retestExtreme: 4018.6,
        retestDistanceAtr: -0.3,
        wickRatio: 0.45,
        squeezeCandles15m: 13,
        candlesSinceRelease15m: 2,
        atr: 2.6,
      },
    };
    expect(strategyKeySchema.parse(squeeze.strategyKey)).toBe('squeeze_retest');
    expect(setupKeySchema.parse(squeeze.setupKey)).toBe(
      'squeeze_retest:5m:brk-2026-10-23T09:05:00Z',
    );
    expect(priceSchema.parse(squeeze.stopLoss)).toBe(4017.9);
  });

  it('the same for a trendline retest, keyed by the line and the break candle', () => {
    const trendline: TrendlineRetestSetup = {
      strategyKey: 'trendline_retest',
      side: 'SELL',
      setupKey: `trendline_retest:5m:15mS:${keyTime(Date.UTC(2026, 9, 23, 3, 15))}:${keyTime(Date.UTC(2026, 9, 23, 5, 0))}@${keyTime(Date.UTC(2026, 9, 23, 9, 35))}`,
      at: Date.UTC(2026, 9, 23, 9, 55),
      close: 4017.4,
      stopLoss: 4019.1,
      facts: {
        lineFrom: Date.UTC(2026, 9, 23, 3, 15),
        lineTo: Date.UTC(2026, 9, 23, 5, 0),
        touches: 3,
        lineValue: 4017.9,
        lineSlope: 0.4,
        breakOpenTime: Date.UTC(2026, 9, 23, 9, 35),
        candlesSinceBreak: 4,
        breakBeyondAtr: 0.6,
        breakBodyRatio: 0.8,
        retestExtreme: 4018.3,
        retestDistanceAtr: 0.2,
        closeAwayAtr: 0.2,
        wickRatio: 0.55,
        rsi: 47,
        adx1h: 24,
        adx1hAligned: true,
        stopFromLine: false,
        atr: 1.9,
      },
    };
    expect(strategyKeySchema.parse(trendline.strategyKey)).toBe('trendline_retest');
    expect(sideSchema.parse(trendline.side)).toBe('SELL');
    expect(setupKeySchema.parse(trendline.setupKey)).toBe(
      'trendline_retest:5m:15mS:2026-10-23T03:15:00Z:2026-10-23T05:00:00Z@2026-10-23T09:35:00Z',
    );
    expect(priceSchema.parse(trendline.stopLoss)).toBe(4019.1);
  });
});
