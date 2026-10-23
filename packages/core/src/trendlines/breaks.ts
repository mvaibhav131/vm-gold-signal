import {
  TOLERANCE,
  assertCandle,
  assertInOrder,
  type Direction,
  type StructureCandle,
} from '../structure/types';
import { lineValueAt, type Trendline } from './lines';
import { TRENDLINE_DEFAULTS, type TrendlineParams } from './types';

/** A close through a trendline. */
export interface TrendlineBreak {
  readonly line: Trendline;
  /** `DOWN` when a support line is broken, `UP` when a resistance line is. */
  readonly direction: Direction;
  readonly index: number;
  readonly openTime: number;
  readonly close: number;
  /** The price of the line at the candle. */
  readonly lineValue: number;
  /** How far beyond the line the close is, in ATRs. */
  readonly beyondAtr: number;
  /** Body over range of the candle. */
  readonly bodyRatio: number;
}

/**
 * Whether a candle breaks a line (docs/02 section 4.1): its close is beyond the line by at least
 * 0.10 x ATR and its body is at least half of its range. `atr` is the ATR of the candle's own
 * timeframe, which can differ from the timeframe the line was drawn on.
 */
export function breakOf(
  line: Trendline,
  candle: StructureCandle,
  atr: number | null,
  params: TrendlineParams = TRENDLINE_DEFAULTS,
): Omit<TrendlineBreak, 'index'> | null {
  if (atr === null || !(atr > 0)) return null;
  const range = candle.h - candle.l;
  if (!(range > 0)) return null;
  const lineValue = lineValueAt(line, candle.openTime);
  const support = line.side === 'SUPPORT';
  const beyond = support ? lineValue - candle.c : candle.c - lineValue;
  const bodyRatio = Math.abs(candle.c - candle.o) / range;
  if (beyond < params.break.closeAtr * atr - TOLERANCE) return null;
  if (bodyRatio < params.break.bodyRatio - TOLERANCE) return null;
  return {
    line,
    direction: support ? 'DOWN' : 'UP',
    openTime: candle.openTime,
    close: candle.c,
    lineValue,
    beyondAtr: beyond / atr,
    bodyRatio,
  };
}

/** A retest that has been confirmed. */
export interface TrendlineRetest {
  readonly line: Trendline;
  readonly direction: Direction;
  readonly breakIndex: number;
  readonly breakOpenTime: number;
  /** The first candle that came back to the line. */
  readonly returnIndex: number;
  /** The candle that closed away from the line again. */
  readonly index: number;
  readonly openTime: number;
  readonly close: number;
  readonly lineValue: number;
}

export interface RetestEnd {
  readonly line: Trendline;
  readonly direction: Direction;
  readonly breakIndex: number;
  readonly index: number;
  /** `FAILED`: a close back on the old side of the line. `EXPIRED`: no confirmed retest within the window. */
  readonly reason: 'FAILED' | 'EXPIRED';
}

export interface BreakRetestUpdate {
  readonly breaks: readonly TrendlineBreak[];
  readonly retests: readonly TrendlineRetest[];
  readonly ended: readonly RetestEnd[];
}

interface Pending {
  readonly line: Trendline;
  readonly direction: Direction;
  readonly breakIndex: number;
  readonly breakOpenTime: number;
  returnIndex: number | null;
}

/**
 * Breaks and retests of trendlines (docs/02 section 4.1). Each call gets the candle, its ATR and
 * the lines to watch (normally the best support and the best resistance line, drawn on the same or
 * on a slower timeframe, for example 15m lines against 5m candles). A line is judged against the
 * candle as it was known at the previous call, so a line that the candle itself invalidates can
 * still be reported broken, and each line is reported once.
 *
 * After a break the line is followed for `within` (8) candles:
 *
 * - a candle that closes back on the old side of the line ends it (`FAILED`);
 * - a candle that comes back to within 0.30 x ATR of the line, from the new side, is the return;
 * - the retest is confirmed by the first candle, the one of the return or a later one, that
 *   closes at least 0.30 x ATR away from the line on the new side;
 * - without that, it ends (`EXPIRED`) when the window is over.
 *
 * The strategy adds its own requirements (rejection wick, RSI). The break candle is never the entry.
 */
export class BreakRetestTracker {
  private pending: Pending[] = [];
  private previousLines: readonly Trendline[] = [];
  private readonly broken = new Set<string>();
  private seen = 0;
  private lastOpenTime: number | null = null;

  constructor(private readonly params: TrendlineParams = TRENDLINE_DEFAULTS) {}

  get count(): number {
    return this.seen;
  }

  /** Broken lines that are waiting for their retest. */
  get waiting(): readonly {
    lineId: string;
    direction: Direction;
    breakIndex: number;
    returnIndex: number | null;
  }[] {
    return this.pending.map((p) => ({
      lineId: p.line.id,
      direction: p.direction,
      breakIndex: p.breakIndex,
      returnIndex: p.returnIndex,
    }));
  }

  update(
    candle: StructureCandle,
    atr: number | null,
    lines: readonly Trendline[],
  ): BreakRetestUpdate {
    assertCandle(candle);
    assertInOrder(this.lastOpenTime, candle);
    this.lastOpenTime = candle.openTime;
    const index = this.seen;
    this.seen += 1;

    const breaks: TrendlineBreak[] = [];
    const retests: TrendlineRetest[] = [];
    const ended: RetestEnd[] = [];
    const band = atr !== null && atr > 0 ? this.params.retest.zoneAtr * atr : null;

    const stillWaiting: Pending[] = [];
    for (const p of this.pending) {
      const value = lineValueAt(p.line, candle.openTime);
      const down = p.direction === 'DOWN';
      if (down ? candle.c > value : candle.c < value) {
        ended.push({
          line: p.line,
          direction: p.direction,
          breakIndex: p.breakIndex,
          index,
          reason: 'FAILED',
        });
        continue;
      }
      let confirmed = false;
      if (band !== null) {
        const returned = down
          ? candle.h >= value - band - TOLERANCE
          : candle.l <= value + band + TOLERANCE;
        if (returned && p.returnIndex === null) p.returnIndex = index;
        const away = down
          ? candle.c <= value - band + TOLERANCE
          : candle.c >= value + band - TOLERANCE;
        if (p.returnIndex !== null && away) {
          confirmed = true;
          retests.push({
            line: p.line,
            direction: p.direction,
            breakIndex: p.breakIndex,
            breakOpenTime: p.breakOpenTime,
            returnIndex: p.returnIndex,
            index,
            openTime: candle.openTime,
            close: candle.c,
            lineValue: value,
          });
        }
      }
      if (confirmed) continue;
      if (index - p.breakIndex >= this.params.retest.within) {
        ended.push({
          line: p.line,
          direction: p.direction,
          breakIndex: p.breakIndex,
          index,
          reason: 'EXPIRED',
        });
      } else {
        stillWaiting.push(p);
      }
    }
    this.pending = stillWaiting;

    for (const line of this.previousLines) {
      if (this.broken.has(line.id)) continue;
      const found = breakOf(line, candle, atr, this.params);
      if (!found) continue;
      this.broken.add(line.id);
      breaks.push({ ...found, index });
      this.pending.push({
        line,
        direction: found.direction,
        breakIndex: index,
        breakOpenTime: candle.openTime,
        returnIndex: null,
      });
    }

    const present = new Set(lines.map((line) => line.id));
    for (const id of this.broken) {
      if (!present.has(id) && !this.pending.some((p) => p.line.id === id)) this.broken.delete(id);
    }
    this.previousLines = lines;
    return { breaks, retests, ended };
  }
}
