import { describe, expect, it } from 'vitest';

import { type Bar, computeSeries } from '../indicators/types';
import { Atr } from '../indicators/volatility';
import { candlesticksOf } from './detect';
import { randomBars, timed } from './test-data';

// A second, naive reading of the definitions in docs/02 section 4.1: written from the text, with
// ratios and sorted ranges instead of the thresholds of detect.ts, compared on long random series.

function naive(bars: readonly Bar[], i: number, atr: number | null): string[] {
  const bar = bars[i];
  if (!bar) return [];
  const found: string[] = [];
  const body = Math.abs(bar.c - bar.o);
  const range = bar.h - bar.l;
  const hasAtr = atr !== null && atr > 0;

  if (range > 0) {
    const lowerShare = (Math.min(bar.o, bar.c) - bar.l) / range;
    const upperShare = (bar.h - Math.max(bar.o, bar.c)) / range;
    const bodyShare = body / range;
    const closeAt = (bar.c - bar.l) / range;
    if (lowerShare >= 0.6 && lowerShare >= 2 * bodyShare && closeAt >= 0.65)
      found.push('PIN_BAR:UP');
    if (upperShare >= 0.6 && upperShare >= 2 * bodyShare && closeAt <= 0.35)
      found.push('PIN_BAR:DOWN');
  }

  const previous = bars[i - 1];
  if (previous && hasAtr) {
    const prevBody = Math.abs(previous.c - previous.o);
    const prevLow = Math.min(previous.o, previous.c);
    const prevHigh = Math.max(previous.o, previous.c);
    const low = Math.min(bar.o, bar.c);
    const high = Math.max(bar.o, bar.c);
    const covers = low <= prevLow && high >= prevHigh && body > prevBody;
    if (range >= atr && covers && previous.c < previous.o && bar.c > bar.o)
      found.push('ENGULFING:UP');
    if (range >= atr && covers && previous.c > previous.o && bar.c < bar.o)
      found.push('ENGULFING:DOWN');
  }
  if (previous && bar.h < previous.h && bar.l > previous.l) found.push('INSIDE_BAR:-');

  if (i >= 6) {
    const others = bars
      .slice(i - 6, i)
      .map((b) => b.h - b.l)
      .sort((a, b) => a - b);
    if (range < (others[0] ?? 0)) found.push('NR7:-');
  }

  const first = bars[i - 2];
  const middle = previous;
  if (first && middle && hasAtr) {
    const firstBody = Math.abs(first.c - first.o);
    const middleBody = Math.abs(middle.c - middle.o);
    const middleCentre = (middle.o + middle.c) / 2;
    const firstCentre = (first.o + first.c) / 2;
    const sized = firstBody >= 0.6 * atr && body >= 0.6 * atr && middleBody <= 0.25 * atr;
    if (
      sized &&
      first.c < first.o &&
      bar.c > bar.o &&
      middleCentre <= first.c &&
      bar.c > firstCentre
    ) {
      found.push('MORNING_STAR:UP');
    }
    if (
      sized &&
      first.c > first.o &&
      bar.c < bar.o &&
      middleCentre >= first.c &&
      bar.c < firstCentre
    ) {
      found.push('EVENING_STAR:DOWN');
    }
  }
  return found;
}

describe('candlesticks against a naive reference', () => {
  it('agree at every candle of long random series', () => {
    let compared = 0;
    for (const seed of [21, 22, 23, 24]) {
      const bars = randomBars(seed, 1500);
      const candles = timed(bars);
      const atrs = computeSeries(new Atr(), bars);
      bars.forEach((_, i) => {
        const fast = candlesticksOf(
          candles.slice(Math.max(0, i - 6), i + 1),
          i + 1,
          atrs[i] ?? null,
        ).map((p) => `${p.name}:${p.direction ?? '-'}`);
        expect(fast.sort(), `seed ${String(seed)} candle ${String(i)}`).toEqual(
          naive(bars, i, atrs[i] ?? null).sort(),
        );
        compared += fast.length;
      });
    }
    expect(compared).toBeGreaterThan(500);
  });
});
