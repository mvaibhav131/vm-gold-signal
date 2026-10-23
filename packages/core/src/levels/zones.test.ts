import { describe, expect, it } from 'vitest';

import { buildZones, zoneDistanceAtr, type CloseSample, type ZoneSource } from './zones';
import { FIVE_MINUTES, at, pivot } from './test-data';
import type { ZoneTimeframe } from './types';

// ATR 2: cluster tolerance 0.25 x 2 = 0.5, padding 0.05 x 2 = 0.1, flip distance 0.2 x 2 = 0.4.
const ATR = 2;
const BASE = at('2026-10-21T00:00');
const when = (index: number) => BASE + index * FIVE_MINUTES;
const close = (index: number, c: number): CloseSample => ({ openTime: when(index), c });

const source = (
  tf: ZoneTimeframe,
  count: number,
  pivots: ReturnType<typeof pivot>[],
): ZoneSource => ({ tf, count, pivots });

/** Two 15m swing highs at 4010.0 and 4010.3: the zone is 4009.9 - 4010.4. */
const RESISTANCE = [source('15m', 200, [pivot('HIGH', 4010.0, 150), pivot('HIGH', 4010.3, 180)])];

const weight = (tf: ZoneTimeframe, count: number, index: number) =>
  ({ '5m': 1, '15m': 2, '1h': 3 })[tf] * 0.5 ** ((count - 1 - index) / 100);

describe('buildZones: clustering', () => {
  it('turns two swing points within 0.25 x ATR into a zone padded by 0.05 x ATR (hand-checked)', () => {
    const zones = buildZones({ sources: RESISTANCE, closes: [], atr: ATR });
    expect(zones).toHaveLength(1);
    const zone = zones[0];
    expect(zone?.bottom).toBeCloseTo(4009.9, 9);
    expect(zone?.top).toBeCloseTo(4010.4, 9);
    expect(zone).toMatchObject({
      id: 'zone:15m:150',
      touches: 2,
      role: 'RESISTANCE',
      baseRole: 'RESISTANCE',
      flipped: false,
      timeframes: ['15m'],
    });
    expect(zone?.strength).toBeCloseTo(weight('15m', 200, 150) + weight('15m', 200, 180), 12);
    expect(zone?.points.map((p) => p.index)).toEqual([150, 180]);
    expect(zone?.newestOpenTime).toBe(when(180));
  });

  it('weights points by timeframe (1h 3, 15m 2, 5m 1) and halves the weight every 100 candles', () => {
    const zones = buildZones({
      sources: [
        source('5m', 300, [pivot('LOW', 3990.0, 250)]),
        source('1h', 150, [pivot('LOW', 3990.2, 100)]),
      ],
      closes: [],
      atr: ATR,
    });
    expect(zones).toHaveLength(1);
    expect(zones[0]?.strength).toBeCloseTo(weight('5m', 300, 250) + weight('1h', 150, 100), 12);
    expect(zones[0]?.timeframes).toEqual(['5m', '1h']);
    expect(zones[0]?.role).toBe('SUPPORT');
    expect(zones[0]?.id).toBe('zone:1h:100');
    // a point exactly 100 candles old weighs half of a fresh one
    expect(weight('15m', 201, 100)).toBeCloseTo(weight('15m', 101, 100) / 2, 12);
  });

  it('only uses swing points of the last 300 5m, 200 15m and 150 1h candles', () => {
    const near = (tf: ZoneTimeframe, count: number, index: number) =>
      buildZones({
        sources: [
          source(tf, count, [pivot('HIGH', 4010, index), pivot('HIGH', 4010.1, count - 5)]),
        ],
        closes: [],
        atr: ATR,
      });
    expect(near('5m', 400, 100)).toHaveLength(1); // index 100 is the oldest one inside 300 candles
    expect(near('5m', 400, 99)).toHaveLength(0);
    expect(near('15m', 300, 100)).toHaveLength(1);
    expect(near('15m', 300, 99)).toHaveLength(0);
    expect(near('1h', 200, 50)).toHaveLength(1);
    expect(near('1h', 200, 49)).toHaveLength(0);
  });

  it('grows a cluster from the lowest price upward and never wider than the tolerance', () => {
    const zones = buildZones({
      sources: [
        source('5m', 300, [
          pivot('HIGH', 4000.0, 250),
          pivot('LOW', 4000.4, 260),
          pivot('HIGH', 4000.8, 270),
        ]),
      ],
      closes: [],
      atr: ATR,
    });
    // 4000.4 is 0.4 above 4000.0; 4000.8 is 0.8 above it, so it is left out
    expect(zones).toHaveLength(1);
    expect(zones[0]?.points.map((p) => p.price)).toEqual([4000.0, 4000.4]);
  });

  it('counts a distance of exactly 0.25 x ATR (despite float noise) and no more', () => {
    const pair = (second: number) =>
      buildZones({
        sources: [source('5m', 300, [pivot('HIGH', 4010, 250), pivot('HIGH', second, 260)])],
        closes: [],
        atr: ATR,
      });
    expect(pair(4010.5)).toHaveLength(1);
    expect(pair(4010.51)).toHaveLength(0);
  });

  it('needs two points: a lone swing point is no zone', () => {
    expect(
      buildZones({
        sources: [source('15m', 200, [pivot('HIGH', 4010, 150), pivot('LOW', 3990, 160)])],
        closes: [],
        atr: ATR,
      }),
    ).toEqual([]);
    expect(
      buildZones({
        sources: [source('15m', 200, [pivot('HIGH', 4010, 150)])],
        closes: [],
        atr: ATR,
      }),
    ).toEqual([]);
  });

  it('takes the minimum number of points from the parameters', () => {
    const params = { ...baseParams(), minPoints: 3 };
    expect(buildZones({ sources: RESISTANCE, closes: [], atr: ATR, params })).toEqual([]);
  });

  it('lists the strongest zone first', () => {
    const zones = buildZones({
      sources: [
        source('15m', 200, [pivot('HIGH', 4010, 150), pivot('HIGH', 4010.1, 160)]),
        source('1h', 150, [pivot('LOW', 3990, 140), pivot('LOW', 3990.1, 145)]),
      ],
      closes: [],
      atr: ATR,
    });
    expect(zones.map((z) => z.timeframes[0])).toEqual(['1h', '15m']);
    expect(zones[0]?.strength).toBeGreaterThan(zones[1]?.strength ?? 0);
  });

  it('finds nothing without an ATR', () => {
    expect(buildZones({ sources: RESISTANCE, closes: [], atr: null })).toEqual([]);
    expect(buildZones({ sources: RESISTANCE, closes: [], atr: 0 })).toEqual([]);
  });
});

function baseParams() {
  return {
    toleranceAtr: 0.25,
    padAtr: 0.05,
    flipAtr: 0.2,
    minPoints: 2,
    halfLife: 100,
    windows: { '5m': 300, '15m': 200, '1h': 150 },
    weights: { '5m': 1, '15m': 2, '1h': 3 },
  } as const;
}

describe('buildZones: role and flip', () => {
  const role = (closes: CloseSample[], sources = RESISTANCE) => {
    const zone = buildZones({ sources, closes, atr: ATR })[0];
    return zone && [zone.role, zone.baseRole, zone.flipped];
  };

  it('is resistance when most points are swing highs and support when most are swing lows', () => {
    expect(role([])).toEqual(['RESISTANCE', 'RESISTANCE', false]);
    expect(
      role([], [source('15m', 200, [pivot('LOW', 3990.0, 150), pivot('LOW', 3990.2, 180)])]),
    ).toEqual(['SUPPORT', 'SUPPORT', false]);
  });

  it('flips to support after a close above the zone by 0.2 x ATR (zone top 4010.4, so 4010.8)', () => {
    expect(role([close(190, 4010.7)])).toEqual(['RESISTANCE', 'RESISTANCE', false]);
    expect(role([close(190, 4010.8)])).toEqual(['SUPPORT', 'RESISTANCE', true]);
    expect(role([close(190, 4011.5)])).toEqual(['SUPPORT', 'RESISTANCE', true]);
  });

  it('flips a support zone to resistance after a close below it by 0.2 x ATR (bottom 3989.9, so 3989.5)', () => {
    const support = [source('15m', 200, [pivot('LOW', 3990.0, 150), pivot('LOW', 3990.2, 180)])];
    expect(role([close(190, 3989.6)], support)).toEqual(['SUPPORT', 'SUPPORT', false]);
    expect(role([close(190, 3989.5)], support)).toEqual(['RESISTANCE', 'SUPPORT', true]);
    expect(role([close(190, 3995)], support)).toEqual(['SUPPORT', 'SUPPORT', false]);
  });

  it('is decided by the latest close beyond the zone, so it can flip back', () => {
    expect(role([close(190, 4011), close(195, 4009)])).toEqual(['RESISTANCE', 'RESISTANCE', false]);
    expect(role([close(190, 4009), close(195, 4011)])).toEqual(['SUPPORT', 'RESISTANCE', true]);
    // a later close inside the zone does not undo the flip
    expect(role([close(190, 4011), close(195, 4010.2)])).toEqual(['SUPPORT', 'RESISTANCE', true]);
  });

  it('ignores closes up to the candle of its newest swing point', () => {
    expect(role([close(170, 4012), close(180, 4012)])).toEqual(['RESISTANCE', 'RESISTANCE', false]);
    expect(role([close(181, 4012)])).toEqual(['SUPPORT', 'RESISTANCE', true]);
  });

  it('follows the latest close when highs and lows are equal in number', () => {
    const mixed = [source('15m', 200, [pivot('HIGH', 4010.0, 150), pivot('LOW', 4010.3, 180)])];
    // the zone is 4009.9 - 4010.4, its middle 4010.15; these closes are inside it
    expect(role([close(190, 4010.3)], mixed)).toEqual(['SUPPORT', 'SUPPORT', false]);
    expect(role([close(190, 4010.0)], mixed)).toEqual(['RESISTANCE', 'RESISTANCE', false]);
    expect(role([], mixed)).toEqual(['RESISTANCE', 'RESISTANCE', false]);
  });
});

describe('buildZones: random swing points', () => {
  it('every zone is a cluster of two or more points inside the tolerance, with no point used twice', () => {
    let state = 99;
    const random = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
    const timeframes: ZoneTimeframe[] = ['5m', '15m', '1h'];
    const windows = { '5m': 300, '15m': 200, '1h': 150 };
    let zonesSeen = 0;
    for (let round = 0; round < 40; round += 1) {
      const sources = timeframes.map((tf) =>
        source(
          tf,
          400,
          Array.from({ length: 25 }, (_, i) =>
            pivot(random() < 0.5 ? 'HIGH' : 'LOW', 4000 + random() * 3, 20 + i * 15),
          ),
        ),
      );
      const zones = buildZones({ sources, closes: [], atr: ATR });
      const used = new Set<string>();
      for (const zone of zones) {
        zonesSeen += 1;
        expect(zone.points.length).toBeGreaterThanOrEqual(2);
        const prices = zone.points.map((p) => p.price);
        expect(Math.max(...prices) - Math.min(...prices)).toBeLessThanOrEqual(0.5 + 1e-9);
        expect(zone.bottom).toBeCloseTo(Math.min(...prices) - 0.1, 9);
        expect(zone.top).toBeCloseTo(Math.max(...prices) + 0.1, 9);
        expect(zone.touches).toBe(zone.points.length);
        const expected = zone.points.reduce((sum, p) => sum + weight(p.tf, 400, p.index), 0);
        expect(zone.strength).toBeCloseTo(expected, 9);
        for (const p of zone.points) {
          expect(p.index).toBeGreaterThanOrEqual(400 - windows[p.tf]);
          const key = `${p.tf}${p.kind}${String(p.index)}`;
          expect(used.has(key)).toBe(false);
          used.add(key);
        }
      }
      const strengths = zones.map((z) => z.strength);
      expect(strengths).toEqual([...strengths].sort((a, b) => b - a));
    }
    expect(zonesSeen).toBeGreaterThan(50);
  });
});

describe('zoneDistanceAtr', () => {
  const zone = { bottom: 100, top: 101 };
  it('is 0 inside the zone and the gap in ATRs outside it', () => {
    expect(zoneDistanceAtr(zone, 100.5, 2)).toBe(0);
    expect(zoneDistanceAtr(zone, 100, 2)).toBe(0);
    expect(zoneDistanceAtr(zone, 103, 2)).toBe(1);
    expect(zoneDistanceAtr(zone, 98, 2)).toBe(1);
  });

  it('refuses an ATR that is not above zero', () => {
    expect(() => zoneDistanceAtr(zone, 100, 0)).toThrow(RangeError);
  });
});
