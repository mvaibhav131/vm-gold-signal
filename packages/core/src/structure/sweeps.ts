import {
  STRUCTURE_DEFAULTS,
  assertCandle,
  assertInOrder,
  atLeast,
  type Direction,
  type StructureCandle,
  type StructureParams,
} from './types';

/**
 * A price where stops are expected to rest. The caller supplies the levels (previous-day high and
 * low, session highs and lows, equal highs and lows: phase B7) and stops supplying one once price
 * has broken it for good.
 */
export interface LiquidityLevel {
  /** Stable identity: a level sweeps at most once while it is supplied under the same id. */
  readonly id: string;
  /** `LOW` is liquidity below the price (stops of longs), `HIGH` is above it. */
  readonly side: 'HIGH' | 'LOW';
  readonly price: number;
}

/** A completed sweep and reclaim. */
export interface SweepReclaim {
  /** `UP` is the bullish version (a low was swept and reclaimed), `DOWN` the bearish one. */
  readonly direction: Direction;
  readonly levelId: string;
  readonly level: number;
  /** The candle that traded beyond the level by the required depth. */
  readonly sweepIndex: number;
  readonly sweepOpenTime: number;
  /** The candle that closed back on the right side (the sweep candle itself, or within 3 candles after it). */
  readonly reclaimIndex: number;
  readonly reclaimOpenTime: number;
  /** The most extreme price from the sweep candle to the reclaim candle (the sweep low for a bullish sweep). */
  readonly extreme: number;
  /** How far beyond the level price went, in price. */
  readonly depth: number;
  /** The depth in ATRs, with the ATR as of the sweep candle. */
  readonly depthAtr: number;
  /** The wick of the sweep candle beyond its body, as a share of its range. */
  readonly wickRatio: number;
}

interface Pending {
  readonly level: LiquidityLevel;
  readonly direction: Direction;
  readonly sweepIndex: number;
  readonly sweepOpenTime: number;
  readonly atr: number;
  readonly wickRatio: number;
  extreme: number;
}

/**
 * Sweep and reclaim (docs/02 section 4). Bullish at a liquidity low L: a candle trades below L by
 * at least 0.10 x ATR with a lower wick of at least 50% of its range (the sweep candle), and that
 * candle or one of the next 3 closes back above L (the reclaim). Bearish is the mirror at a high.
 * A level can sweep once; after a qualifying sweep it is spent, whether or not it was reclaimed.
 * The event is reported on the reclaim candle, so a strategy can wait for its own trigger after it.
 */
export class SweepTracker {
  private pending: Pending[] = [];
  private readonly spent = new Set<string>();
  private seen = 0;
  private lastOpenTime: number | null = null;

  constructor(private readonly params: StructureParams['sweep'] = STRUCTURE_DEFAULTS.sweep) {}

  get count(): number {
    return this.seen;
  }

  /** Sweeps waiting for their reclaim. */
  get waiting(): readonly { levelId: string; direction: Direction; sweepIndex: number }[] {
    return this.pending.map((p) => ({
      levelId: p.level.id,
      direction: p.direction,
      sweepIndex: p.sweepIndex,
    }));
  }

  update(
    candle: StructureCandle,
    atr: number | null,
    levels: readonly LiquidityLevel[] = [],
  ): readonly SweepReclaim[] {
    assertCandle(candle);
    assertInOrder(this.lastOpenTime, candle);
    for (const level of levels) {
      if (level.id === '') throw new RangeError('a liquidity level needs an id');
      if (!Number.isFinite(level.price))
        throw new RangeError('a liquidity level needs a finite price');
    }
    this.lastOpenTime = candle.openTime;
    const index = this.seen;
    this.seen += 1;
    const events: SweepReclaim[] = [];

    const stillWaiting: Pending[] = [];
    for (const sweep of this.pending) {
      const bullish = sweep.direction === 'UP';
      sweep.extreme = bullish
        ? Math.min(sweep.extreme, candle.l)
        : Math.max(sweep.extreme, candle.h);
      const reclaimed = bullish ? candle.c > sweep.level.price : candle.c < sweep.level.price;
      if (reclaimed) events.push(this.event(sweep, index, candle.openTime));
      else if (index < sweep.sweepIndex + this.params.reclaimWithin) stillWaiting.push(sweep);
    }
    this.pending = stillWaiting;

    const range = candle.h - candle.l;
    if (atr !== null && atr > 0 && range > 0) {
      for (const level of levels) {
        if (this.spent.has(level.id)) continue;
        const bullish = level.side === 'LOW';
        const depth = bullish ? level.price - candle.l : candle.h - level.price;
        const wick = bullish
          ? Math.min(candle.o, candle.c) - candle.l
          : candle.h - Math.max(candle.o, candle.c);
        const wickRatio = wick / range;
        if (!atLeast(depth, this.params.minDepthAtr * atr)) continue;
        if (!atLeast(wickRatio, this.params.minWickRatio)) continue;

        this.spent.add(level.id);
        const sweep: Pending = {
          level,
          direction: bullish ? 'UP' : 'DOWN',
          sweepIndex: index,
          sweepOpenTime: candle.openTime,
          atr,
          wickRatio,
          extreme: bullish ? candle.l : candle.h,
        };
        const reclaimed = bullish ? candle.c > level.price : candle.c < level.price;
        if (reclaimed) events.push(this.event(sweep, index, candle.openTime));
        else if (this.params.reclaimWithin > 0) this.pending.push(sweep);
      }
    }

    // A level that is no longer supplied can be spent again if it ever comes back.
    const supplied = new Set(levels.map((level) => level.id));
    for (const id of this.spent) {
      if (!supplied.has(id) && !this.pending.some((p) => p.level.id === id)) this.spent.delete(id);
    }
    return events;
  }

  private event(sweep: Pending, reclaimIndex: number, reclaimOpenTime: number): SweepReclaim {
    const depth =
      sweep.direction === 'UP'
        ? sweep.level.price - sweep.extreme
        : sweep.extreme - sweep.level.price;
    return {
      direction: sweep.direction,
      levelId: sweep.level.id,
      level: sweep.level.price,
      sweepIndex: sweep.sweepIndex,
      sweepOpenTime: sweep.sweepOpenTime,
      reclaimIndex,
      reclaimOpenTime,
      extreme: sweep.extreme,
      depth,
      depthAtr: depth / sweep.atr,
      wickRatio: sweep.wickRatio,
    };
  }
}
