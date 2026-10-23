import { describe, expect, it } from 'vitest';

import {
  engineChip,
  formatFixed2,
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
  it('shows prices and spreads with two decimals', () => {
    expect(formatPrice(4017.2)).toBe('4017.20');
    expect(formatPrice(4017.28)).toBe('4017.28');
    expect(formatSpread(0.17)).toBe('0.17');
    expect(formatSpread(0.9)).toBe('0.90');
    expect(formatSpread(0)).toBe('0.00');
  });

  it('rounds half up on the third decimal (toFixed would be a cent off)', () => {
    expect(formatPrice(4017.285)).toBe('4017.29');
    expect(formatPrice(4017.284)).toBe('4017.28');
    expect(formatPrice(1.005)).toBe('1.01');
    expect(formatSpread(0.005)).toBe('0.01');
    expect(formatSpread(0.004)).toBe('0.00');
  });

  it('keeps the sign of negative values and never shows -0.00', () => {
    expect(formatFixed2(-0.125)).toBe('-0.13');
    expect(formatFixed2(-0.004)).toBe('0.00');
    expect(formatFixed2(-12.5)).toBe('-12.50');
  });

  it('computes the mid price', () => {
    expect(midOf(4017.2, 4017.37)).toBeCloseTo(4017.285, 6);
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
