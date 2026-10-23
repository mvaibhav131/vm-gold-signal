import type { Bar } from '../indicators/types';
import { STRUCTURE_DEFAULTS, atLeast, type Direction, type StructureParams } from './types';

export interface Displacement {
  readonly direction: Direction;
  readonly range: number;
  /** The range in ATRs. */
  readonly rangeAtr: number;
  /** Body over range, 0 to 1. */
  readonly bodyRatio: number;
  /** Where the close sits in the range: 0 at the low, 1 at the high. */
  readonly closeLocation: number;
}

/**
 * Displacement candle (docs/02 section 4): the range is at least 1.2 x ATR, the body is at least
 * 60% of the range, and the close is inside the top 25% of the range (bullish) or the bottom 25%
 * (bearish). `atr` is the ATR(14) of the same timeframe as of this candle; without it (warm-up)
 * nothing is a displacement.
 */
export function displacementOf(
  bar: Bar,
  atr: number | null,
  params: StructureParams['displacement'] = STRUCTURE_DEFAULTS.displacement,
): Displacement | null {
  if (atr === null || !(atr > 0)) return null;
  const range = bar.h - bar.l;
  if (!(range > 0) || !atLeast(range, params.minRangeAtr * atr)) return null;
  const bodyRatio = Math.abs(bar.c - bar.o) / range;
  if (!atLeast(bodyRatio, params.minBodyRatio)) return null;
  const closeLocation = (bar.c - bar.l) / range;
  const base = { range, rangeAtr: range / atr, bodyRatio, closeLocation };
  if (bar.c > bar.o && atLeast(closeLocation, 1 - params.closeZone)) {
    return { direction: 'UP', ...base };
  }
  if (bar.c < bar.o && atLeast(1 - closeLocation, 1 - params.closeZone)) {
    return { direction: 'DOWN', ...base };
  }
  return null;
}
