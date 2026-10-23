import { TIMEFRAME_MS, type Timeframe } from '../domain';
import { assertCandle, assertInOrder, type Pivot, type StructureCandle } from '../structure/types';
import type { PivotFeed, TrendlineUpdate } from '../trendlines/tracker';
import { patternBreakout } from './breakout';
import { flagOf, wedgeOf } from './flags';
import { doubleExtremeFor, headAndShouldersFor } from './reversal';
import { rectangleOf, trianglesOf } from './triangles';
import {
  PATTERN_DEFAULTS,
  type Pattern,
  type PatternBreakout,
  type PatternInput,
  type PatternParams,
} from './types';

export interface PatternEnd {
  readonly pattern: Pattern;
  readonly index: number;
  /**
   * `INVALIDATED`: a close beyond the tops of a reversal pattern. `EXPIRED`: its first point left the
   * window. `LOST`: the lines or levels of a triangle, rectangle, flag, pennant or wedge no longer hold.
   */
  readonly reason: 'INVALIDATED' | 'EXPIRED' | 'LOST';
}

export interface PatternUpdate {
  /** Patterns found at this candle. */
  readonly formed: readonly Pattern[];
  /** Patterns broken by a candle: this one, or (for a reversal pattern found only now) one just before it. */
  readonly breakouts: readonly PatternBreakout[];
  readonly ended: readonly PatternEnd[];
  /** The patterns that have formed and not yet been broken or ended. */
  readonly active: readonly Pattern[];
}

/**
 * The chart patterns of one timeframe, candle by candle (docs/02 section 4.1). Feed it each closed
 * candle after the `MarketStructure` and the `TrendlineTracker` of the same timeframe:
 * `structure.update(candle)`, `trend.update(candle, structure)`, `patterns.update(candle, structure, trend)`.
 *
 * - Double tops and bottoms, and head and shoulders, are looked for when their last swing point is
 *   confirmed, and followed until they are broken, invalidated or expired.
 * - Triangles, rectangles, flags, pennants and wedges are read from the current lines and levels at
 *   every candle: one that was found at the previous candle and is broken by this one is reported
 *   broken, one that no longer holds is reported lost.
 * - A pattern is broken once. A reversal pattern whose break happened between its last swing point and
 *   its confirmation is reported broken at the moment it is found, with the index of the candle that
 *   broke it.
 */
export class PatternTracker {
  private readonly candles: StructureCandle[] = [];
  private readonly candleMs: number;
  private readonly reversals = new Map<string, Pattern>();
  private previous = new Map<string, Pattern>();
  private readonly broken = new Set<string>();
  private seen = 0;
  private lastOpenTime: number | null = null;

  constructor(
    tf: Timeframe,
    private readonly params: PatternParams = PATTERN_DEFAULTS,
    private readonly tag: string = tf,
  ) {
    this.candleMs = TIMEFRAME_MS[tf];
  }

  get count(): number {
    return this.seen;
  }

  get active(): readonly Pattern[] {
    return [...this.reversals.values(), ...this.previous.values()];
  }

  update(candle: StructureCandle, feed: PivotFeed, trend: TrendlineUpdate): PatternUpdate {
    assertCandle(candle);
    assertInOrder(this.lastOpenTime, candle);
    this.lastOpenTime = candle.openTime;
    const index = this.seen;
    this.seen += 1;
    this.candles.push(candle);
    if (this.candles.length > this.params.window + 2) this.candles.shift();

    const atr = feed.atr;
    const formed: Pattern[] = [];
    const breakouts: PatternBreakout[] = [];
    const ended: PatternEnd[] = [];

    // 1. this candle against what was known at the previous one
    for (const [id, pattern] of this.reversals) {
      const found = patternBreakout(pattern, candle, atr, this.params);
      if (found) {
        breakouts.push({ ...found, index });
        this.reversals.delete(id);
        continue;
      }
      const above = pattern.invalidAbove !== null && candle.c > pattern.invalidAbove;
      const below = pattern.invalidBelow !== null && candle.c < pattern.invalidBelow;
      if (above || below) {
        ended.push({ pattern, index, reason: 'INVALIDATED' });
        this.reversals.delete(id);
      } else if (index - pattern.firstIndex > this.params.window) {
        ended.push({ pattern, index, reason: 'EXPIRED' });
        this.reversals.delete(id);
      }
    }
    for (const pattern of this.previous.values()) {
      const found = patternBreakout(pattern, candle, atr, this.params);
      if (found) {
        breakouts.push({ ...found, index });
        this.broken.add(pattern.id);
      }
    }

    const input: PatternInput = {
      candles: this.candles,
      count: this.seen,
      highs: feed.highPivots,
      lows: feed.lowPivots,
      atr,
      candleMs: this.candleMs,
      tag: this.tag,
      params: this.params,
    };

    // 2. reversal patterns whose last swing point has just been confirmed
    const fresh = (pivots: readonly Pivot[]) => pivots.filter((p) => p.confirmedIndex === index);
    for (const pivot of [...fresh(feed.highPivots), ...fresh(feed.lowPivots)]) {
      for (const pattern of [doubleExtremeFor(pivot, input), headAndShouldersFor(pivot, input)]) {
        if (!pattern) continue;
        formed.push(pattern);
        const late = this.lateBreak(pattern, pivot.index, index);
        if (late === 'INVALID') {
          ended.push({ pattern, index, reason: 'INVALIDATED' });
        } else if (late) {
          breakouts.push(late);
        } else {
          this.reversals.set(pattern.id, pattern);
        }
      }
    }

    // 3. patterns read from the current lines and levels
    const current = new Map<string, Pattern>();
    const detected = new Set<string>();
    const candidates = [
      ...trianglesOf(input, trend),
      rectangleOf(input),
      flagOf(input),
      wedgeOf(input),
    ];
    for (const pattern of candidates) {
      if (!pattern) continue;
      detected.add(pattern.id);
      if (this.broken.has(pattern.id)) continue;
      current.set(pattern.id, pattern);
      if (!this.previous.has(pattern.id)) formed.push(pattern);
    }
    for (const [id, pattern] of this.previous) {
      if (!current.has(id) && !this.broken.has(id)) ended.push({ pattern, index, reason: 'LOST' });
    }
    // a broken pattern stays broken for as long as it can still be read from the lines
    for (const id of this.broken) {
      if (!detected.has(id)) this.broken.delete(id);
    }
    this.previous = current;

    return { formed, breakouts, ended, active: this.active };
  }

  /** The break (or invalidation) of a reversal pattern between its last swing point and the candle that confirmed it. */
  private lateBreak(
    pattern: Pattern,
    lastPointIndex: number,
    index: number,
  ): PatternBreakout | 'INVALID' | null {
    const offset = this.seen - this.candles.length;
    for (let position = lastPointIndex + 1; position <= index; position += 1) {
      const candle = this.candles[position - offset];
      if (!candle) continue;
      const found = patternBreakout(pattern, candle, pattern.atr, this.params);
      if (found) return { ...found, index: position };
      const above = pattern.invalidAbove !== null && candle.c > pattern.invalidAbove;
      const below = pattern.invalidBelow !== null && candle.c < pattern.invalidBelow;
      if (above || below) return 'INVALID';
    }
    return null;
  }
}
