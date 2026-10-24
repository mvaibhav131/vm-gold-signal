import { describe, expect, it } from 'vitest';

import { BASELINE_CANDLES_24H } from '../context/baseline';
import { LEVEL_DEFAULTS } from '../levels/types';
import { REGIME_DEFAULTS } from '../regime/types';
import { RegimeTracker } from '../regime/tracker';
import { GATE_DEFAULTS } from './types';

// The warm-up sizes are three times the longest window the engine uses on a timeframe
// (docs/02 sections 2 and 6.1). These guards fail when a window grows without the gate.
describe('the warm-up sizes follow the windows of the engine', () => {
  const needed = GATE_DEFAULTS.warmupCandles;

  it('1h: three times EMA 200', () => {
    expect(needed['1h']).toBe(3 * REGIME_DEFAULTS.periods.emaSlow);
  });

  it('15m: three times the ATR percentile window of the regime', () => {
    expect(needed['15m']).toBe(3 * REGIME_DEFAULTS.highVol.window);
  });

  it('5m: three times the longest window of the zones', () => {
    expect(needed['5m']).toBe(3 * LEVEL_DEFAULTS.zones.windows['5m']);
  });

  it('is never less than the regime tracker needs, so the regime exists when the gate opens', () => {
    const regime = new RegimeTracker().warmup;
    expect(needed['1h']).toBeGreaterThanOrEqual(regime['1h']);
    expect(needed['15m']).toBeGreaterThanOrEqual(regime['15m']);
  });

  it('covers the other windows of each timeframe', () => {
    expect(needed['5m']).toBeGreaterThan(BASELINE_CANDLES_24H);
    expect(needed['15m']).toBeGreaterThanOrEqual(LEVEL_DEFAULTS.zones.windows['15m']);
    expect(needed['1h']).toBeGreaterThanOrEqual(LEVEL_DEFAULTS.zones.windows['1h']);
  });
});
