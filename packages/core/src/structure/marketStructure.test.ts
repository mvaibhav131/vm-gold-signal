import { describe, expect, it } from 'vitest';

import { MarketStructure, type MarketStructureUpdate } from './marketStructure';
import type { LiquidityLevel } from './sweeps';
import {
  candleAt,
  levelGrid,
  mirrored,
  randomCandles,
  series,
  TREND_POINTS,
  zigzag,
} from './test-data';
import { STRUCTURE_DEFAULTS, type StructureCandle } from './types';

function run(candles: readonly StructureCandle[], levels: readonly LiquidityLevel[] = []) {
  const structure = new MarketStructure();
  const updates = candles.map((candle) => structure.update(candle, levels));
  return { structure, updates };
}

const CANDLES = randomCandles(2026, 800);
const LEVELS = levelGrid(CANDLES);

describe('MarketStructure', () => {
  it('has an ATR from the 14th candle on and none before', () => {
    const { updates } = run(zigzag(TREND_POINTS));
    expect(updates.slice(0, 13).every((u) => u.atr === null)).toBe(true);
    expect(updates[13]?.atr).not.toBeNull();
  });

  it('runs the pivots, state and breaks of the zigzag as the tracker does', () => {
    const { structure, updates } = run(zigzag(TREND_POINTS));
    expect(updates.flatMap((u) => u.breaks).map((b) => [b.index, b.type, b.direction])).toEqual([
      [20, 'BOS', 'UP'],
      [26, 'BOS', 'UP'],
      [30, 'CHOCH', 'DOWN'],
      [35, 'BOS', 'DOWN'],
    ]);
    expect(updates[14]?.state).toBe('UP');
    expect(updates[35]?.state).toBe('DOWN');
    expect(structure.state).toBe('DOWN');
    expect(structure.highPivots).toHaveLength(6);
    expect(structure.lowPivots).toHaveLength(6);
    expect(structure.lastBos?.index).toBe(35);
    expect(structure.lastChoch?.index).toBe(30);
    expect(structure.count).toBe(40);
    expect(structure.swingK).toBe(2);
  });

  it('puts every pivot in the update of the candle that confirms it (index + k)', () => {
    const { updates } = run(CANDLES);
    let pivots = 0;
    updates.forEach((u) => {
      for (const pivot of [u.high, u.low]) {
        if (!pivot) continue;
        pivots += 1;
        expect(pivot.confirmedIndex).toBe(u.index);
        expect(pivot.index).toBe(u.index - STRUCTURE_DEFAULTS.swingK);
        expect(pivot.confirmedOpenTime).toBe(u.openTime);
      }
    });
    expect(pivots).toBeGreaterThan(100);
  });

  it('never looks ahead: the answers for a truncated history equal the start of the full run', () => {
    const full = run(CANDLES, LEVELS).updates;
    for (const cut of [40, 120, 333, 600]) {
      const truncated = run(CANDLES.slice(0, cut), LEVELS).updates;
      expect(JSON.stringify(truncated)).toBe(JSON.stringify(full.slice(0, cut)));
    }
  });

  it('is deterministic: the same candles give the same bytes', () => {
    expect(JSON.stringify(run(CANDLES, LEVELS).updates)).toBe(
      JSON.stringify(run(CANDLES, LEVELS).updates),
    );
  });

  it('shows all the primitives on a long random run (so the other tests are not vacuous)', () => {
    const { structure, updates } = run(CANDLES, LEVELS);
    const count = (pick: (u: MarketStructureUpdate) => number) =>
      updates.reduce((sum, u) => sum + pick(u), 0);
    expect(count((u) => u.breaks.filter((b) => b.type === 'BOS').length)).toBeGreaterThan(10);
    expect(count((u) => u.breaks.filter((b) => b.type === 'CHOCH').length)).toBeGreaterThan(10);
    expect(count((u) => (u.displacement ? 1 : 0))).toBeGreaterThan(10);
    expect(count((u) => (u.fvg.created ? 1 : 0))).toBeGreaterThan(10);
    expect(count((u) => u.fvg.filled.length)).toBeGreaterThan(5);
    expect(count((u) => (u.orderBlock.created ? 1 : 0))).toBeGreaterThan(5);
    expect(count((u) => u.sweeps.length)).toBeGreaterThan(2);
    expect(new Set(updates.map((u) => u.state)).size).toBe(4);
    expect(structure.lastDisplacement).not.toBeNull();
    expect(structure.lastSweep).not.toBeNull();
  });

  it('feeds the ATR to displacement, gaps and sweeps (a displacement and its gap, hand-checked)', () => {
    // 14 quiet candles of range 1, then a bearish candle, a small bullish one, and a big bullish one
    const quiet = Array.from({ length: 14 }, (): [number, number, number, number] => [
      100, 100.5, 99.5, 100,
    ]);
    const candles = series([
      ...quiet,
      [100, 100.2, 99.4, 99.5], // 14: down candle (the order block)
      [99.5, 99.9, 99.4, 99.8], // 15: small up candle
      [99.8, 101.6, 99.7, 101.5], // 16: displacement up, its low 99.7 is above the high of 14? no
    ]);
    const { structure, updates } = run(candles);
    expect(updates[16]?.displacement?.direction).toBe('UP');
    expect(updates[16]?.orderBlock.created).toMatchObject({
      direction: 'UP',
      index: 14,
      displacementIndex: 16,
    });
    expect(structure.lastDisplacement).toMatchObject({ index: 16, direction: 'UP' });
    expect(structure.activeBlocks).toHaveLength(1);
    expect(updates[16]?.fvg.created).toBeNull(); // candle 16 low 99.7 < candle 14 high 100.2: overlap
  });

  it('reports a sweep and reclaim at a supplied level, with the ATR of the sweep candle', () => {
    const quiet = Array.from({ length: 16 }, (): [number, number, number, number] => [
      100, 100.5, 99.5, 100,
    ]);
    const candles = series([
      ...quiet,
      [100.1, 100.2, 98.9, 100.1], // 16: low 98.9 is 0.6 below 99.5, wick 1.2 of 1.3, closes above it
    ]);
    const level: LiquidityLevel = { id: 'ASIA_LOW', side: 'LOW', price: 99.5 };
    const { updates, structure } = run(candles, [level]);
    expect(updates.slice(0, 16).every((u) => u.sweeps.length === 0)).toBe(true);
    const sweep = updates[16]?.sweeps[0];
    expect(sweep).toMatchObject({ direction: 'UP', levelId: 'ASIA_LOW', sweepIndex: 16 });
    expect(sweep?.depth).toBeCloseTo(0.6, 12);
    expect(sweep?.depthAtr).toBeCloseTo(0.6 / (updates[16]?.atr ?? 1), 12);
    expect(structure.lastSweep).toBe(sweep);
  });

  it('is symmetrical: a mirrored market gives mirrored structure', () => {
    const up = run(zigzag(TREND_POINTS)).updates;
    const down = run(zigzag(mirrored(TREND_POINTS))).updates;
    const flip = { UP: 'DOWN', DOWN: 'UP', RANGE: 'RANGE' } as const;
    expect(down.map((u) => (u.state ? flip[u.state] : null))).toEqual(up.map((u) => u.state));
    expect(down.map((u) => u.breaks.map((b) => b.type))).toEqual(
      up.map((u) => u.breaks.map((b) => b.type)),
    );
  });

  it('refuses malformed candles and candles out of order', () => {
    const structure = new MarketStructure();
    expect(() => structure.update(candleAt(0, 1, Number.NaN, 1, 1))).toThrow(RangeError);
    structure.update(candleAt(2, 1, 2, 1, 1));
    expect(() => structure.update(candleAt(1, 1, 2, 1, 1))).toThrow(RangeError);
    expect(structure.count).toBe(1);
  });

  it('takes other settings: k = 3 needs seven candles for its first pivot', () => {
    const structure = new MarketStructure({ ...STRUCTURE_DEFAULTS, swingK: 3 });
    const updates = zigzag(TREND_POINTS, 4).map((c) => structure.update(c));
    const first = updates.find((u) => u.high ?? u.low);
    expect(first?.index).toBe(4 + 3);
    expect(structure.swingK).toBe(3);
  });
});
