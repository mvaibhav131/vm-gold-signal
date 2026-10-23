import { describe, expect, it } from 'vitest';

import { Macd, Rsi } from '../indicators/momentum';
import { computeSeries } from '../indicators/types';
import { MarketStructure } from '../structure/marketStructure';
import { randomCandles } from '../structure/test-data';
import { STRUCTURE_DEFAULTS, type Pivot } from '../structure/types';
import { DivergenceTracker } from './tracker';

// A second, naive reading of the definition in docs/02 section 4.1: every pair of consecutive
// confirmed swing points of the final pivot lists, with the oscillator arrays of a batch run, compared
// with what the tracker reported candle by candle.

interface Expected {
  readonly id: string;
  readonly confirmedIndex: number;
  readonly firstValue: number;
  readonly secondValue: number;
}

function naive(
  pivots: readonly Pivot[],
  values: readonly (number | null)[],
  source: 'RSI' | 'MACDH',
  zone: { low: number; high: number },
): Expected[] {
  const found: Expected[] = [];
  for (let j = 1; j < pivots.length; j += 1) {
    const a = pivots[j - 1];
    const b = pivots[j];
    if (!a || !b) continue;
    const gap = b.index - a.index;
    if (gap < 5 || gap > 40) continue;
    const va = values[a.index];
    const vb = values[b.index];
    if (va === null || vb === null || va === undefined || vb === undefined) continue;

    // sign +1 for lows (a divergence is bullish), -1 for highs (bearish): the same rules turned around
    const sign = b.kind === 'LOW' ? 1 : -1;
    const price = sign * (b.price - a.price); // < 0: a lower low (higher high)
    const oscillator = sign * (vb - va); // > 0: a higher low (lower high)
    const direction = sign === 1 ? 'UP' : 'DOWN';
    const inZone = sign === 1 ? va <= zone.low : va >= zone.high;
    let kind: string | null = null;
    if (price < 0 && oscillator > 0 && inZone) kind = 'REGULAR';
    if (price > 0 && oscillator < 0) kind = 'HIDDEN';
    if (kind) {
      found.push({
        id: `5mDIV:${source}:${kind}:${direction}:${String(a.index)}:${String(b.index)}`,
        confirmedIndex: b.confirmedIndex,
        firstValue: va,
        secondValue: vb,
      });
    }
  }
  return found;
}

describe('divergence against a naive reference', () => {
  it('agrees with the tracker on long random series: same divergences, same candle, same values', () => {
    let compared = 0;
    for (const seed of [41, 42, 43, 44]) {
      const candles = randomCandles(seed, 1500);
      const closes = candles.map((c) => c.c);
      const rsi = computeSeries(new Rsi(), closes);
      const histogram = computeSeries(new Macd(), closes).map((m) => m?.histogram ?? null);

      const structure = new MarketStructure({ ...STRUCTURE_DEFAULTS, keptPivots: 100_000 });
      const tracker = new DivergenceTracker('5m');
      const reported: Expected[] = [];
      candles.forEach((candle, i) => {
        structure.update(candle);
        for (const d of tracker.update(candle, structure)) {
          expect(d.index).toBe(i);
          reported.push({
            id: d.id,
            confirmedIndex: d.index,
            firstValue: d.first.value,
            secondValue: d.second.value,
          });
        }
      });

      const expected = [
        ...naive(structure.lowPivots, rsi, 'RSI', { low: 40, high: 60 }),
        ...naive(structure.highPivots, rsi, 'RSI', { low: 40, high: 60 }),
        ...naive(structure.lowPivots, histogram, 'MACDH', { low: 0, high: 0 }),
        ...naive(structure.highPivots, histogram, 'MACDH', { low: 0, high: 0 }),
      ];
      const byId = (a: Expected, b: Expected) => a.id.localeCompare(b.id);
      expect(reported.sort(byId), `seed ${String(seed)}`).toEqual(expected.sort(byId));
      compared += expected.length;
    }
    expect(compared).toBeGreaterThan(100);
  });
});
