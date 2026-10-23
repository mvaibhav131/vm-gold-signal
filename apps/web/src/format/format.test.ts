import { describe, expect, it } from 'vitest';

import {
  engineChip,
  formatFixed,
  formatPrice,
  formatSpread,
  freshnessChip,
  labelOf,
  midOf,
  modeChip,
  strategyChip,
} from './format';
import type { EngineSnapshot } from './types';

const engine: EngineSnapshot = {
  status: 'RUNNING',
  openCount: 0,
  openRiskR: 0,
  warmup: { ready: true, progressPct: 100 },
  waitReasons: [],
  evaluatedAt: '2026-10-23T06:10:00Z',
};

describe('price formatting', () => {
  it('shows prices and spreads with the 3 decimals they are stored with', () => {
    expect(formatPrice(4017.2)).toBe('4017.200');
    expect(formatPrice(4017.285)).toBe('4017.285');
    expect(formatPrice(4017.37)).toBe('4017.370');
    expect(formatSpread(0.17)).toBe('0.170');
    expect(formatSpread(0.9)).toBe('0.900');
    expect(formatSpread(0.005)).toBe('0.005');
    expect(formatSpread(0)).toBe('0.000');
  });

  it('never shifts a digit through binary float error', () => {
    // 4017.285 * 1000 and 1.005 * 1000 are not whole numbers in binary floats.
    expect(formatPrice(4017.285)).toBe('4017.285');
    expect(formatPrice(1.005)).toBe('1.005');
    expect(formatPrice(4016.945)).toBe('4016.945');
  });

  it('rounds half up when fewer decimals are asked for (R values use 2)', () => {
    expect(formatFixed(4017.285, 2)).toBe('4017.29');
    expect(formatFixed(4017.284, 2)).toBe('4017.28');
    expect(formatFixed(1.005, 2)).toBe('1.01');
    expect(formatFixed(0.004, 2)).toBe('0.00');
    expect(formatFixed(4017.5, 0)).toBe('4018');
    expect(formatFixed(0.25, 1)).toBe('0.3');
  });

  it('keeps the sign of negative values and never shows -0.00', () => {
    expect(formatFixed(-0.125, 2)).toBe('-0.13');
    expect(formatFixed(-0.004, 2)).toBe('0.00');
    expect(formatFixed(-12.5, 2)).toBe('-12.50');
    expect(formatFixed(-0.125, 3)).toBe('-0.125');
  });

  it('computes the mid price in whole thousandths (half up)', () => {
    expect(midOf(4017.2, 4017.37)).toBe(4017.285);
    expect(midOf(4017.2, 4017.371)).toBe(4017.286);
    expect(midOf(4017.2, 4017.2)).toBe(4017.2);
    expect(formatPrice(midOf(4017.2, 4017.37))).toBe('4017.285');
  });
});

describe('labels', () => {
  it('turns codes into upper case words', () => {
    expect(labelOf('NEW_YORK')).toBe('NEW YORK');
    expect(labelOf('TREND_UP')).toBe('TREND UP');
    expect(labelOf('LONDON')).toBe('LONDON');
  });
});

describe('freshnessChip (05_UI_Spec section 3)', () => {
  it('is green and shows the age while the feed is live', () => {
    expect(freshnessChip('LIVE', 400, 100)).toEqual({ text: 'FRESH 0.4 s', tone: 'positive' });
    expect(freshnessChip('LIVE', 1234, 100).text).toBe('FRESH 1.2 s');
  });

  it('is red when the feed is stale or disconnected', () => {
    expect(freshnessChip('STALE', 18000, 100)).toEqual({ text: 'STALE', tone: 'negative' });
    expect(freshnessChip('DISCONNECTED', 0, 100)).toEqual({
      text: 'DISCONNECTED',
      tone: 'negative',
    });
  });

  it('is grey when the market is closed and amber while warming up', () => {
    expect(freshnessChip('MARKET_CLOSED', 0, 100)).toEqual({
      text: 'MARKET CLOSED',
      tone: 'neutral',
    });
    expect(freshnessChip('WARMING_UP', 0, 41.6)).toEqual({
      text: 'WARMING UP 42%',
      tone: 'warning',
    });
  });

  it('keeps unknown states visible as text', () => {
    expect(freshnessChip('SOMETHING_NEW', 0, 100).text).toBe('SOMETHING NEW');
  });
});

describe('engineChip', () => {
  it('shows running, paused and warming up', () => {
    expect(engineChip(engine)).toEqual({ text: 'RUNNING', tone: 'positive' });
    expect(
      engineChip({ ...engine, status: 'PAUSED', pausedSince: '2026-10-23T06:00:00Z' }),
    ).toEqual({
      text: 'PAUSED',
      tone: 'warning',
    });
    expect(engineChip({ ...engine, warmup: { ready: false, progressPct: 20 } })).toEqual({
      text: 'WARMING UP',
      tone: 'warning',
    });
  });
});

describe('modeChip', () => {
  it('shows SIMULATED for everything that is not live (rule C8)', () => {
    expect(modeChip('SIMULATED').text).toBe('SIMULATED');
    expect(modeChip('BACKTEST').text).toBe('SIMULATED');
    expect(modeChip('LIVE').text).toBe('LIVE');
  });
});

describe('strategyChip', () => {
  it('stays FORWARD-TEST until a strategy is VALIDATED (rule C9)', () => {
    expect(strategyChip(['FORWARD_TESTING', 'RESEARCH']).text).toBe('FORWARD-TEST');
    expect(strategyChip([]).text).toBe('FORWARD-TEST');
    expect(strategyChip(['VALIDATED', 'FORWARD_TESTING']).text).toBe('VALIDATED 1');
  });
});
