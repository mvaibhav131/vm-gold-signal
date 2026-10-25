import { describe, expect, it } from 'vitest';

import type { MacroProximity } from '../context/macro';
import type { Zone } from '../levels/zones';
import type { RegimeSnapshot } from '../regime/types';
import type { Trendline } from '../trendlines/lines';
import { chartObjectsOf, confluenceOf, levelRoomOf, qualityInputsOf } from './inputs';
import type { MarketView } from './market';
import type { Candidate } from './types';
import { BASE, engineAt, pullbackSpec } from './test-data';

const T = Date.UTC(2026, 0, 6, 14, 0);

const line = (side: 'SUPPORT' | 'RESISTANCE', price: number, slope = 0): Trendline =>
  ({
    id: `15m${side === 'SUPPORT' ? 'S' : 'R'}:1:9`,
    side,
    a: { openTime: T - 3_600_000, price },
    b: { openTime: T - 1_800_000, price: price + slope * 2 },
    slope,
    candleMs: 900_000,
    touches: 3,
    confirmed: true,
    score: 8.5,
  }) as unknown as Trendline;

const zone = (
  id: string,
  role: 'SUPPORT' | 'RESISTANCE',
  bottom: number,
  top: number,
  touches = 3,
  strength = 5,
): Zone =>
  ({
    id,
    role,
    baseRole: role,
    flipped: false,
    bottom,
    top,
    touches,
    strength,
    timeframes: ['15m'],
    points: [{ openTime: T - 7_200_000 }, { openTime: T - 3_600_000 }],
    newestOpenTime: T - 3_600_000,
  }) as unknown as Zone;

const regime = (change: Partial<RegimeSnapshot['inputs']> = {}): RegimeSnapshot => ({
  regime: 'TREND_UP',
  direction: 'UP',
  matched: ['TREND_UP'],
  volBucket: 'NORMAL',
  inputs: {
    emaFast: 1,
    emaMid: 1,
    emaSlow: 1,
    adx1h: 25,
    efficiency1h: 0.4,
    atr15m: 3,
    atrPercentile15m: 55,
    rangeWidth15m: 20,
    squeezeDuration: 0,
    releasedBarsAgo: null,
    displacementBarsAgo: null,
    displacementDirection: null,
    ...change,
  },
});

/** A market as of 14:00 with an ATR(5m) of 2 and an ATR(15m) of 4. */
function viewOf(change: Partial<MarketView> = {}, zones: readonly Zone[] = []): MarketView {
  return {
    openTime: T - 300_000,
    close: 4072,
    candle: { openTime: T - 300_000, o: 4070, h: 4073, l: 4069, c: 4072, spread: 0.1 },
    atr5: 2,
    atr15: 4,
    regime: regime(),
    trend: {
      ema20: 4060,
      ema50: 4050,
      ema200: 4000,
      ema50SlopeAtr: 0.4,
      adx: 28,
      plusDI: 30,
      minusDI: 12,
      supertrend: 'UP',
    },
    state15: 'UP',
    state5: 'UP',
    latestBreak: null,
    rsi: { now: 55, lowest: 38, highest: 66 },
    macdRun: 3,
    atrBaseline: 2,
    spreadBaseline: 0.12,
    liquidity: [],
    support15: null,
    resistance15: null,
    spreadPercentile: () => 35,
    zones: () => zones,
    fiveOpenTimes: [],
    ...change,
  };
}

const candidate = base();
function base(): Candidate {
  const found = engineAt(BASE, [pullbackSpec()], 53).candidates()[0];
  if (found === undefined) throw new Error('no candidate');
  return found;
}

const plan = { entry: 4072.3, riskDistance: 2, tp1: 4074.3 };
const args = (change: Record<string, unknown> = {}) => ({
  candidate,
  side: 'BUY' as const,
  view: viewOf(),
  plan,
  session: 'OVERLAP' as const,
  proximity: null,
  newsState: 'CLEAR' as const,
  spread: 0.12,
  ...change,
});

describe('confluenceOf', () => {
  it('cannot be told without an ATR(15m)', () => {
    expect(confluenceOf('BUY', 4072, viewOf({ atr15: null }))).toBeNull();
  });

  it('counts the support line of a BUY within half an ATR(15m) of the entry, and not a far one', () => {
    expect(confluenceOf('BUY', 4072, viewOf({ support15: line('SUPPORT', 4071) }))).toBe(1);
    expect(confluenceOf('BUY', 4072, viewOf({ support15: line('SUPPORT', 4069.9) }))).toBe(0);
    expect(confluenceOf('BUY', 4072, viewOf({ support15: line('SUPPORT', 4070) }))).toBe(1);
  });

  it('reads the line where it is now: a rising line is higher now than at its first point', () => {
    const rising = line('SUPPORT', 4060, 1);
    expect(confluenceOf('BUY', 4072, viewOf({ support15: rising }))).toBe(0);
    expect(confluenceOf('BUY', 4064, viewOf({ support15: rising }))).toBe(1);
  });

  it('uses the resistance line and the resistance zones for a SELL, never the support ones', () => {
    const view = viewOf(
      { support15: line('SUPPORT', 4072), resistance15: line('RESISTANCE', 4072.5) },
      [zone('s', 'SUPPORT', 4071, 4073), zone('r', 'RESISTANCE', 4071.5, 4073)],
    );
    expect(confluenceOf('SELL', 4072, view)).toBe(2);
    expect(confluenceOf('BUY', 4072, view)).toBe(2);
  });

  it('counts a zone that holds the entry or lies within half an ATR(15m) of it', () => {
    const zones = [
      zone('inside', 'SUPPORT', 4070, 4074),
      zone('near', 'SUPPORT', 4065, 4070.1),
      zone('far', 'SUPPORT', 4060, 4066),
      zone('above', 'SUPPORT', 4074.1, 4076),
    ];
    expect(confluenceOf('BUY', 4072, viewOf({}, zones))).toBe(2);
  });

  it('adds the line to the zones', () => {
    const view = viewOf({ support15: line('SUPPORT', 4072) }, [zone('z', 'SUPPORT', 4071, 4073)]);
    expect(confluenceOf('BUY', 4072, view)).toBe(2);
  });

  it('counts a zone whose edge is exactly half an ATR(15m) from the entry, on either side, and not one cent further', () => {
    const at = (...zones: Zone[]) => confluenceOf('BUY', 4072, viewOf({}, zones));
    expect(at(zone('below', 'SUPPORT', 4066, 4070))).toBe(1);
    expect(at(zone('above', 'SUPPORT', 4074, 4076))).toBe(1);
    expect(at(zone('below', 'SUPPORT', 4066, 4069.99))).toBe(0);
    expect(at(zone('above', 'SUPPORT', 4074.01, 4076))).toBe(0);
  });
});

describe('levelRoomOf', () => {
  it('needs a target distance', () => {
    expect(levelRoomOf('BUY', 4072, 0, viewOf(), null)).toBeNull();
  });

  it('is the distance to the nearest liquidity level ahead over the distance to TP1', () => {
    const view = viewOf({ liquidity: [{ id: 'PDH', side: 'HIGH', price: 4076 }] });
    expect(levelRoomOf('BUY', 4072, 2, view, null)).toBe(2);
    const down = viewOf({ liquidity: [{ id: 'PDL', side: 'LOW', price: 4068 }] });
    expect(levelRoomOf('SELL', 4072, 2, down, null)).toBe(2);
  });

  it('takes the nearest of several, and ignores a level behind the entry or at it', () => {
    const view = viewOf({
      liquidity: [
        { id: 'far', side: 'HIGH', price: 4090 },
        { id: 'near', side: 'HIGH', price: 4075 },
        { id: 'behind', side: 'LOW', price: 4070 },
        { id: 'at', side: 'HIGH', price: 4072 },
      ],
    });
    expect(levelRoomOf('BUY', 4072, 1.5, view, null)).toBe(2);
  });

  it('leaves out the level that the setup sweeps', () => {
    const view = viewOf({
      liquidity: [
        { id: 'swept', side: 'HIGH', price: 4073 },
        { id: 'next', side: 'HIGH', price: 4078 },
      ],
    });
    expect(levelRoomOf('BUY', 4072, 3, view, 'swept')).toBe(2);
    expect(levelRoomOf('BUY', 4072, 3, view, null)).toBeCloseTo(1 / 3, 9);
  });

  it('counts a zone only from three touches, by its near edge', () => {
    const strong = viewOf({}, [zone('z', 'RESISTANCE', 4075, 4079, 3)]);
    expect(levelRoomOf('BUY', 4072, 3, strong, null)).toBe(1);
    const weak = viewOf({}, [zone('z', 'RESISTANCE', 4075, 4079, 2)]);
    expect(levelRoomOf('BUY', 4072, 3, weak, null)).toBeGreaterThan(5);
    const below = viewOf({}, [zone('z', 'SUPPORT', 4061, 4065, 4)]);
    expect(levelRoomOf('SELL', 4072, 4, below, null)).toBe(1.75);
  });

  it('counts the round numbers of 50 and 100, and not those of 10', () => {
    expect(levelRoomOf('BUY', 4072, 4, viewOf(), null)).toBe(7);
    expect(levelRoomOf('SELL', 4072, 4, viewOf(), null)).toBe(5.5);
    // 4080 is a round 10 and is not a level
    expect(levelRoomOf('BUY', 4072, 1, viewOf(), null)).toBe(28);
  });
});

describe('qualityInputsOf', () => {
  it('reads a BUY: the trend of the 1h, the states, the newest break, the trigger candle and the reward', () => {
    const view = viewOf({
      latestBreak: { type: 'BOS', direction: 'UP' } as unknown as MarketView['latestBreak'],
      support15: line('SUPPORT', 4072),
    });
    const inputs = qualityInputsOf(args({ view }));
    expect(inputs.trend).toBe(view.trend);
    expect(inputs.structure).toEqual({
      state15m: 'UP',
      state5m: 'UP',
      breakEvent: 'WITH',
      sweep: null,
      confluence: 1,
      patternMoveR: null,
    });
    expect(inputs.trigger).toEqual({
      rangeAtr: 2,
      closeLocation: 0.75,
      rsiNow: 55,
      rsiExtreme: 38,
      macdBars: 3,
    });
    expect(inputs.volatility).toEqual({ atrPercentile: 55, squeeze: 'NONE' });
    expect(inputs.execution).toEqual({ spreadPercentile: 35, stopAtr: 1 });
    expect(inputs.sessionMacro).toEqual({
      session: 'OVERLAP',
      news: { state: 'CLEAR', minutesToNext: null },
    });
    expect(inputs.reward.tp1Atr).toBe(1);
    expect(inputs.reward.levelRoom).toBeCloseTo(13.85, 9);
  });

  it('reads a SELL with the high of the RSI as the extreme, and a break the other way as against', () => {
    const view = viewOf({
      latestBreak: { type: 'BOS', direction: 'UP' } as unknown as MarketView['latestBreak'],
    });
    const inputs = qualityInputsOf(args({ side: 'SELL', view }));
    expect(inputs.trigger.rsiExtreme).toBe(66);
    expect(inputs.structure.breakEvent).toBe('AGAINST');
  });

  it('says no break when there was none lately, and nothing while the 5m structure is unknown', () => {
    expect(qualityInputsOf(args()).structure.breakEvent).toBe('NONE');
    expect(
      qualityInputsOf(args({ view: viewOf({ state5: null }) })).structure.breakEvent,
    ).toBeNull();
  });

  it('gives the squeeze: on while it lasts, released for six candles, then none', () => {
    const squeeze = (change: Partial<RegimeSnapshot['inputs']>) =>
      qualityInputsOf(args({ view: viewOf({ regime: regime(change) }) })).volatility.squeeze;
    expect(squeeze({ squeezeDuration: 9 })).toBe('ON');
    expect(squeeze({ squeezeDuration: 1 })).toBe('ON');
    expect(squeeze({ releasedBarsAgo: 0 })).toBe('RELEASED');
    expect(squeeze({ releasedBarsAgo: 5 })).toBe('RELEASED');
    expect(squeeze({ releasedBarsAgo: 6 })).toBe('NONE');
    expect(squeeze({})).toBe('NONE');
    expect(qualityInputsOf(args({ view: viewOf({ regime: null }) })).volatility).toEqual({
      atrPercentile: null,
      squeeze: null,
    });
  });

  it('takes the sweep of strategy B and the measured move of strategy E, and no other', () => {
    const sweep = {
      ...candidate,
      source: {
        strategyKey: 'sweep_reversal',
        facts: { depthAtr: 0.4, wickRatio: 0.7 },
      },
    } as unknown as Candidate;
    expect(qualityInputsOf(args({ candidate: sweep })).structure.sweep).toEqual({
      depthAtr: 0.4,
      wickRatio: 0.7,
    });
    const pattern = {
      ...candidate,
      source: { strategyKey: 'pattern_breakout', facts: { measuredMoveR: 2.4 } },
    } as unknown as Candidate;
    const inputs = qualityInputsOf(args({ candidate: pattern }));
    expect(inputs.structure.patternMoveR).toBe(2.4);
    expect(inputs.structure.sweep).toBeNull();
  });

  it('puts a candle with no range in the middle, and has no size without an ATR', () => {
    const flat = viewOf({
      candle: { openTime: T, o: 4072, h: 4072, l: 4072, c: 4072, spread: null },
      atr5: null,
    });
    const inputs = qualityInputsOf(args({ view: flat }));
    expect(inputs.trigger.closeLocation).toBe(0.5);
    expect(inputs.trigger.rangeAtr).toBeNull();
    expect(inputs.execution.stopAtr).toBeNull();
    expect(inputs.reward.tp1Atr).toBeNull();
  });

  it('carries the news state and the minutes to the next event', () => {
    const proximity = { minutesToNext: 90 } as unknown as MacroProximity;
    expect(qualityInputsOf(args({ proximity, newsState: 'IN_WINDOW' })).sessionMacro.news).toEqual({
      state: 'IN_WINDOW',
      minutesToNext: 90,
    });
    expect(qualityInputsOf(args({ newsState: 'UNKNOWN' })).sessionMacro.news).toEqual({
      state: 'UNKNOWN',
      minutesToNext: null,
    });
  });
});

describe('chartObjectsOf', () => {
  it('draws the 15m support and resistance lines through their two points and where they are now', () => {
    const view = viewOf({
      support15: line('SUPPORT', 4060, 0.5),
      resistance15: line('RESISTANCE', 4090, -0.5),
    });
    const objects = chartObjectsOf(candidate, 4072, view);
    expect(objects.map((object) => object.type)).toEqual(['trendline', 'trendline']);
    const [support] = objects;
    expect(support).toMatchObject({
      tf: '15m',
      meta: { side: 'SUPPORT', touches: 3, confirmed: true },
    });
    const prices = support?.points.map((point) => point.price) ?? [];
    expect(prices.slice(0, 2)).toEqual([4060, 4061]);
    expect(prices[2]).toBeCloseTo(4060 + (0.5 * 55) / 15, 3);
    expect(support?.points.map((point) => point.t)).toEqual([
      new Date(T - 3_600_000).toISOString(),
      new Date(T - 1_800_000).toISOString(),
      new Date(T - 300_000).toISOString(),
    ]);
  });

  it('draws the zones within three ATR(15m) of the entry, the nearest four, nearest first', () => {
    const zones = [
      zone('a', 'SUPPORT', 4059, 4061),
      zone('b', 'SUPPORT', 4065, 4068),
      zone('c', 'RESISTANCE', 4075, 4078),
      zone('d', 'RESISTANCE', 4071, 4073),
      zone('e', 'SUPPORT', 4062, 4064),
      zone('f', 'RESISTANCE', 4090, 4095),
    ];
    const objects = chartObjectsOf(candidate, 4072, viewOf({}, zones));
    expect(objects.map((object) => object.id)).toEqual(['d', 'c', 'b', 'e']);
    expect(objects[0]).toMatchObject({
      type: 'zone',
      meta: { role: 'RESISTANCE', touches: 3, flipped: false },
    });
    expect(objects[0]?.points.map((point) => point.price)).toEqual([4071, 4073]);
  });

  it('draws the zones up to exactly three ATR(15m) from the entry and no further, and the stronger of two equally near first', () => {
    const zones = [
      zone('edge', 'RESISTANCE', 4084, 4086),
      zone('beyond', 'RESISTANCE', 4084.01, 4086),
      zone('weak', 'SUPPORT', 4060, 4070, 3, 3),
      zone('strong', 'RESISTANCE', 4074, 4078, 3, 9),
    ];
    const objects = chartObjectsOf(candidate, 4072, viewOf({}, zones));
    expect(objects.map((object) => object.id)).toEqual(['strong', 'weak', 'edge']);
  });

  it('draws no zone without an ATR(15m)', () => {
    expect(
      chartObjectsOf(candidate, 4072, viewOf({ atr15: null }, [zone('z', 'SUPPORT', 4071, 4073)])),
    ).toEqual([]);
  });

  it('draws the pattern of strategy E with its boundary and its target', () => {
    const pattern = {
      ...candidate,
      setup: { ...candidate.setup, setupKey: 'pattern_breakout:15m:x' },
      source: {
        strategyKey: 'pattern_breakout',
        facts: {
          pattern: 'TRIANGLE_ASC',
          patternFrom: T - 7_200_000,
          patternTo: T - 900_000,
          level: 4075,
          target: 4090,
          measuredMoveR: 2.1,
        },
      },
    } as unknown as Candidate;
    const [object] = chartObjectsOf(pattern, 4072, viewOf());
    expect(object).toMatchObject({
      id: 'pattern:pattern_breakout:15m:x',
      type: 'pattern',
      tf: '15m',
      meta: { pattern: 'TRIANGLE_ASC', level: 4075, target: 4090, measuredMoveR: 2.1 },
    });
    expect(object?.points.map((point) => point.price)).toEqual([4075, 4075]);
  });
});
