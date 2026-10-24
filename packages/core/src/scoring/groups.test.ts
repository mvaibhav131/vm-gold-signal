import { describe, expect, it } from 'vitest';

import { SESSIONS } from '../domain';
import {
  SESSION_SUITABILITY,
  executionStrength,
  rewardStrength,
  sessionMacroStrength,
  structureStrength,
  trendStrength,
  triggerStrength,
  volatilityStrength,
  type ChartState,
  type QualityRewardFacts,
  type QualitySessionMacroFacts,
  type QualityStructureFacts,
  type QualityTrendFacts,
  type QualityTriggerFacts,
  type QualityVolatilityFacts,
} from './groups';

const near = (actual: number | null, expected: number) => {
  expect(actual).not.toBeNull();
  expect(actual ?? Number.NaN).toBeCloseTo(expected, 9);
};

describe('trend', () => {
  const perfect: QualityTrendFacts = {
    ema20: 4020,
    ema50: 4015,
    ema200: 4000,
    ema50SlopeAtr: 0.5,
    adx: 35,
    plusDI: 30,
    minusDI: 10,
    supertrend: 'UP',
  };
  const buy = (change: Partial<QualityTrendFacts>) =>
    trendStrength('BUY', { ...perfect, ...change });

  it('is 1 when everything points with the trade', () => {
    near(buy({}), 1);
  });

  it('counts each of the two EMA pairs for half of the EMA order', () => {
    near(buy({ ema20: 4010 }), 0.875); // 20 under 50: half of the order
    near(buy({ ema200: 4020 }), 0.875); // 50 under 200
    near(buy({ ema20: 4010, ema200: 4020 }), 0.75);
    near(buy({ ema20: 4015 }), 0.875); // equal is not in order
    near(buy({ ema50: 4000 }), 0.875); // 50 equal to 200
  });

  it('is 0 for the slope when flat or against, 1 from half an ATR', () => {
    near(buy({ ema50SlopeAtr: 0.25 }), 0.875);
    near(buy({ ema50SlopeAtr: 0 }), 0.75);
    near(buy({ ema50SlopeAtr: -0.4 }), 0.75);
    near(buy({ ema50SlopeAtr: 2 }), 1);
  });

  it('is 0 for ADX at 15 and 1 at 35', () => {
    near(buy({ adx: 25 }), 0.875);
    near(buy({ adx: 15 }), 0.75);
    near(buy({ adx: 10 }), 0.75);
    near(buy({ adx: 80 }), 1);
  });

  it('gives no ADX credit when the DI points the other way, but not when they are equal', () => {
    near(buy({ adx: 50, plusDI: 10, minusDI: 30 }), 0.75);
    near(buy({ adx: 35, plusDI: 20, minusDI: 20 }), 1);
    near(buy({ adx: 35, plusDI: null, minusDI: 30 }), 1);
    near(buy({ adx: 35, plusDI: 10, minusDI: null }), 1);
  });

  it('is 0 for a Supertrend against the trade', () => {
    near(buy({ supertrend: 'DOWN' }), 0.75);
  });

  it('is the mean of what exists, and null with nothing', () => {
    const none: QualityTrendFacts = {
      ema20: null,
      ema50: null,
      ema200: null,
      ema50SlopeAtr: null,
      adx: null,
      plusDI: null,
      minusDI: null,
      supertrend: null,
    };
    expect(trendStrength('BUY', none)).toBeNull();
    expect(trendStrength('SELL', none)).toBeNull();
    near(trendStrength('BUY', { ...none, supertrend: 'UP' }), 1);
    near(trendStrength('BUY', { ...none, supertrend: 'UP', adx: 25 }), 0.75);
    expect(trendStrength('BUY', { ...none, ema20: 4020, ema50: 4015, ema200: null })).toBeNull();
    near(trendStrength('BUY', { ...none, ema20: 4020, ema50: 4015, ema200: 4000, adx: 15 }), 0.5);
    near(trendStrength('BUY', { ...none, ema50SlopeAtr: 0.25, plusDI: 1, minusDI: 2 }), 0.5);
  });

  it('a SELL is the BUY seen upside down', () => {
    const mirrored = (facts: QualityTrendFacts): QualityTrendFacts => ({
      ema20: facts.ema20 === null ? null : 8000 - facts.ema20,
      ema50: facts.ema50 === null ? null : 8000 - facts.ema50,
      ema200: facts.ema200 === null ? null : 8000 - facts.ema200,
      ema50SlopeAtr: facts.ema50SlopeAtr === null ? null : -facts.ema50SlopeAtr,
      adx: facts.adx,
      plusDI: facts.minusDI,
      minusDI: facts.plusDI,
      supertrend: facts.supertrend === null ? null : facts.supertrend === 'UP' ? 'DOWN' : 'UP',
    });
    const cases: Partial<QualityTrendFacts>[] = [
      {},
      { ema20: 4010 },
      { ema50SlopeAtr: 0.2, adx: 22, supertrend: 'DOWN' },
      { adx: 40, plusDI: 5, minusDI: 25 },
      { ema200: 4030, ema50SlopeAtr: -0.3 },
      { ema20: null, adx: null },
    ];
    for (const change of cases) {
      const facts = { ...perfect, ...change };
      expect(trendStrength('SELL', mirrored(facts))).toBe(trendStrength('BUY', facts));
    }
  });

  it('a BUY chart is not a SELL setup', () => {
    near(trendStrength('SELL', perfect), 0);
  });
});

describe('structure', () => {
  const perfect: QualityStructureFacts = {
    state15m: 'UP',
    state5m: 'UP',
    breakEvent: 'WITH',
    sweep: null,
    confluence: 2,
    patternMoveR: null,
  };
  const buy = (change: Partial<QualityStructureFacts>) =>
    structureStrength('BUY', { ...perfect, ...change });

  it('is 1 when everything agrees', () => {
    near(buy({}), 1);
  });

  it('takes the mean of the 15m and 5m alignment, as one part', () => {
    // parts: states, break, confluence
    near(buy({ state5m: 'RANGE' }), (0.75 + 1 + 1) / 3);
    near(buy({ state5m: 'DOWN' }), (0.5 + 1 + 1) / 3);
    near(buy({ state15m: 'DOWN', state5m: 'DOWN' }), 2 / 3);
    near(buy({ state15m: 'RANGE', state5m: 'RANGE' }), (0.5 + 1 + 1) / 3);
    near(buy({ state15m: null }), 1);
    near(buy({ state15m: null, state5m: 'DOWN' }), 2 / 3);
    near(buy({ state15m: null, state5m: null }), 1);
  });

  it('a SELL wants the chart to go down', () => {
    near(structureStrength('SELL', { ...perfect, state15m: 'DOWN', state5m: 'DOWN' }), 1);
    near(
      structureStrength('SELL', { ...perfect, state15m: 'DOWN', state5m: 'UP' }),
      (0.5 + 1 + 1) / 3,
    );
    near(structureStrength('SELL', perfect), 2 / 3);
  });

  it('counts the newest break: 1 with the trade, half none, 0 against', () => {
    near(buy({ breakEvent: 'NONE' }), (1 + 0.5 + 1) / 3);
    near(buy({ breakEvent: 'AGAINST' }), 2 / 3);
    near(buy({ breakEvent: null }), 1);
  });

  it('counts a sweep of strategy B: its depth and its wick, half each', () => {
    const withSweep = (depthAtr: number, wickRatio: number) =>
      buy({ sweep: { depthAtr, wickRatio } });
    near(withSweep(0.6, 0.8), 1);
    near(withSweep(0.35, 0.65), (1 + 1 + 1 + 0.5) / 4);
    near(withSweep(0.1, 0.5), 3 / 4);
    near(withSweep(0.6, 0.5), (3 + 0.5) / 4);
    near(withSweep(0.9, 0.95), 1);
    near(withSweep(0.05, 0.3), 3 / 4);
  });

  it('counts the confluence: 0 at none, 1 at two or more', () => {
    near(buy({ confluence: 0 }), 2 / 3);
    near(buy({ confluence: 1 }), 2.5 / 3);
    near(buy({ confluence: 3 }), 1);
    near(buy({ confluence: null }), 1);
  });

  it('counts the measured move of strategy E: 0 at 1.5R, 1 at 3R', () => {
    near(buy({ patternMoveR: 1.5 }), 3 / 4);
    near(buy({ patternMoveR: 2.25 }), 3.5 / 4);
    near(buy({ patternMoveR: 3 }), 1);
    near(buy({ patternMoveR: 5 }), 1);
  });

  it('is null with no fact', () => {
    const none: QualityStructureFacts = {
      state15m: null,
      state5m: null,
      breakEvent: null,
      sweep: null,
      confluence: null,
      patternMoveR: null,
    };
    expect(structureStrength('BUY', none)).toBeNull();
    near(structureStrength('BUY', { ...none, breakEvent: 'NONE' }), 0.5);
  });

  it('a SELL is the BUY seen upside down', () => {
    const flip = (state: ChartState | null): ChartState | null =>
      state === null ? null : state === 'UP' ? 'DOWN' : state === 'DOWN' ? 'UP' : 'RANGE';
    const cases: Partial<QualityStructureFacts>[] = [
      {},
      { state5m: 'RANGE', breakEvent: 'NONE' },
      { state15m: 'DOWN', breakEvent: 'AGAINST', confluence: 1 },
      { sweep: { depthAtr: 0.3, wickRatio: 0.6 }, patternMoveR: 2 },
    ];
    for (const change of cases) {
      const facts = { ...perfect, ...change };
      expect(
        structureStrength('SELL', {
          ...facts,
          state15m: flip(facts.state15m),
          state5m: flip(facts.state5m),
        }),
      ).toBe(structureStrength('BUY', facts));
    }
  });
});

describe('trigger', () => {
  const perfect: QualityTriggerFacts = {
    rangeAtr: 1.6,
    closeLocation: 0.9,
    rsiNow: 40,
    rsiExtreme: 20,
    macdBars: 3,
  };
  const buy = (change: Partial<QualityTriggerFacts>) =>
    triggerStrength('BUY', { ...perfect, ...change });
  const sell = (change: Partial<QualityTriggerFacts>) =>
    triggerStrength('SELL', {
      ...perfect,
      closeLocation: 0.1,
      rsiNow: 60,
      rsiExtreme: 80,
      macdBars: -3,
      ...change,
    });

  it('is 1 for a big candle that closes near its extreme after a reset and a rising MACD', () => {
    near(buy({}), 1);
    near(sell({}), 1);
  });

  it('counts the size of the candle: 0 at 0.6 ATR, 1 at 1.6', () => {
    near(buy({ rangeAtr: 1.1 }), 3.5 / 4);
    near(buy({ rangeAtr: 0.6 }), 3 / 4);
    near(buy({ rangeAtr: 0.2 }), 3 / 4);
    near(buy({ rangeAtr: 3 }), 1);
  });

  it('counts where it closed, towards the trade: 0 at the middle, 1 at 90 percent', () => {
    near(buy({ closeLocation: 0.7 }), 3.5 / 4);
    near(buy({ closeLocation: 0.5 }), 3 / 4);
    near(buy({ closeLocation: 0.2 }), 3 / 4);
    near(sell({ closeLocation: 0.3 }), 3.5 / 4);
    near(sell({ closeLocation: 0.5 }), 3 / 4);
    near(sell({ closeLocation: 0.8 }), 3 / 4);
    near(sell({ closeLocation: 0 }), 1);
  });

  it('counts the RSI reset away from its extreme: 0 at 5 points, 1 at 20', () => {
    near(buy({ rsiNow: 32.5 }), 3.5 / 4);
    near(buy({ rsiNow: 25 }), 3 / 4);
    near(buy({ rsiNow: 15 }), 3 / 4);
    near(sell({ rsiNow: 67.5 }), 3.5 / 4);
    near(sell({ rsiNow: 75 }), 3 / 4);
    near(sell({ rsiNow: 90 }), 3 / 4);
  });

  it('counts the MACD candles in a row in the direction of the trade', () => {
    near(buy({ macdBars: 1.5 }), 3.5 / 4);
    near(buy({ macdBars: 0 }), 3 / 4);
    near(buy({ macdBars: -2 }), 3 / 4);
    near(buy({ macdBars: 6 }), 1);
    near(sell({ macdBars: -1.5 }), 3.5 / 4);
    near(sell({ macdBars: 2 }), 3 / 4);
  });

  it('needs both RSI values for the reset', () => {
    near(buy({ rsiNow: null }), 1);
    near(buy({ rsiExtreme: null, macdBars: 0 }), 2 / 3);
  });

  it('is null with no fact', () => {
    const none: QualityTriggerFacts = {
      rangeAtr: null,
      closeLocation: null,
      rsiNow: null,
      rsiExtreme: null,
      macdBars: null,
    };
    expect(triggerStrength('BUY', none)).toBeNull();
    near(triggerStrength('SELL', { ...none, macdBars: -1.5 }), 0.5);
  });
});

describe('volatility', () => {
  const v = (atrPercentile: number | null, squeeze: QualityVolatilityFacts['squeeze']) =>
    volatilityStrength({ atrPercentile, squeeze });

  it('is best between the 30th and 70th percentile', () => {
    for (const percentile of [30, 50, 70]) near(v(percentile, 'RELEASED'), 1);
  });

  it('falls to nothing at the 10th and 90th', () => {
    near(v(10, 'RELEASED'), 0.5);
    near(v(90, 'RELEASED'), 0.5);
    near(v(20, 'RELEASED'), 0.75);
    near(v(80, 'RELEASED'), 0.75);
    near(v(0, 'RELEASED'), 0.5);
    near(v(100, 'RELEASED'), 0.5);
  });

  it('counts the squeeze: 1 just released, 0.7 none, 0.3 on', () => {
    near(v(50, 'RELEASED'), 1);
    near(v(50, 'NONE'), 0.85);
    near(v(50, 'ON'), 0.65);
  });

  it('uses what exists', () => {
    near(v(null, 'ON'), 0.3);
    near(v(20, null), 0.5);
    expect(v(null, null)).toBeNull();
  });
});

describe('execution', () => {
  const e = (spreadPercentile: number | null, stopAtr: number | null) =>
    executionStrength({ spreadPercentile, stopAtr });

  it('is 1 for a normal spread and a stop of 1.1 to 1.7 ATR', () => {
    near(e(40, 1.1), 1);
    near(e(10, 1.4), 1);
    near(e(0, 1.7), 1);
  });

  it('is 0 for the spread at the 95th percentile and beyond', () => {
    near(e(95, 1.4), 0.5);
    near(e(100, 1.4), 0.5);
    near(e(67.5, 1.4), 0.75);
  });

  it('is 0 for a stop at the limits of STOP_OK, 0.8 and 2.0 ATR', () => {
    near(e(40, 0.8), 0.5);
    near(e(40, 2.0), 0.5);
    near(e(40, 0.95), 0.75);
    near(e(40, 1.85), 0.75);
    near(e(40, 0.3), 0.5);
    near(e(40, 3), 0.5);
  });

  it('uses what exists', () => {
    near(e(95, null), 0);
    near(e(null, 1.4), 1);
    expect(e(null, null)).toBeNull();
  });
});

describe('session and macro', () => {
  const sm = (
    session: QualitySessionMacroFacts['session'],
    news: QualitySessionMacroFacts['news'],
  ) => sessionMacroStrength({ session, news });

  it('knows how well each session suits', () => {
    expect(SESSION_SUITABILITY).toEqual({
      LONDON: 1,
      OVERLAP: 1,
      NEW_YORK: 0.9,
      ASIA: 0.5,
      ROLLOVER: 0.2,
    });
    expect(Object.keys(SESSION_SUITABILITY).sort()).toEqual([...SESSIONS].sort());
    for (const session of SESSIONS) {
      near(sm(session, null), SESSION_SUITABILITY[session]);
    }
  });

  it('is 0 for the news inside the window of an event', () => {
    near(sm('LONDON', { state: 'IN_WINDOW', minutesToNext: null }), 0.5);
    near(sm('LONDON', { state: 'IN_WINDOW', minutesToNext: 600 }), 0.5);
  });

  it('is 1 with no event known', () => {
    near(sm('ASIA', { state: 'CLEAR', minutesToNext: null }), 0.75);
  });

  it('rises from 0 at 45 minutes to 1 at 4 hours', () => {
    near(sm('LONDON', { state: 'CLEAR', minutesToNext: 45 }), 0.5);
    near(sm('LONDON', { state: 'CLEAR', minutesToNext: 142.5 }), 0.75);
    near(sm('LONDON', { state: 'CLEAR', minutesToNext: 240 }), 1);
    near(sm('LONDON', { state: 'CLEAR', minutesToNext: 900 }), 1);
    near(sm('LONDON', { state: 'CLEAR', minutesToNext: 10 }), 0.5);
  });

  it('leaves the news out when the calendar is not available', () => {
    near(sm('NEW_YORK', { state: 'UNKNOWN', minutesToNext: null }), 0.9);
    near(sm('NEW_YORK', { state: 'UNKNOWN', minutesToNext: 100 }), 0.9);
  });

  it('uses what exists', () => {
    near(sm(null, { state: 'CLEAR', minutesToNext: null }), 1);
    near(sm(null, { state: 'IN_WINDOW', minutesToNext: null }), 0);
    expect(sm(null, null)).toBeNull();
    expect(sm(null, { state: 'UNKNOWN', minutesToNext: null })).toBeNull();
  });
});

describe('reward feasibility', () => {
  const r = (tp1Atr: number | null, levelRoom: QualityRewardFacts['levelRoom']) =>
    rewardStrength({ tp1Atr, levelRoom });

  it('is 1 for a near target and no level in the way', () => {
    near(r(1.5, 'NONE'), 1);
    near(r(1, 'NONE'), 1);
  });

  it('falls to 0 at the 2.5 ATR limit of TARGET_OK', () => {
    near(r(2.0, 'NONE'), 0.75);
    near(r(2.5, 'NONE'), 0.5);
    near(r(3.5, 'NONE'), 0.5);
  });

  it('counts the room to the nearest opposing level: 0 half way to TP1, 1 from 1.2 times', () => {
    near(r(1.5, 0.5), 0.5);
    near(r(1.5, 0.85), 0.75);
    near(r(1.5, 1.2), 1);
    near(r(1.5, 3), 1);
    near(r(1.5, 0.2), 0.5);
  });

  it('uses what exists', () => {
    near(r(null, 0.85), 0.5);
    near(r(2.0, null), 0.5);
    near(r(null, 'NONE'), 1);
    expect(r(null, null)).toBeNull();
  });
});
