import { describe, expect, it } from 'vitest';

import { MarketStructure } from '../structure/marketStructure';
import { randomCandles } from '../structure/test-data';
import type { Pivot, StructureCandle } from '../structure/types';
import { driftCandles } from '../trendlines/test-data';
import { doubleExtremeFor, headAndShouldersFor } from './reversal';
import { FIVE_MINUTES } from './test-data';

// The double top and head and shoulders rules of docs/02 section 4.1 written the naive way: every
// combination of swing points is tried over the whole candle series, and the most recent one that fits
// is taken. They are compared with the detectors (which read a window of candles and take the first
// match) at every candle that confirms a swing point, on random series.

const EPS = 1e-9;

function naiveDouble(
  second: Pivot,
  candles: readonly StructureCandle[],
  pivots: readonly Pivot[],
  t: number,
  atr: number,
): string | null {
  const top = second.kind === 'HIGH';
  const hi = (c: StructureCandle) => (top ? c.h : -c.l);
  const lo = (c: StructureCandle) => (top ? c.l : -c.h);
  const price = (p: Pivot) => (top ? p.price : -p.price);
  const eligible = pivots.filter((first) => {
    if (first.kind !== second.kind || first.index >= second.index || first.index < t + 1 - 120)
      return false;
    const span = second.index - first.index;
    if (span < 8 || span > 60) return false;
    if (Math.abs(price(first) - price(second)) > 0.25 * atr + EPS) return false;
    const between = candles.slice(first.index + 1, second.index);
    if (between.length === 0) return false;
    const outer = Math.max(price(first), price(second));
    if (between.some((c) => hi(c) > outer + 0.25 * atr + EPS)) return false;
    const trough = Math.min(...between.map(lo));
    return Math.min(price(first), price(second)) - trough >= atr - EPS;
  });
  const best = eligible.reduce<Pivot | null>((a, b) => (a && a.index > b.index ? a : b), null);
  return best ? `${top ? 'DT' : 'DB'}:${String(best.index)}:${String(second.index)}` : null;
}

function naiveHeadAndShoulders(
  right: Pivot,
  candles: readonly StructureCandle[],
  pivots: readonly Pivot[],
  t: number,
  atr: number,
): string | null {
  const top = right.kind === 'HIGH';
  const hi = (c: StructureCandle) => (top ? c.h : -c.l);
  const lo = (c: StructureCandle) => (top ? c.l : -c.h);
  const price = (p: Pivot) => (top ? p.price : -p.price);
  const same = pivots.filter(
    (p) => p.kind === right.kind && p.index < right.index && p.index >= t + 1 - 120,
  );
  const lowest = (from: number, to: number) => {
    let best: { index: number; value: number } | null = null;
    for (let i = from; i <= to; i += 1) {
      const c = candles[i];
      if (c && (best === null || lo(c) < best.value)) best = { index: i, value: lo(c) };
    }
    return best;
  };

  let result: { head: Pivot; left: Pivot } | null = null;
  for (const head of same) {
    const headSpan = right.index - head.index;
    if (headSpan < 8 || headSpan > 60) continue;
    if (price(head) - price(right) < 0.5 * atr - EPS) continue;
    if (candles.slice(head.index + 1, right.index).some((c) => hi(c) > price(head) + EPS)) continue;
    for (const left of same) {
      const leftSpan = head.index - left.index;
      if (leftSpan < 8 || leftSpan > 60) continue;
      if (Math.abs(price(left) - price(right)) > 0.5 * atr + EPS) continue;
      if (price(head) - price(left) < 0.5 * atr - EPS) continue;
      if (candles.slice(left.index + 1, head.index).some((c) => hi(c) > price(head) + EPS))
        continue;
      const n1 = lowest(left.index + 1, head.index - 1);
      const n2 = lowest(head.index + 1, right.index - 1);
      if (!n1 || !n2) continue;
      const slope = (n2.value - n1.value) / (n2.index - n1.index);
      if (Math.abs(slope) > 0.1 * atr + EPS) continue;
      const neckAtHead = n1.value + slope * (head.index - n1.index);
      if (price(head) - neckAtHead < atr - EPS) continue;
      const better =
        result === null ||
        head.index > result.head.index ||
        (head.index === result.head.index && left.index > result.left.index);
      if (better) result = { head, left };
    }
  }
  return result
    ? `${top ? 'HS' : 'IHS'}:${String(result.left.index)}:${String(result.head.index)}:${String(right.index)}`
    : null;
}

const SERIES: Record<string, StructureCandle[]> = {
  random: randomCandles(5, 1200),
  flat: driftCandles(51, 1200, 0),
  up: driftCandles(52, 1200, 0.05),
  down: driftCandles(53, 1200, -0.05),
};

describe.each(Object.entries(SERIES))('against a naive reference (%s)', (_name, candles) => {
  it('finds the same double tops, double bottoms and head and shoulders at every confirmed swing point', () => {
    const structure = new MarketStructure();
    const found = { double: 0, headAndShoulders: 0, inverse: 0, doubleBottom: 0 };
    candles.forEach((candle, t) => {
      structure.update(candle);
      const atr = structure.atr;
      if (atr === null) return;
      const highs = [...structure.highPivots];
      const lows = [...structure.lowPivots];
      const fresh = [...highs, ...lows].filter((p) => p.confirmedIndex === t);
      if (fresh.length === 0) return;
      const input = {
        candles: candles.slice(Math.max(0, t + 1 - 122), t + 1),
        count: t + 1,
        highs,
        lows,
        atr,
        candleMs: FIVE_MINUTES,
      };
      for (const pivot of fresh) {
        const pool = pivot.kind === 'HIGH' ? highs : lows;
        const double = doubleExtremeFor(pivot, input)?.id ?? null;
        expect(double, `double at ${String(t)}`).toBe(naiveDouble(pivot, candles, pool, t, atr));
        const hs = headAndShouldersFor(pivot, input)?.id ?? null;
        expect(hs, `head and shoulders at ${String(t)}`).toBe(
          naiveHeadAndShoulders(pivot, candles, pool, t, atr),
        );
        if (double?.startsWith('DT')) found.double += 1;
        if (double?.startsWith('DB')) found.doubleBottom += 1;
        if (hs?.startsWith('HS')) found.headAndShoulders += 1;
        if (hs?.startsWith('IHS')) found.inverse += 1;
      }
    });
    expect(found.double + found.doubleBottom).toBeGreaterThan(15);
    expect(found.headAndShoulders + found.inverse).toBeGreaterThan(15);
  });
});
