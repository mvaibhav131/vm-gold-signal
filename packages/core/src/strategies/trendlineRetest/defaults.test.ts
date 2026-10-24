import { describe, expect, it } from 'vitest';

import { INDICATOR_DEFAULTS } from '../../indicators/volatility';
import { TRENDLINE_DEFAULTS } from '../../trendlines/types';
import { TRENDLINE_RETEST_DEFAULTS } from './types';

describe('the numbers of Trendline Retest v0.1.0', () => {
  it('are the nine params of the strategy-config and the periods of docs/02 section 7.4', () => {
    expect(TRENDLINE_RETEST_DEFAULTS).toEqual({
      atrPeriod: 14,
      rsiPeriod: 14,
      adxPeriod: 14,
      minTouches: 3,
      maxAdx1hAgainst: 30,
      breakMinAtr: 0.1,
      breakMinBodyFraction: 0.5,
      retestWithinCandles: 8,
      retestMaxDistanceAtr: 0.3,
      retestMinWickFraction: 0.3,
      retestMinRsi: 45,
      stopBufferAtr: 0.25,
    });
  });

  it('use the ATR, RSI and ADX periods of the indicators', () => {
    expect(TRENDLINE_RETEST_DEFAULTS.atrPeriod).toBe(INDICATOR_DEFAULTS.atrPeriod);
    expect(TRENDLINE_RETEST_DEFAULTS.rsiPeriod).toBe(INDICATOR_DEFAULTS.rsiPeriod);
    expect(TRENDLINE_RETEST_DEFAULTS.adxPeriod).toBe(INDICATOR_DEFAULTS.adxPeriod);
  });

  it('use the break and retest numbers of the trendline detector (section 4.1)', () => {
    expect(TRENDLINE_RETEST_DEFAULTS.breakMinAtr).toBe(TRENDLINE_DEFAULTS.break.closeAtr);
    expect(TRENDLINE_RETEST_DEFAULTS.breakMinBodyFraction).toBe(TRENDLINE_DEFAULTS.break.bodyRatio);
    expect(TRENDLINE_RETEST_DEFAULTS.retestMaxDistanceAtr).toBe(TRENDLINE_DEFAULTS.retest.zoneAtr);
    expect(TRENDLINE_RETEST_DEFAULTS.retestWithinCandles).toBe(TRENDLINE_DEFAULTS.retest.within);
    expect(TRENDLINE_RETEST_DEFAULTS.minTouches).toBe(TRENDLINE_DEFAULTS.confirmedTouches);
  });
});
