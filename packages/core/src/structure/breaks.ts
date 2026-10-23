import { SwingDetector } from './swings';
import {
  STRUCTURE_DEFAULTS,
  assertCandle,
  assertInOrder,
  type Direction,
  type Pivot,
  type StructureCandle,
  type StructureState,
} from './types';

export type BreakType = 'BOS' | 'CHOCH';

export interface StructureBreak {
  readonly type: BreakType;
  /** `UP` when the close is above the broken swing high, `DOWN` when it is below the broken swing low. */
  readonly direction: Direction;
  /** The structure state when the candle closed (before it confirmed any pivot of its own). */
  readonly stateBefore: StructureState;
  /** Price of the broken pivot. */
  readonly level: number;
  readonly pivot: Pivot;
  readonly index: number;
  readonly openTime: number;
  readonly close: number;
}

export interface StructureStep {
  readonly high: Pivot | null;
  readonly low: Pivot | null;
  /** The state after this candle's pivots (null until two swing highs and two swing lows exist). */
  readonly state: StructureState | null;
  readonly breaks: readonly StructureBreak[];
}

/**
 * Swing structure with breaks (docs/02 section 4). A candle that closes beyond the last confirmed
 * swing high or low (the body close counts, wicks do not) breaks it, once per pivot:
 *
 * - in `UP`: above the swing high is a BOS, below the swing low is a CHoCH;
 * - in `DOWN`: below the swing low is a BOS, above the swing high is a CHoCH;
 * - in `RANGE`: a close beyond either boundary is a BOS in that direction.
 *
 * The candle is judged against the pivots known when the previous candle closed. A pivot that was
 * already closed beyond stays broken, also while the state was still unknown, so a late candle
 * never reports an old break.
 */
export class StructureTracker {
  readonly swings: SwingDetector;
  private highBroken = false;
  private lowBroken = false;
  private bos: StructureBreak | null = null;
  private choch: StructureBreak | null = null;
  private lastOpenTime: number | null = null;

  constructor(k: number = STRUCTURE_DEFAULTS.swingK, keep: number = STRUCTURE_DEFAULTS.keptPivots) {
    this.swings = new SwingDetector(k, keep);
  }

  get count(): number {
    return this.swings.count;
  }

  get state(): StructureState | null {
    return this.swings.state;
  }

  /** The latest break of structure and the latest change of character seen so far. */
  get lastBos(): StructureBreak | null {
    return this.bos;
  }

  get lastChoch(): StructureBreak | null {
    return this.choch;
  }

  update(candle: StructureCandle): StructureStep {
    assertCandle(candle);
    assertInOrder(this.lastOpenTime, candle);
    this.lastOpenTime = candle.openTime;

    const stateBefore = this.swings.state;
    const index = this.swings.count;
    const breaks: StructureBreak[] = [];
    const lastHigh = this.swings.lastHigh;
    const lastLow = this.swings.lastLow;

    if (lastHigh && !this.highBroken && candle.c > lastHigh.price) {
      this.highBroken = true;
      if (stateBefore !== null) {
        breaks.push({
          type: stateBefore === 'DOWN' ? 'CHOCH' : 'BOS',
          direction: 'UP',
          stateBefore,
          level: lastHigh.price,
          pivot: lastHigh,
          index,
          openTime: candle.openTime,
          close: candle.c,
        });
      }
    }
    if (lastLow && !this.lowBroken && candle.c < lastLow.price) {
      this.lowBroken = true;
      if (stateBefore !== null) {
        breaks.push({
          type: stateBefore === 'UP' ? 'CHOCH' : 'BOS',
          direction: 'DOWN',
          stateBefore,
          level: lastLow.price,
          pivot: lastLow,
          index,
          openTime: candle.openTime,
          close: candle.c,
        });
      }
    }
    for (const event of breaks) {
      if (event.type === 'BOS') this.bos = event;
      else this.choch = event;
    }

    const { high, low } = this.swings.update(candle);
    if (high) this.highBroken = false;
    if (low) this.lowBroken = false;
    return { high, low, state: this.swings.state, breaks };
  }
}
