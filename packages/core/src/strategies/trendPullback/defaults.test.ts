import { describe, expect, it } from 'vitest';

import { REGIME_DEFAULTS } from '../../regime/types';
import { keyTime } from '../types';
import { TREND_PULLBACK_DEFAULTS } from './types';

describe('the numbers of Trend Pullback v0.1.0', () => {
  it('are the six params of the strategy-config and the decisions of docs/02 section 7.1', () => {
    expect(TREND_PULLBACK_DEFAULTS).toEqual({
      periods: { emaFast: 20, emaMid: 50, emaSlow: 200, rsi: 14, atr: 14 },
      emaSlopeHours: 6,
      rsiPullbackMax: 45,
      rsiLookbackCandles: 12,
      rsiRiseLookbackCandles: 3,
      macdRisingCandles: 2,
      stopBufferAtr: 0.25,
      legLookbackCandles: 36,
    });
  });

  it('use the same three 1h averages as the regime', () => {
    expect(TREND_PULLBACK_DEFAULTS.periods).toMatchObject({
      emaFast: REGIME_DEFAULTS.periods.emaFast,
      emaMid: REGIME_DEFAULTS.periods.emaMid,
      emaSlow: REGIME_DEFAULTS.periods.emaSlow,
      atr: REGIME_DEFAULTS.periods.atr,
    });
  });

  it('look back at least as far as the longest window of the rules', () => {
    expect(TREND_PULLBACK_DEFAULTS.legLookbackCandles).toBeGreaterThanOrEqual(
      TREND_PULLBACK_DEFAULTS.rsiLookbackCandles,
    );
  });
});

describe('the time inside a setup key', () => {
  it('is an ISO time in UTC without milliseconds', () => {
    expect(keyTime(Date.UTC(2026, 9, 23, 5, 30))).toBe('2026-10-23T05:30:00Z');
    expect(keyTime(Date.UTC(2026, 0, 5, 22, 45, 7))).toBe('2026-01-05T22:45:07Z');
  });
});
