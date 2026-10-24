import { describe, expect, it } from 'vitest';

import { REGIMES } from '../../domain';
import {
  allSweepChecksPass,
  choch15mHolds,
  chooseSweep,
  isTrendRegime,
  judgeSweep,
  sweepStop,
} from './rules';
import {
  SWEEP_CHECKS,
  SWEEP_REVERSAL_DEFAULTS,
  TREND_REGIMES,
  type SweepCandidate,
  type SweepCheck,
  type SweepInputs,
} from './types';

const P = SWEEP_REVERSAL_DEFAULTS;

const sweepOf = (change: Partial<SweepCandidate> = {}): SweepCandidate => ({
  levelId: 'PDL:2026-01-05',
  level: 4043,
  sweepOpenTime: 1_000_000,
  reclaimOpenTime: 1_000_000,
  candlesSinceReclaim: 2,
  lowest: 4038.5,
  depthAtr: 1.5,
  wickRatio: 0.8,
  divergence: false,
  ...change,
});

/** Every rule is met, none of them by a hair. */
const PASSING: SweepInputs = {
  regime: 'RANGE',
  sweep: sweepOf(),
  chochLevel: 4054.3,
  displacementAtr: 3.1,
  choch15mClosedAt: 1_500_000,
};

function failing(change: Partial<SweepInputs>, params = P): SweepCheck[] {
  const checks = judgeSweep({ ...PASSING, ...change }, params);
  return SWEEP_CHECKS.filter((check) => !checks[check]);
}

describe('the rules of Sweep Reversal', () => {
  it('all hold for the passing inputs', () => {
    expect(failing({})).toEqual([]);
    expect(allSweepChecksPass(judgeSweep(PASSING, P))).toBe(true);
  });

  it('a single missing rule means no setup', () => {
    for (const check of SWEEP_CHECKS) {
      const checks = { ...judgeSweep(PASSING, P), [check]: false };
      expect(allSweepChecksPass(checks), check).toBe(false);
    }
  });

  it('lists the rules in the order of docs/02 section 7.B', () => {
    expect(SWEEP_CHECKS).toEqual(['sweepReclaimed', 'chochUp5m', 'displacement', 'trendChoch15m']);
  });

  it('a sweep, a CHoCH and a displacement candle are each needed', () => {
    expect(failing({ sweep: null })).toEqual(['sweepReclaimed']);
    expect(failing({ chochLevel: null })).toEqual(['chochUp5m']);
    expect(failing({ displacementAtr: null })).toEqual(['displacement']);
  });
});

describe('the 15m CHoCH in a trend', () => {
  const trends = ['TREND_UP', 'TREND_DOWN'] as const;

  it('the trend regimes are the two trends', () => {
    expect(TREND_REGIMES).toEqual(['TREND_UP', 'TREND_DOWN']);
    expect(REGIMES.filter((regime) => isTrendRegime(regime))).toEqual(['TREND_UP', 'TREND_DOWN']);
    expect(isTrendRegime(null)).toBe(false);
  });

  it.each(trends)('%s: needs a 15m CHoCH that closed after the sweep began', (regime) => {
    expect(failing({ regime })).toEqual([]);
    expect(failing({ regime, choch15mClosedAt: null })).toEqual(['trendChoch15m']);
    expect(failing({ regime, choch15mClosedAt: 1_000_000 })).toEqual(['trendChoch15m']);
    expect(failing({ regime, choch15mClosedAt: 1_000_001 })).toEqual([]);
    expect(failing({ regime, choch15mClosedAt: 999_999 })).toEqual(['trendChoch15m']);
  });

  it.each(REGIMES.filter((regime) => !isTrendRegime(regime)))(
    '%s: does not ask for it',
    (regime) => {
      expect(failing({ regime, choch15mClosedAt: null })).toEqual([]);
    },
  );

  it('an unknown regime cannot be judged, so the rule fails', () => {
    expect(failing({ regime: null })).toEqual(['trendChoch15m']);
    expect(failing({ regime: null, choch15mClosedAt: null })).toEqual(['trendChoch15m']);
  });

  it('is not asked for when the params say so, whatever the regime', () => {
    const relaxed = { ...P, requireChochInTrend: false };
    for (const regime of [...REGIMES, null]) {
      expect(failing({ regime, choch15mClosedAt: null }, relaxed), String(regime)).toEqual([]);
    }
  });

  it('holds only with a sweep to compare the time with', () => {
    expect(choch15mHolds({ sweep: null, choch15mClosedAt: 5_000_000 })).toBe(false);
    expect(choch15mHolds({ sweep: sweepOf(), choch15mClosedAt: 1_000_001 })).toBe(true);
    expect(choch15mHolds({ sweep: sweepOf(), choch15mClosedAt: 1_000_000 })).toBe(false);
    expect(choch15mHolds({ sweep: sweepOf(), choch15mClosedAt: null })).toBe(false);
  });
});

describe('which sweep the setup is about', () => {
  it('none without a sweep', () => {
    expect(chooseSweep([], P)).toBeNull();
  });

  it('the reclaim candle through the sixth candle after it', () => {
    for (const candlesSinceReclaim of [0, 1, 5, 6]) {
      expect(
        chooseSweep([sweepOf({ candlesSinceReclaim })], P),
        String(candlesSinceReclaim),
      ).not.toBeNull();
    }
    for (const candlesSinceReclaim of [7, 8, 40, -1]) {
      expect(
        chooseSweep([sweepOf({ candlesSinceReclaim })], P),
        String(candlesSinceReclaim),
      ).toBeNull();
    }
  });

  it('the window comes from the params', () => {
    const within = (triggerWithinCandles: number) => ({ ...P, triggerWithinCandles });
    expect(chooseSweep([sweepOf({ candlesSinceReclaim: 3 })], within(3))).not.toBeNull();
    expect(chooseSweep([sweepOf({ candlesSinceReclaim: 4 })], within(3))).toBeNull();
    expect(chooseSweep([sweepOf({ candlesSinceReclaim: 9 })], within(9))).not.toBeNull();
    expect(chooseSweep([sweepOf({ candlesSinceReclaim: 10 })], within(9))).toBeNull();
  });

  it('the most recent reclaim, however deep the older one went', () => {
    const older = sweepOf({ levelId: 'A', candlesSinceReclaim: 4, lowest: 4000 });
    const newer = sweepOf({ levelId: 'B', candlesSinceReclaim: 1, lowest: 4030 });
    expect(chooseSweep([older, newer], P)?.levelId).toBe('B');
    expect(chooseSweep([newer, older], P)?.levelId).toBe('B');
  });

  it('then the deepest, then the smaller level id', () => {
    const shallow = sweepOf({ levelId: 'A', lowest: 4040 });
    const deep = sweepOf({ levelId: 'B', lowest: 4038 });
    expect(chooseSweep([shallow, deep], P)?.levelId).toBe('B');
    expect(chooseSweep([deep, shallow], P)?.levelId).toBe('B');
    const second = sweepOf({ levelId: 'B' });
    const first = sweepOf({ levelId: 'A' });
    expect(chooseSweep([second, first], P)?.levelId).toBe('A');
    expect(chooseSweep([first, second], P)?.levelId).toBe('A');
  });

  it('an old sweep outside the window is not chosen over nothing', () => {
    const old = sweepOf({ candlesSinceReclaim: 9 });
    const fresh = sweepOf({ levelId: 'Z', candlesSinceReclaim: 6 });
    expect(chooseSweep([old, fresh], P)?.levelId).toBe('Z');
    expect(chooseSweep([old], P)).toBeNull();
  });
});

describe('the stop', () => {
  it('lies 0.2 x ATR beyond the sweep low', () => {
    expect(sweepStop(4038.5, 2, P)).toBeCloseTo(4038.1, 9);
    expect(sweepStop(4038.5, 5, P)).toBeCloseTo(4037.5, 9);
  });

  it('takes the buffer from the params', () => {
    expect(sweepStop(4038.5, 2, { stopBufferAtr: 1 })).toBe(4036.5);
    expect(sweepStop(4038.5, 2, { stopBufferAtr: 0 })).toBe(4038.5);
  });

  it('cannot be placed without the sweep low or the ATR', () => {
    expect(sweepStop(null, 2, P)).toBeNull();
    expect(sweepStop(4038.5, null, P)).toBeNull();
  });
});
