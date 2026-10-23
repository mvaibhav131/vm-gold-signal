import {
  STRUCTURE_DEFAULTS,
  assertCandle,
  assertInOrder,
  type Direction,
  type StructureCandle,
  type StructureParams,
} from './types';

export type BlockStatus = 'OPEN' | 'TOUCHED' | 'INVALIDATED';

/** The last opposite candle before a displacement candle. */
export interface OrderBlock {
  /** `UP` is a bullish block (a down candle before an upward displacement), `DOWN` the mirror. */
  readonly direction: Direction;
  /** High and low of the block candle: the zone is its full range. */
  readonly top: number;
  readonly bottom: number;
  readonly open: number;
  readonly close: number;
  /** The block candle. */
  readonly index: number;
  readonly openTime: number;
  readonly displacementIndex: number;
  readonly displacementOpenTime: number;
  readonly status: BlockStatus;
  readonly touchedIndex: number | null;
  readonly invalidatedIndex: number | null;
}

export interface OrderBlockUpdate {
  /** The block found for the displacement candle of this update. */
  readonly created: OrderBlock | null;
  /** Open blocks that this candle traded back into for the first time. */
  readonly touched: readonly OrderBlock[];
  /** Blocks that this candle closed through (they leave the active list). */
  readonly invalidated: readonly OrderBlock[];
}

interface Remembered {
  readonly index: number;
  readonly openTime: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

/**
 * Order blocks (docs/02 section 3, research only). When a candle is a displacement, the block is
 * the last candle of the opposite colour among the `lookback` candles before it (a down candle for
 * an upward displacement). Its zone is the full range of that candle. The same block candle is not
 * reported twice for the same direction. Later candles touch the block when they trade into it
 * and invalidate it when they close beyond its far edge.
 */
export class OrderBlockTracker {
  private blocks: OrderBlock[] = [];
  private recent: Remembered[] = [];
  private readonly lastBlockIndex: Record<Direction, number | null> = { UP: null, DOWN: null };
  private seen = 0;
  private lastOpenTime: number | null = null;

  constructor(
    private readonly params: StructureParams['orderBlock'] = STRUCTURE_DEFAULTS.orderBlock,
  ) {}

  get count(): number {
    return this.seen;
  }

  /** Blocks not yet invalidated, oldest first (at most `maxActive`). */
  get active(): readonly OrderBlock[] {
    return this.blocks;
  }

  /** `displacement` is the direction of this candle's displacement, or null if it is not one. */
  update(candle: StructureCandle, displacement: Direction | null): OrderBlockUpdate {
    assertCandle(candle);
    assertInOrder(this.lastOpenTime, candle);
    this.lastOpenTime = candle.openTime;
    const index = this.seen;
    this.seen += 1;

    const touched: OrderBlock[] = [];
    const invalidated: OrderBlock[] = [];
    const remaining: OrderBlock[] = [];
    for (const block of this.blocks) {
      const up = block.direction === 'UP';
      const breaks = up ? candle.c < block.bottom : candle.c > block.top;
      const enters = up ? candle.l < block.top : candle.h > block.bottom;
      if (breaks) {
        invalidated.push({
          ...block,
          status: 'INVALIDATED',
          touchedIndex: block.touchedIndex ?? index,
          invalidatedIndex: index,
        });
      } else if (enters && block.status === 'OPEN') {
        const next: OrderBlock = { ...block, status: 'TOUCHED', touchedIndex: index };
        touched.push(next);
        remaining.push(next);
      } else {
        remaining.push(block);
      }
    }

    let created: OrderBlock | null = null;
    if (displacement !== null) {
      const source = this.findBlockCandle(displacement);
      if (source !== null && source.index !== this.lastBlockIndex[displacement]) {
        this.lastBlockIndex[displacement] = source.index;
        created = {
          direction: displacement,
          top: source.h,
          bottom: source.l,
          open: source.o,
          close: source.c,
          index: source.index,
          openTime: source.openTime,
          displacementIndex: index,
          displacementOpenTime: candle.openTime,
          status: 'OPEN',
          touchedIndex: null,
          invalidatedIndex: null,
        };
        remaining.push(created);
      }
    }
    this.blocks = remaining.slice(-this.params.maxActive);

    this.recent.push({
      index,
      openTime: candle.openTime,
      o: candle.o,
      h: candle.h,
      l: candle.l,
      c: candle.c,
    });
    if (this.recent.length > this.params.lookback) this.recent.shift();
    return { created, touched, invalidated };
  }

  private findBlockCandle(displacement: Direction): Remembered | null {
    for (let i = this.recent.length - 1; i >= 0; i -= 1) {
      const candle = this.recent[i];
      if (!candle) continue;
      if (displacement === 'UP' ? candle.c < candle.o : candle.c > candle.o) return candle;
    }
    return null;
  }
}
