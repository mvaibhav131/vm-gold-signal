import { describe, expect, it } from 'vitest';

import { findEqualLevels } from './equalLevels';
import { pivot } from './test-data';

// ATR 2 -> the tolerance is 0.15 x 2 = 0.3, and the lookback is 100 candles.
const base = { atr: 2, count: 200 };

describe('findEqualLevels', () => {
  it('groups swing highs within 0.15 x ATR and leaves out the one beyond it (hand-checked)', () => {
    const levels = findEqualLevels({
      ...base,
      pivots: [pivot('HIGH', 4010.0, 150), pivot('HIGH', 4010.2, 170), pivot('HIGH', 4010.5, 180)],
    });
    expect(levels).toHaveLength(1);
    // from the lowest price upward: 4010.2 is 0.2 above 4010.0, 4010.5 is 0.5 above it
    expect(levels[0]).toMatchObject({
      side: 'HIGH',
      price: 4010.2,
      touches: 2,
      firstIndex: 150,
      lastIndex: 170,
      id: 'EQH:150',
    });
    expect(levels[0]?.spread).toBeCloseTo(0.2, 9);
    expect(levels[0]?.members.map((p) => p.index)).toEqual([150, 170]);
  });

  it('puts the liquidity of equal lows at the lowest of them', () => {
    const levels = findEqualLevels({
      ...base,
      pivots: [pivot('LOW', 3990.1, 190), pivot('LOW', 3990.0, 160)],
    });
    expect(levels).toHaveLength(1);
    expect(levels[0]).toMatchObject({ side: 'LOW', price: 3990, id: 'EQL:160', touches: 2 });
  });

  it('keeps highs and lows apart even at the same price', () => {
    expect(
      findEqualLevels({ ...base, pivots: [pivot('HIGH', 4000, 150), pivot('LOW', 4000.1, 170)] }),
    ).toEqual([]);
  });

  it('counts a distance of exactly 0.15 x ATR as equal, despite float noise', () => {
    // 4010.3 - 4010 is 0.30000000000018 in floating point
    expect(
      findEqualLevels({ ...base, pivots: [pivot('HIGH', 4010, 150), pivot('HIGH', 4010.3, 170)] }),
    ).toHaveLength(1);
    expect(
      findEqualLevels({ ...base, pivots: [pivot('HIGH', 4010, 150), pivot('HIGH', 4010.31, 170)] }),
    ).toEqual([]);
  });

  it('only looks at the last `lookback` candles', () => {
    const pivots = [pivot('HIGH', 4010, 99), pivot('HIGH', 4010.1, 170)];
    expect(findEqualLevels({ ...base, pivots })).toEqual([]);
    expect(
      findEqualLevels({ ...base, pivots: [pivot('HIGH', 4010, 100), pivot('HIGH', 4010.1, 170)] }),
    ).toHaveLength(1);
  });

  it('finds several groups, the most recent first, and three or more touches', () => {
    const levels = findEqualLevels({
      ...base,
      pivots: [
        pivot('HIGH', 4020.0, 120),
        pivot('HIGH', 4020.1, 130),
        pivot('HIGH', 4010.0, 150),
        pivot('HIGH', 4010.1, 160),
        pivot('HIGH', 4010.2, 190),
      ],
    });
    expect(levels.map((l) => [l.id, l.touches, l.price])).toEqual([
      ['EQH:150', 3, 4010.2],
      ['EQH:120', 2, 4020.1],
    ]);
  });

  it('can be tagged by timeframe, and asked for more points', () => {
    const pivots = [pivot('HIGH', 4010, 150), pivot('HIGH', 4010.1, 170)];
    expect(findEqualLevels({ ...base, pivots, tag: '5m' })[0]?.id).toBe('5mEQH:150');
    expect(
      findEqualLevels({
        ...base,
        pivots,
        params: { toleranceAtr: 0.15, lookback: 100, minPoints: 3 },
      }),
    ).toEqual([]);
  });

  it('finds nothing without an ATR or without two points', () => {
    const pivots = [pivot('HIGH', 4010, 150), pivot('HIGH', 4010.1, 170)];
    expect(findEqualLevels({ ...base, atr: null, pivots })).toEqual([]);
    expect(findEqualLevels({ ...base, atr: 0, pivots })).toEqual([]);
    expect(findEqualLevels({ ...base, pivots: [pivot('HIGH', 4010, 150)] })).toEqual([]);
    expect(findEqualLevels({ ...base, pivots: [] })).toEqual([]);
  });

  it('never makes a group wider than the tolerance, and never uses a point twice (random points)', () => {
    let state = 12345;
    const random = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
    for (let round = 0; round < 50; round += 1) {
      const pivots = Array.from({ length: 30 }, (_, i) =>
        pivot(random() < 0.5 ? 'HIGH' : 'LOW', 4000 + random() * 2, 100 + i * 3),
      );
      const levels = findEqualLevels({ ...base, pivots });
      const used = new Set<string>();
      for (const level of levels) {
        expect(level.spread).toBeLessThanOrEqual(0.3 + 1e-9);
        expect(level.members.length).toBeGreaterThanOrEqual(2);
        for (const member of level.members) {
          const key = `${member.kind}${String(member.index)}`;
          expect(used.has(key)).toBe(false);
          used.add(key);
        }
      }
      // a point left out has no neighbour within the tolerance above it (clusters start at the lowest)
      for (const kind of ['HIGH', 'LOW'] as const) {
        const sorted = pivots.filter((p) => p.kind === kind).sort((a, b) => a.price - b.price);
        sorted.forEach((p, n) => {
          if (used.has(`${kind}${String(p.index)}`)) return;
          const next = sorted[n + 1];
          if (next) expect(next.price - p.price).toBeGreaterThan(0.3 - 1e-9);
        });
      }
    }
  });
});
