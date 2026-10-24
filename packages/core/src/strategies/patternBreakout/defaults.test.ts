import { describe, expect, it } from 'vitest';

import { INDICATOR_DEFAULTS } from '../../indicators/volatility';
import { SQUEEZE_RETEST_DEFAULTS } from '../squeezeRetest/types';
import { TRENDLINE_RETEST_DEFAULTS } from '../trendlineRetest/types';
import { PATTERN_BREAKOUT_DEFAULTS } from './types';

describe('the numbers of Pattern Breakout v0.1.0', () => {
  it('are the three params of the strategy-config and the period of docs/02 section 7.5', () => {
    expect(PATTERN_BREAKOUT_DEFAULTS).toEqual({
      atrPeriod: 14,
      retestWithinCandles: 8,
      retestMaxDistanceAtr: 0.25,
      retestMinWickFraction: 0.3,
      stopBufferAtr: 0.25,
      minMeasuredMoveR: 1.5,
    });
  });

  it('use the ATR period of the indicators', () => {
    expect(PATTERN_BREAKOUT_DEFAULTS.atrPeriod).toBe(INDICATOR_DEFAULTS.atrPeriod);
  });

  it('retest "by the same rule as strategy C": its distance, its window and the wick of strategy D and C', () => {
    expect(PATTERN_BREAKOUT_DEFAULTS.retestMaxDistanceAtr).toBe(
      SQUEEZE_RETEST_DEFAULTS.retestMaxDistanceAtr,
    );
    expect(PATTERN_BREAKOUT_DEFAULTS.retestWithinCandles).toBe(
      SQUEEZE_RETEST_DEFAULTS.retestWithinCandles,
    );
    expect(PATTERN_BREAKOUT_DEFAULTS.retestMinWickFraction).toBe(
      SQUEEZE_RETEST_DEFAULTS.rejectionWickRatio,
    );
    expect(PATTERN_BREAKOUT_DEFAULTS.retestMinWickFraction).toBe(
      TRENDLINE_RETEST_DEFAULTS.retestMinWickFraction,
    );
  });
});
