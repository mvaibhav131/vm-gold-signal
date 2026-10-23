import { describe, expect, it } from 'vitest';

import { MarketStructure } from '../structure/marketStructure';
import type { Pivot, StructureCandle } from '../structure/types';
import { findTrendlines } from './lines';
import { FIVE_MINUTES, driftCandles } from './test-data';
import { TrendlineTracker } from './tracker';
import { randomCandles } from '../structure/test-data';

// The rules of docs/02 section 4.1 written the naive way: whole arrays, every pair of swing points,
// loops over the candles, positions instead of times. They are compared with the streaming tracker
// (which keeps a window of candles and reads the lines in time) on long random runs, with and
// without a gap in the data.

const EPS = 1e-9;

interface NaiveLine {
  readonly id: string;
  readonly touches: number;
  readonly score: number;
  readonly channelTouches: number | null;
}

function naive(
  candles: readonly StructureCandle[],
  t: number,
  highs: readonly Pivot[],
  lows: readonly Pivot[],
  atr: number,
): NaiveLine[] {
  const found: (NaiveLine & { last: number; a: number; b: number })[] = [];
  // the first position after the latest gap, looking back from t
  let afterGap = 0;
  for (let i = t; i >= 1; i -= 1) {
    if ((candles[i]?.openTime ?? 0) - (candles[i - 1]?.openTime ?? 0) !== FIVE_MINUTES) {
      afterGap = i;
      break;
    }
  }
  const from = Math.max(t + 1 - 80, afterGap, 0);

  for (const support of [true, false]) {
    const pool = (support ? lows : highs).filter((p) => p.index >= from);
    for (const a of pool) {
      for (const b of pool) {
        if (b.index < a.index + 6) continue;
        const slope = (b.price - a.price) / (b.index - a.index);
        if (support ? slope <= 0 : slope >= 0) continue;
        if (Math.abs(slope) > 0.15 * atr + EPS) continue;
        const at = (position: number) => a.price + slope * (position - a.index);

        let valid = true;
        for (let position = a.index; position <= t; position += 1) {
          const close = candles[position]?.c ?? 0;
          if ((support ? at(position) - close : close - at(position)) > 0.1 * atr + EPS)
            valid = false;
        }
        for (const p of pool) {
          if (p.index > a.index && p.index < b.index) {
            if ((support ? at(p.index) - p.price : p.price - at(p.index)) > 0.15 * atr + EPS)
              valid = false;
          }
        }
        if (!valid) continue;

        const touching = pool.filter(
          (p) => p.index >= a.index && Math.abs(p.price - at(p.index)) <= 0.15 * atr + EPS,
        );
        const last = Math.max(...touching.map((p) => p.index));
        const score =
          2 * touching.length +
          Math.min((last - a.index) / 10, 3) +
          Math.max(0, 1 - (t - last) / 80);

        // the channel of this line, written separately
        const others = (support ? highs : lows).filter((p) => p.index >= a.index);
        const between = others.filter((p) => p.index > a.index && p.index < b.index);
        let channelTouches: number | null = null;
        if (between.length > 0) {
          const anchor = between.reduce((best, p) =>
            (support ? p.price > best.price : p.price < best.price) ? p : best,
          );
          const offset = anchor.price - at(anchor.index);
          const near = others.filter(
            (p) => Math.abs(p.price - (at(p.index) + offset)) <= 0.15 * atr + EPS,
          );
          channelTouches = near.length >= 2 ? near.length : null;
        }
        found.push({
          id: `5m${support ? 'S' : 'R'}:${String(a.index)}:${String(b.index)}`,
          touches: touching.length,
          score,
          channelTouches,
          last,
          a: a.index,
          b: b.index,
        });
      }
    }
  }
  return found.sort((x, y) => y.score - x.score || y.last - x.last || x.a - y.a || x.b - y.b);
}

const SERIES: Record<string, StructureCandle[]> = {
  random: randomCandles(5, 700),
  up: driftCandles(41, 700, 0.06),
  down: driftCandles(42, 700, -0.06),
  gap: driftCandles(43, 720, 0.05, { at: 300, count: 20 }),
};

describe.each(Object.entries(SERIES))('against a naive reference (%s)', (name, candles) => {
  const structure = new MarketStructure();
  const tracker = new TrendlineTracker('5m');
  const seen = { lines: 0, resistance: 0, confirmed: 0, channels: 0 };

  it('finds the same lines, touches, scores and channels, every 5 candles', () => {
    candles.forEach((candle, t) => {
      structure.update(candle);
      const update = tracker.update(candle, structure);
      if (t % 5 !== 0 || structure.atr === null) return;
      const reference = naive(
        candles,
        t,
        [...structure.highPivots],
        [...structure.lowPivots],
        structure.atr,
      );
      expect(update.lines.map((l) => l.id)).toEqual(reference.map((l) => l.id));
      update.lines.forEach((line, i) => {
        expect(line.touches).toBe(reference[i]?.touches);
        expect(Math.abs(line.score - (reference[i]?.score ?? Number.NaN))).toBeLessThan(1e-9);
      });
      // the channel is kept for the best line of each side: the first reference line of that side
      for (const [side, channel] of [
        ['S', update.supportChannel],
        ['R', update.resistanceChannel],
      ] as const) {
        const best = reference.find((l) => l.id.startsWith(`5m${side}:`));
        expect(channel?.touches ?? null).toBe(best?.channelTouches ?? null);
      }
      seen.lines += update.lines.length;
      seen.resistance += update.resistance ? 1 : 0;
      seen.confirmed += update.support?.confirmed ? 1 : 0;
      seen.channels += update.supportChannel || update.resistanceChannel ? 1 : 0;
    });
    expect(seen.lines).toBeGreaterThan(40);
    expect(seen.channels).toBeGreaterThan(5);
    if (name !== 'random') expect(seen.confirmed).toBeGreaterThan(2);
  });

  it('gives the same lines as the pure function on the same inputs', () => {
    const lines = findTrendlines({
      candles: candles.slice(-80),
      count: candles.length,
      highs: structure.highPivots,
      lows: structure.lowPivots,
      atr: structure.atr,
      candleMs: FIVE_MINUTES,
      tag: '5m',
    });
    expect(tracker.value.lines.map((l) => l.id)).toEqual(lines.map((l) => l.id));
  });
});

describe('a gap in the data', () => {
  it('ends every line: no line has a point before the gap while the gap is inside the window', () => {
    const candles = SERIES.gap ?? [];
    const structure = new MarketStructure();
    const tracker = new TrendlineTracker('5m');
    let checked = 0;
    candles.forEach((candle, t) => {
      structure.update(candle);
      const update = tracker.update(candle, structure);
      // the candle series has no hole before position 300, and the first candle after the gap is position 300
      if (t >= 300 && t < 380) {
        checked += update.lines.length;
        for (const line of update.lines) expect(line.a.index).toBeGreaterThanOrEqual(300);
      }
    });
    expect(candles).toHaveLength(700);
    expect(checked).toBeGreaterThan(0);
  });
});
