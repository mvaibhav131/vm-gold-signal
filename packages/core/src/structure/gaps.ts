import {
  STRUCTURE_DEFAULTS,
  assertCandle,
  assertInOrder,
  atLeast,
  type Direction,
  type StructureCandle,
  type StructureParams,
} from './types';

export type GapStatus = 'OPEN' | 'TOUCHED' | 'FILLED';

/** A fair value gap: three candles where the first and the third do not overlap. */
export interface Fvg {
  /** `UP` is a bullish gap (the third low is above the first high), `DOWN` a bearish one. */
  readonly direction: Direction;
  readonly top: number;
  readonly bottom: number;
  readonly size: number;
  /** The size in ATRs, with the ATR as of the candle that completed the gap. */
  readonly sizeAtr: number;
  /** The third candle, the one that completed the gap. */
  readonly index: number;
  readonly openTime: number;
  /** The first of the three candles. */
  readonly startOpenTime: number;
  readonly status: GapStatus;
  readonly touchedIndex: number | null;
  readonly filledIndex: number | null;
}

export interface FvgUpdate {
  /** The gap completed by this candle. */
  readonly created: Fvg | null;
  /** Open gaps that this candle traded into for the first time. */
  readonly touched: readonly Fvg[];
  /** Gaps that this candle traded all the way through (they leave the active list). */
  readonly filled: readonly Fvg[];
}

interface Edge {
  readonly h: number;
  readonly l: number;
  readonly openTime: number;
}

/**
 * Fair value gaps (docs/02 section 4). Bullish: `low[i] > high[i-2]` with a gap of at least
 * 0.3 x ATR; bearish is the mirror. A later candle "touches" a gap when it trades into it (strictly
 * inside) and "fills" it when it reaches the far edge. The gap is judged only by the candles that
 * come after the one that created it.
 */
export class FvgTracker {
  private gaps: Fvg[] = [];
  private older: Edge | null = null;
  private previous: Edge | null = null;
  private seen = 0;
  private lastOpenTime: number | null = null;

  constructor(private readonly params: StructureParams['fvg'] = STRUCTURE_DEFAULTS.fvg) {}

  get count(): number {
    return this.seen;
  }

  /** Gaps not yet filled, oldest first (at most `maxActive`). */
  get active(): readonly Fvg[] {
    return this.gaps;
  }

  update(candle: StructureCandle, atr: number | null): FvgUpdate {
    assertCandle(candle);
    assertInOrder(this.lastOpenTime, candle);
    this.lastOpenTime = candle.openTime;
    const index = this.seen;
    this.seen += 1;

    const touched: Fvg[] = [];
    const filled: Fvg[] = [];
    const remaining: Fvg[] = [];
    for (const gap of this.gaps) {
      const up = gap.direction === 'UP';
      const fills = up ? candle.l <= gap.bottom : candle.h >= gap.top;
      const enters = up ? candle.l < gap.top : candle.h > gap.bottom;
      if (fills) {
        filled.push({
          ...gap,
          status: 'FILLED',
          touchedIndex: gap.touchedIndex ?? index,
          filledIndex: index,
        });
      } else if (enters && gap.status === 'OPEN') {
        const next: Fvg = { ...gap, status: 'TOUCHED', touchedIndex: index };
        touched.push(next);
        remaining.push(next);
      } else {
        remaining.push(gap);
      }
    }

    let created: Fvg | null = null;
    const first = this.older;
    if (first !== null && atr !== null && atr > 0) {
      const base = { index, openTime: candle.openTime, startOpenTime: first.openTime };
      const make = (direction: Direction, bottom: number, top: number): Fvg | null => {
        const size = top - bottom;
        if (!atLeast(size, this.params.minGapAtr * atr)) return null;
        return {
          direction,
          top,
          bottom,
          size,
          sizeAtr: size / atr,
          ...base,
          status: 'OPEN',
          touchedIndex: null,
          filledIndex: null,
        };
      };
      if (candle.l > first.h) created = make('UP', first.h, candle.l);
      else if (candle.h < first.l) created = make('DOWN', candle.h, first.l);
    }
    if (created) remaining.push(created);
    this.gaps = remaining.slice(-this.params.maxActive);

    this.older = this.previous;
    this.previous = { h: candle.h, l: candle.l, openTime: candle.openTime };
    return { created, touched, filled };
  }
}
