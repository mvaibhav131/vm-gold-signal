import type { Direction } from '../indicators/trend';
import { type Bar, assertBar, assertFinite } from '../indicators/types';

export type { Direction };

/** A candle as the structure code needs it: its prices and the open time (epoch milliseconds). `MarketCandle` fits. */
export interface StructureCandle extends Bar {
  readonly openTime: number;
}

/** Thresholds of `strategy-config v0.1.0` (docs/02 section 4). They are hypotheses, tuned only on training data. */
export interface StructureParams {
  /** Candles on each side of a swing pivot. */
  readonly swingK: number;
  /** How many confirmed pivots of each kind are remembered. */
  readonly keptPivots: number;
  readonly displacement: {
    readonly minRangeAtr: number;
    readonly minBodyRatio: number;
    /** The close must be inside this share of the range at the high (bullish) or the low (bearish). */
    readonly closeZone: number;
  };
  readonly fvg: { readonly minGapAtr: number; readonly maxActive: number };
  readonly orderBlock: { readonly lookback: number; readonly maxActive: number };
  readonly sweep: {
    readonly minDepthAtr: number;
    readonly minWickRatio: number;
    /** The reclaim may come on the sweep candle itself or within this many candles after it. */
    readonly reclaimWithin: number;
  };
}

export const STRUCTURE_DEFAULTS: StructureParams = {
  swingK: 2,
  keptPivots: 200,
  displacement: { minRangeAtr: 1.2, minBodyRatio: 0.6, closeZone: 0.25 },
  fvg: { minGapAtr: 0.3, maxActive: 20 },
  orderBlock: { lookback: 5, maxActive: 10 },
  sweep: { minDepthAtr: 0.1, minWickRatio: 0.5, reclaimWithin: 3 },
};

export type PivotKind = 'HIGH' | 'LOW';

/** Against the pivot of the same kind before it: higher high, lower high, equal high, and the same for lows. */
export type PivotLabel = 'HH' | 'LH' | 'EH' | 'HL' | 'LL' | 'EL';

export type StructureState = 'UP' | 'DOWN' | 'RANGE';

/** A confirmed swing high or low. It is only known once `k` candles have closed after it. */
export interface Pivot {
  readonly kind: PivotKind;
  readonly price: number;
  /** Position of the pivot candle in the series fed so far (0 is the first candle). */
  readonly index: number;
  readonly openTime: number;
  /** The candle whose close made it known: `index + k`. */
  readonly confirmedIndex: number;
  readonly confirmedOpenTime: number;
  /** Null for the first pivot of its kind. */
  readonly label: PivotLabel | null;
}

/** Comparing derived thresholds (a multiple of the ATR) must not flip on the last bit of a float. */
export const TOLERANCE = 1e-9;

/** `value` reaches `threshold`, ignoring binary noise. */
export function atLeast(value: number, threshold: number): boolean {
  return value >= threshold - TOLERANCE;
}

/** A malformed or out-of-order candle must stop the calculation, not distort every later value. */
export function assertCandle(candle: StructureCandle): void {
  assertBar(candle);
  assertFinite(candle.openTime, 'openTime');
  if (
    candle.h < candle.l ||
    candle.h < Math.max(candle.o, candle.c) ||
    candle.l > Math.min(candle.o, candle.c)
  ) {
    throw new RangeError('the high and low of a candle must contain its open and close');
  }
}

export function assertInOrder(previousOpenTime: number | null, candle: StructureCandle): void {
  if (previousOpenTime !== null && candle.openTime <= previousOpenTime) {
    throw new RangeError('candles must arrive in time order');
  }
}
