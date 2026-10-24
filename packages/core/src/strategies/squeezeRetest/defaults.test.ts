import { describe, expect, it } from 'vitest';

import { INDICATOR_DEFAULTS } from '../../indicators/volatility';
import { REGIME_DEFAULTS } from '../../regime/types';
import { SQUEEZE_RETEST_DEFAULTS } from './types';

describe('the numbers of Squeeze Retest v0.1.0', () => {
  it('are the six params of the strategy-config and the decisions of docs/02 section 7.3', () => {
    expect(SQUEEZE_RETEST_DEFAULTS).toEqual({
      atrPeriod: 14,
      adxPeriod: 14,
      squeezeMinCandles15m: 8,
      releaseWithinCandles15m: 6,
      donchianPeriod: 20,
      breakoutMinAtr: 0.1,
      retestWithinCandles: 8,
      retestMaxDistanceAtr: 0.25,
      rejectionWickRatio: 0.3,
      stopBufferAtr: 0.2,
    });
  });

  it('use the squeeze and release numbers of the regime classifier', () => {
    expect(SQUEEZE_RETEST_DEFAULTS.squeezeMinCandles15m).toBe(REGIME_DEFAULTS.squeeze.minDuration);
    expect(SQUEEZE_RETEST_DEFAULTS.releaseWithinCandles15m).toBe(
      REGIME_DEFAULTS.breakout.withinCandles,
    );
  });

  it('use the ATR, ADX and Donchian periods of the indicators', () => {
    expect(SQUEEZE_RETEST_DEFAULTS.atrPeriod).toBe(INDICATOR_DEFAULTS.atrPeriod);
    expect(SQUEEZE_RETEST_DEFAULTS.adxPeriod).toBe(INDICATOR_DEFAULTS.adxPeriod);
    expect(SQUEEZE_RETEST_DEFAULTS.donchianPeriod).toBe(INDICATOR_DEFAULTS.donchianPeriods[0]);
  });
});
