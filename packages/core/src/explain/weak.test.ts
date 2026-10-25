import { describe, expect, it } from 'vitest';

import type { Side } from '../domain';
import { COMPONENT_KEYS, type QualityInputs } from '../scoring/groups';
import { qualityComponents } from '../scoring/score';
import { BUY_INPUTS, NO_INPUTS, inputsWith } from './test-data';
import { WEAK_LIMIT, weakItems } from './weak';

const trend = (change: Partial<QualityInputs['trend']>): Partial<QualityInputs> => ({
  trend: { ...BUY_INPUTS.trend, ...change },
});
const structure = (change: Partial<QualityInputs['structure']>): Partial<QualityInputs> => ({
  structure: { ...BUY_INPUTS.structure, ...change },
});
const trigger = (change: Partial<QualityInputs['trigger']>): Partial<QualityInputs> => ({
  trigger: { ...BUY_INPUTS.trigger, ...change },
});

const weak = (change: Partial<QualityInputs>, side: Side = 'BUY'): string[] =>
  weakItems(side, inputsWith(change));

describe('a strong setup has nothing weak', () => {
  it('has no weak point', () => {
    expect(weakItems('BUY', BUY_INPUTS)).toEqual([]);
  });

  it('has none when there is no data either: what is not known is not called weak', () => {
    expect(weakItems('BUY', NO_INPUTS)).toEqual([]);
  });
});

describe('each component of the score has its words when it is below the OK line', () => {
  const cases: [string, Partial<QualityInputs>, string][] = [
    [
      'emaOrder',
      trend({ ema20: 4010, ema50: 4015, ema200: 4020 }),
      'the 1h EMAs are not all in the order of the trade',
    ],
    [
      'emaSlope shallow',
      trend({ ema50SlopeAtr: 0.1 }),
      'the 1h EMA 50 slope is shallow (+0.10 ATR(1h) in 3 h)',
    ],
    ['emaSlope flat', trend({ ema50SlopeAtr: 0 }), 'the 1h EMA 50 is flat'],
    ['emaSlope against', trend({ ema50SlopeAtr: -0.3 }), 'the 1h EMA 50 slopes against the trade'],
    ['adx low', trend({ adx: 16 }), 'ADX(1h) is low (16)'],
    [
      'adx with the DI against',
      trend({ adx: 40, plusDI: 10, minusDI: 30 }),
      'the 1h DI points against the trade',
    ],
    ['supertrend', trend({ supertrend: 'DOWN' }), 'the 1h Supertrend is against the trade'],
    [
      'alignment',
      structure({ state15m: 'DOWN', state5m: 'DOWN' }),
      '15m and 5m structure do not agree with the trade (down / down)',
    ],
    [
      'breakEvent',
      structure({ breakEvent: 'AGAINST' }),
      'the latest 5m break is against the trade',
    ],
    [
      'sweep',
      structure({ sweep: { depthAtr: 0.1, wickRatio: 0.5 } }),
      'the sweep is shallow or its wick is short',
    ],
    ['confluence', structure({ confluence: 0 }), 'few trendlines or zones agree (0)'],
    ['pattern', structure({ patternMoveR: 1.5 }), 'the measured move is small (1.50R)'],
    ['candleSize', trigger({ rangeAtr: 0.6 }), 'the trigger candle is small (0.6 x ATR)'],
    [
      'closeLocation',
      trigger({ closeLocation: 0.5 }),
      'the trigger candle closed far from its extreme (at 50% of its range)',
    ],
    [
      'rsiReset',
      trigger({ rsiNow: 40, rsiExtreme: 38 }),
      'the RSI has barely reset from its pullback extreme',
    ],
    ['macd', trigger({ macdBars: 0 }), 'the MACD histogram does not support the trade'],
    [
      'atrPercentile low',
      { volatility: { atrPercentile: 5, squeeze: 'NONE' } },
      'volatility is unusually low (ATR at the 5th percentile)',
    ],
    [
      'atrPercentile high',
      { volatility: { atrPercentile: 95, squeeze: 'NONE' } },
      'volatility is unusually high (ATR at the 95th percentile)',
    ],
    ['squeeze', { volatility: { atrPercentile: 50, squeeze: 'ON' } }, 'a squeeze is still on'],
    [
      'spread',
      { execution: { spreadPercentile: 95, stopAtr: 1.5 } },
      'the spread is wide (95th percentile)',
    ],
    [
      'stopSize tight',
      { execution: { spreadPercentile: 35, stopAtr: 0.8 } },
      'the stop is tight (0.8 x ATR)',
    ],
    [
      'stopSize wide',
      { execution: { spreadPercentile: 35, stopAtr: 2 } },
      'the stop is wide (2.0 x ATR)',
    ],
    [
      'session',
      { sessionMacro: { session: 'ROLLOVER', news: { state: 'CLEAR', minutesToNext: null } } },
      'the Rollover session is a weaker time for this trade',
    ],
    [
      'news in the window',
      { sessionMacro: { session: 'LONDON', news: { state: 'IN_WINDOW', minutesToNext: 10 } } },
      'a high-impact event window is open',
    ],
    [
      'news close',
      { sessionMacro: { session: 'LONDON', news: { state: 'CLEAR', minutesToNext: 45 } } },
      'a high-impact event is only 45 min away',
    ],
    [
      'tp1Distance',
      { reward: { tp1Atr: 2.5, levelRoom: 2.3 } },
      'the first target is far (2.5 x ATR)',
    ],
    [
      'levelRoom',
      { reward: { tp1Atr: 1.5, levelRoom: 0.5 } },
      'an opposing level sits close to the first target',
    ],
  ];

  it.each(cases)('%s', (_name, change, text) => {
    expect(weak(change)).toEqual([text]);
  });

  it('covers every component of the score', () => {
    const covered = new Set<string>();
    for (const [, change] of cases) {
      const groups = qualityComponents('BUY', inputsWith(change));
      for (const group of Object.values(groups)) {
        for (const component of group) if (component.strength < 0.5) covered.add(component.key);
      }
    }
    expect([...covered].sort()).toEqual([...COMPONENT_KEYS].sort());
  });
});

describe('the order and the limit', () => {
  it('does not call equal DI a DI against the trade', () => {
    expect(weak(trend({ adx: 16, plusDI: 20, minusDI: 20 }))).toEqual(['ADX(1h) is low (16)']);
    expect(weak(trend({ adx: 16, plusDI: 21, minusDI: 20 }))).toEqual(['ADX(1h) is low (16)']);
    expect(weak(trend({ adx: 16, plusDI: 19, minusDI: 20 }))).toEqual([
      'the 1h DI points against the trade',
    ]);
  });
  it('lists the weakest first, and equal ones in the order of the score', () => {
    const items = weak({
      ...trend({ ema50SlopeAtr: 0.1, supertrend: 'DOWN' }),
      ...trigger({ macdBars: 0 }),
      execution: { spreadPercentile: 95, stopAtr: 1.5 },
    });
    expect(items).toEqual([
      'the 1h Supertrend is against the trade',
      'the MACD histogram does not support the trade',
      'the spread is wide (95th percentile)',
      'the 1h EMA 50 slope is shallow (+0.10 ATR(1h) in 3 h)',
    ]);
  });

  it('keeps at most WEAK_LIMIT, the first by strength and then by the order of the score', () => {
    expect(WEAK_LIMIT).toBe(5);
    const items = weak({
      ...trend({ supertrend: 'DOWN' }),
      ...trigger({ rangeAtr: 0.6, closeLocation: 0.5, macdBars: 0 }),
      execution: { spreadPercentile: 95, stopAtr: 1.5 },
      reward: { tp1Atr: 2.5, levelRoom: 2.3 },
      volatility: { atrPercentile: 50, squeeze: 'ON' },
    });
    expect(items).toEqual([
      'the 1h Supertrend is against the trade',
      'the trigger candle is small (0.6 x ATR)',
      'the trigger candle closed far from its extreme (at 50% of its range)',
      'the MACD histogram does not support the trade',
      'the spread is wide (95th percentile)',
    ]);
  });

  it('does not call the OK line itself weak', () => {
    // a squeeze that is "none" is 0.7 and a session in Asia is 0.5: both are above the line
    expect(
      weak({
        volatility: { atrPercentile: 50, squeeze: 'NONE' },
        sessionMacro: { session: 'ASIA', news: { state: 'CLEAR', minutesToNext: null } },
      }),
    ).toEqual([]);
  });
});

describe('the sides', () => {
  it('judges a SELL against the chart that a SELL wants', () => {
    expect(weakItems('SELL', BUY_INPUTS)).toEqual([
      'the 1h EMAs are not all in the order of the trade',
      'the 1h EMA 50 slopes against the trade',
      'the 1h DI points against the trade',
      'the 1h Supertrend is against the trade',
      '15m and 5m structure do not agree with the trade (up / up)',
    ]);
  });

  it('words a shallow slope with its real sign for a SELL', () => {
    const down = {
      ema20: 4000,
      ema50: 4010,
      ema200: 4020,
      ema50SlopeAtr: -0.1,
      adx: 31,
      plusDI: 10,
      minusDI: 30,
      supertrend: 'DOWN',
    } as const;
    expect(weakItems('SELL', { ...NO_INPUTS, trend: down })).toEqual([
      'the 1h EMA 50 slope is shallow (-0.10 ATR(1h) in 3 h)',
    ]);
  });
});
