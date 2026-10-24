import { describe, expect, it } from 'vitest';

import { REGIME_DEFAULTS } from '../../regime/types';
import { STRUCTURE_DEFAULTS } from '../../structure/types';
import { SWEEP_REVERSAL_DEFAULTS } from './types';

describe('the numbers of Sweep Reversal v0.1.0', () => {
  it('are the three params of the strategy-config and the ATR period', () => {
    expect(SWEEP_REVERSAL_DEFAULTS).toEqual({
      atrPeriod: 14,
      triggerWithinCandles: 6,
      requireChochInTrend: true,
      stopBufferAtr: 0.2,
    });
  });

  it('use the ATR period of the regime and the structure code', () => {
    expect(SWEEP_REVERSAL_DEFAULTS.atrPeriod).toBe(REGIME_DEFAULTS.periods.atr);
  });

  it('wait at least as long for the trigger as the sweep needs to be reclaimed', () => {
    expect(SWEEP_REVERSAL_DEFAULTS.triggerWithinCandles).toBeGreaterThanOrEqual(
      STRUCTURE_DEFAULTS.sweep.reclaimWithin,
    );
  });
});
