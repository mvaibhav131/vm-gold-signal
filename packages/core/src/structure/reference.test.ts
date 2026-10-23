import { describe, expect, it } from 'vitest';

import { MarketStructure, type MarketStructureUpdate } from './marketStructure';
import { levelGrid, randomCandles } from './test-data';
import {
  STRUCTURE_DEFAULTS,
  type Direction,
  type Pivot,
  type StructureCandle,
  type StructureParams,
  type StructureState,
} from './types';

// The same definitions as docs/02 section 4, written the naive way: whole arrays, slices, scans
// forward and backward, no streaming state. If the streaming classes and these agree on long random
// runs, the window and bookkeeping logic is right.

const PARAMS: StructureParams = {
  ...STRUCTURE_DEFAULTS,
  keptPivots: 100_000,
  fvg: { ...STRUCTURE_DEFAULTS.fvg, maxActive: 100_000 },
  orderBlock: { ...STRUCTURE_DEFAULTS.orderBlock, maxActive: 100_000 },
};
const K = PARAMS.swingK;
const ge = (value: number, threshold: number) => value >= threshold - 1e-9;

function get<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`nothing at ${String(index)}`);
  return item;
}

interface NaivePivot {
  readonly kind: 'HIGH' | 'LOW';
  readonly index: number;
  readonly price: number;
  readonly confirmedIndex: number;
  readonly label: string | null;
}

function naivePivots(c: readonly StructureCandle[]): { highs: NaivePivot[]; lows: NaivePivot[] } {
  const highs: NaivePivot[] = [];
  const lows: NaivePivot[] = [];
  for (let j = K; j + K < c.length; j += 1) {
    const around = [
      ...Array.from({ length: K }, (_, n) => j - K + n),
      ...Array.from({ length: K }, (_, n) => j + 1 + n),
    ];
    const here = get(c, j);
    if (around.every((m) => get(c, m).h < here.h)) {
      const before = highs.at(-1);
      highs.push({
        kind: 'HIGH',
        index: j,
        price: here.h,
        confirmedIndex: j + K,
        label: before ? (here.h > before.price ? 'HH' : here.h < before.price ? 'LH' : 'EH') : null,
      });
    }
    if (around.every((m) => get(c, m).l > here.l)) {
      const before = lows.at(-1);
      lows.push({
        kind: 'LOW',
        index: j,
        price: here.l,
        confirmedIndex: j + K,
        label: before ? (here.l > before.price ? 'HL' : here.l < before.price ? 'LL' : 'EL') : null,
      });
    }
  }
  return { highs, lows };
}

function naiveState(
  highs: readonly { price: number }[],
  lows: readonly { price: number }[],
): StructureState | null {
  if (highs.length < 2 || lows.length < 2) return null;
  const [hb, hn] = highs.slice(-2);
  const [lb, ln] = lows.slice(-2);
  if (!hb || !hn || !lb || !ln) return null;
  if (hn.price > hb.price && ln.price > lb.price) return 'UP';
  if (hn.price < hb.price && ln.price < lb.price) return 'DOWN';
  return 'RANGE';
}

function naiveBreaks(
  c: readonly StructureCandle[],
  highs: readonly NaivePivot[],
  lows: readonly NaivePivot[],
) {
  const events: (string | number)[][] = [];
  for (let i = 0; i < c.length; i += 1) {
    const knownHighs = highs.filter((p) => p.confirmedIndex <= i - 1);
    const knownLows = lows.filter((p) => p.confirmedIndex <= i - 1);
    const state = naiveState(knownHighs, knownLows);
    const close = get(c, i).c;
    const high = knownHighs.at(-1);
    const low = knownLows.at(-1);
    if (state && high && close > high.price) {
      const spent = c.slice(high.confirmedIndex + 1, i).some((x) => x.c > high.price);
      if (!spent) events.push([i, state === 'DOWN' ? 'CHOCH' : 'BOS', 'UP', high.price, state]);
    }
    if (state && low && close < low.price) {
      const spent = c.slice(low.confirmedIndex + 1, i).some((x) => x.c < low.price);
      if (!spent) events.push([i, state === 'UP' ? 'CHOCH' : 'BOS', 'DOWN', low.price, state]);
    }
  }
  return events;
}

function naiveAtr(c: readonly StructureCandle[], period = 14): (number | null)[] {
  const range = c.map((x, i) => {
    if (i === 0) return x.h - x.l;
    const close = get(c, i - 1).c;
    return Math.max(x.h - x.l, Math.abs(x.h - close), Math.abs(x.l - close));
  });
  const atr: (number | null)[] = c.map(() => null);
  let value = range.slice(0, period).reduce((a, b) => a + b, 0) / period;
  atr[period - 1] = value;
  for (let i = period; i < c.length; i += 1) {
    value = (value * (period - 1) + get(range, i)) / period;
    atr[i] = value;
  }
  return atr;
}

function naiveDisplacement(x: StructureCandle, atr: number | null): Direction | null {
  if (atr === null) return null;
  const range = x.h - x.l;
  if (!ge(range, 1.2 * atr)) return null;
  if (!ge(Math.abs(x.c - x.o) / range, 0.6)) return null;
  if (x.c > x.o && ge((x.c - x.l) / range, 0.75)) return 'UP';
  if (x.c < x.o && ge((x.h - x.c) / range, 0.75)) return 'DOWN';
  return null;
}

const firstAfter = (
  c: readonly StructureCandle[],
  from: number,
  test: (x: StructureCandle) => boolean,
) => {
  for (let j = from + 1; j < c.length; j += 1) if (test(get(c, j))) return j;
  return null;
};

function run(candles: readonly StructureCandle[], levels = levelGrid(candles)) {
  const structure = new MarketStructure(PARAMS);
  return candles.map((candle) => structure.update(candle, levels));
}

const sorted = <T extends (string | number | null)[]>(rows: T[]) =>
  [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe.each([11, 29, 777])('against naive reference implementations (seed %i)', (seed) => {
  const candles = randomCandles(seed, 1200);
  const updates: MarketStructureUpdate[] = run(candles);
  const atr = naiveAtr(candles);
  const { highs, lows } = naivePivots(candles);

  it('swing pivots, their confirmation candle and their HH/LH/HL/LL labels', () => {
    const ours = updates
      .flatMap((u) => [u.high, u.low])
      .filter((p): p is Pivot => p !== null)
      .map((p) => [p.kind, p.index, p.price, p.confirmedIndex, p.label]);
    const reference = [...highs, ...lows]
      .map((p) => [p.kind, p.index, p.price, p.confirmedIndex, p.label])
      .sort((a, b) => Number(a[3]) - Number(b[3]) || String(a[0]).localeCompare(String(b[0])));
    expect(ours).toEqual(reference);
    expect(highs.length).toBeGreaterThan(100);
    expect(lows.length).toBeGreaterThan(100);
    expect(new Set([...highs, ...lows].map((p) => p.label))).toEqual(
      new Set([null, 'HH', 'LH', 'HL', 'LL']),
    );
  });

  it('the structure state after every candle', () => {
    const reference = candles.map((_, i) =>
      naiveState(
        highs.filter((p) => p.confirmedIndex <= i),
        lows.filter((p) => p.confirmedIndex <= i),
      ),
    );
    expect(updates.map((u) => u.state)).toEqual(reference);
    expect(new Set(reference)).toEqual(new Set([null, 'UP', 'DOWN', 'RANGE']));
  });

  it('BOS and CHoCH from the definition, one per pivot', () => {
    const ours = updates.flatMap((u) =>
      u.breaks.map((b) => [b.index, b.type, b.direction, b.level, b.stateBefore]),
    );
    const reference = naiveBreaks(candles, highs, lows);
    expect(ours).toEqual(reference);
    const count = (type: string, direction: string) =>
      reference.filter((e) => e[1] === type && e[2] === direction).length;
    for (const type of ['BOS', 'CHOCH']) {
      for (const direction of ['UP', 'DOWN']) expect(count(type, direction)).toBeGreaterThan(5);
    }
    expect(new Set(reference.map((e) => e[4]))).toEqual(new Set(['UP', 'DOWN', 'RANGE']));
  });

  it('ATR and displacement candles', () => {
    expect(updates.map((u) => u.atr === null)).toEqual(atr.map((v) => v === null));
    updates.forEach((u, i) => {
      if (u.atr !== null) expect(Math.abs(u.atr - (atr[i] ?? Number.NaN))).toBeLessThan(1e-9);
    });
    const reference = candles.map((x, i) => naiveDisplacement(x, atr[i] ?? null));
    expect(updates.map((u) => u.displacement?.direction ?? null)).toEqual(reference);
    expect(reference.filter((d) => d === 'UP').length).toBeGreaterThan(10);
    expect(reference.filter((d) => d === 'DOWN').length).toBeGreaterThan(10);
  });

  it('fair value gaps: creation, first touch and fill', () => {
    const reference = candles.flatMap((x, i) => {
      const a = atr[i] ?? null;
      const first = candles[i - 2];
      if (a === null || !first) return [];
      const up = x.l > first.h ? { direction: 'UP', bottom: first.h, top: x.l } : null;
      const down = x.h < first.l ? { direction: 'DOWN', bottom: x.h, top: first.l } : null;
      const gap = up ?? down;
      if (!gap || !ge(gap.top - gap.bottom, 0.3 * a)) return [];
      const touched = firstAfter(candles, i, (y) =>
        gap.direction === 'UP' ? y.l < gap.top : y.h > gap.bottom,
      );
      const filled = firstAfter(candles, i, (y) =>
        gap.direction === 'UP' ? y.l <= gap.bottom : y.h >= gap.top,
      );
      return [
        { index: i, direction: gap.direction, bottom: gap.bottom, top: gap.top, touched, filled },
      ];
    });
    const created = updates.flatMap((u) => (u.fvg.created ? [u.fvg.created] : []));
    expect(created.map((g) => [g.index, g.direction, g.bottom, g.top])).toEqual(
      reference.map((g) => [g.index, g.direction, g.bottom, g.top]),
    );
    const filledOurs = updates
      .flatMap((u) => u.fvg.filled)
      .map((g) => [g.index, g.touchedIndex, g.filledIndex]);
    expect(sorted(filledOurs)).toEqual(
      sorted(reference.filter((g) => g.filled !== null).map((g) => [g.index, g.touched, g.filled])),
    );
    const touchedOurs = updates.flatMap((u) => u.fvg.touched).map((g) => [g.index, g.touchedIndex]);
    const touchedReference = reference
      .filter((g) => g.touched !== null && (g.filled === null || g.touched < g.filled))
      .map((g) => [g.index, g.touched]);
    expect(sorted(touchedOurs)).toEqual(sorted(touchedReference));
    expect(reference.filter((g) => g.direction === 'UP').length).toBeGreaterThan(5);
    expect(reference.filter((g) => g.direction === 'DOWN').length).toBeGreaterThan(5);
    expect(reference.filter((g) => g.filled !== null).length).toBeGreaterThan(5);
    expect(
      reference.filter((g) => g.touched !== null && g.filled !== g.touched).length,
    ).toBeGreaterThan(1);
  });

  it('order blocks: the nearest opposite candle, once, and how they end', () => {
    const lastUsed: Record<Direction, number | null> = { UP: null, DOWN: null };
    const reference: {
      block: number;
      direction: Direction;
      at: number;
      touched: number | null;
      invalid: number | null;
    }[] = [];
    candles.forEach((_, d) => {
      const direction = naiveDisplacement(get(candles, d), atr[d] ?? null);
      if (!direction) return;
      let block: number | null = null;
      for (let m = d - 1; m >= Math.max(0, d - PARAMS.orderBlock.lookback); m -= 1) {
        const x = get(candles, m);
        if (direction === 'UP' ? x.c < x.o : x.c > x.o) {
          block = m;
          break;
        }
      }
      if (block === null || block === lastUsed[direction]) return;
      lastUsed[direction] = block;
      const b = get(candles, block);
      const touched = firstAfter(candles, d, (y) => (direction === 'UP' ? y.l < b.h : y.h > b.l));
      const invalid = firstAfter(candles, d, (y) => (direction === 'UP' ? y.c < b.l : y.c > b.h));
      reference.push({ block, direction, at: d, touched, invalid });
    });
    const created = updates.flatMap((u) => (u.orderBlock.created ? [u.orderBlock.created] : []));
    expect(created.map((b) => [b.index, b.direction, b.displacementIndex])).toEqual(
      reference.map((b) => [b.block, b.direction, b.at]),
    );
    const invalidOurs = updates
      .flatMap((u) => u.orderBlock.invalidated)
      .map((b) => [b.index, b.touchedIndex, b.invalidatedIndex]);
    expect(sorted(invalidOurs)).toEqual(
      sorted(
        reference.filter((b) => b.invalid !== null).map((b) => [b.block, b.touched, b.invalid]),
      ),
    );
    const touchedOurs = updates
      .flatMap((u) => u.orderBlock.touched)
      .map((b) => [b.index, b.touchedIndex]);
    expect(sorted(touchedOurs)).toEqual(
      sorted(
        reference
          .filter((b) => b.touched !== null && (b.invalid === null || b.touched < b.invalid))
          .map((b) => [b.block, b.touched]),
      ),
    );
    expect(reference.filter((b) => b.direction === 'UP').length).toBeGreaterThan(3);
    expect(reference.filter((b) => b.direction === 'DOWN').length).toBeGreaterThan(3);
    expect(reference.filter((b) => b.invalid !== null).length).toBeGreaterThan(1);
  });

  it('sweep and reclaim at a grid of levels: the first qualifying sweep of each level', () => {
    const levels = levelGrid(candles);
    const reference: (string | number)[][] = [];
    for (const level of levels) {
      const bullish = level.side === 'LOW';
      let sweep: number | null = null;
      for (let s = 0; s < candles.length && sweep === null; s += 1) {
        const x = get(candles, s);
        const a = atr[s] ?? null;
        const range = x.h - x.l;
        if (a === null || range <= 0) continue;
        const depth = bullish ? level.price - x.l : x.h - level.price;
        const wick = bullish ? Math.min(x.o, x.c) - x.l : x.h - Math.max(x.o, x.c);
        if (ge(depth, 0.1 * a) && ge(wick / range, 0.5)) sweep = s;
      }
      if (sweep === null) continue;
      let reclaim: number | null = null;
      for (
        let r = sweep;
        r <= Math.min(sweep + 3, candles.length - 1) && reclaim === null;
        r += 1
      ) {
        const close = get(candles, r).c;
        if (bullish ? close > level.price : close < level.price) reclaim = r;
      }
      if (reclaim === null) continue;
      const span = candles.slice(sweep, reclaim + 1);
      const extreme = bullish
        ? Math.min(...span.map((x) => x.l))
        : Math.max(...span.map((x) => x.h));
      reference.push([reclaim, level.id, bullish ? 'UP' : 'DOWN', sweep, extreme]);
    }
    const ours = updates.flatMap((u) =>
      u.sweeps.map((e) => [e.reclaimIndex, e.levelId, e.direction, e.sweepIndex, e.extreme]),
    );
    expect(sorted(ours)).toEqual(sorted(reference));
    expect(reference.filter((e) => e[2] === 'UP').length).toBeGreaterThan(5);
    expect(reference.filter((e) => e[2] === 'DOWN').length).toBeGreaterThan(5);
    expect(reference.filter((e) => e[0] !== e[3]).length).toBeGreaterThan(1);
  });
});

it('the reference tests would notice a different swing size', () => {
  const candles = randomCandles(11, 400);
  const k3 = new MarketStructure({ ...PARAMS, swingK: 3 });
  const pivots3 = candles.flatMap((c) => {
    const u = k3.update(c);
    return [u.high, u.low].filter((p): p is Pivot => p !== null).map((p) => p.index);
  });
  const reference = naivePivots(candles);
  expect(pivots3.length).not.toBe(reference.highs.length + reference.lows.length);
});
