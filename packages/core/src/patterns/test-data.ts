import { FIVE_MINUTES, bar, makeLine, mirrorBar, pivot, when } from '../trendlines/test-data';
import type { Pivot, StructureCandle } from '../structure/types';
import type { TrendlineUpdate } from '../trendlines/tracker';
import type { PatternInput } from './types';

export { FIVE_MINUTES, bar, makeLine, mirrorBar, pivot, when };

export type Ohlc = readonly [o: number, h: number, l: number, c: number];

/** Candles 0..count-1 of a 5-minute series: open = close = `base(i)`, wicks 0.2; `overrides` replaces whole candles. */
export function series(
  count: number,
  base: (index: number) => number = () => 109,
  overrides: Readonly<Record<number, Ohlc>> = {},
): StructureCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const chosen = overrides[i];
    if (chosen) return bar(i, chosen[0], chosen[1], chosen[2], chosen[3]);
    const c = base(i);
    return bar(i, c, c + 0.2, c - 0.2, c);
  });
}

export function patternInput(
  candles: readonly StructureCandle[],
  highs: readonly Pivot[],
  lows: readonly Pivot[],
  extra: Partial<PatternInput> = {},
): PatternInput {
  return { candles, count: candles.length, highs, lows, atr: 1, candleMs: FIVE_MINUTES, ...extra };
}

export const AROUND = 220;

export function mirrorPivot(p: Pivot): Pivot {
  return { ...p, kind: p.kind === 'HIGH' ? 'LOW' : 'HIGH', price: AROUND - p.price };
}

/** A scenario written for tops (highs, prices above) as it looks in the mirror: bottoms. */
export function flipScenario(
  scenario: { candles: StructureCandle[]; highs: Pivot[]; lows: Pivot[] },
  top: boolean,
) {
  if (top) return scenario;
  return {
    candles: scenario.candles.map((c) => mirrorBar(c, AROUND)),
    highs: scenario.lows.map(mirrorPivot),
    lows: scenario.highs.map(mirrorPivot),
  };
}

/** A price in the coordinates of the scenario that is run (mirrored for bottoms). */
export const priceIn = (top: boolean, price: number) => (top ? price : AROUND - price);

export const noTrend: TrendlineUpdate = {
  lines: [],
  support: null,
  resistance: null,
  supportChannel: null,
  resistanceChannel: null,
};
