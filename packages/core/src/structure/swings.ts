import { RollingWindow, assertPeriod } from '../indicators/types';
import {
  STRUCTURE_DEFAULTS,
  assertCandle,
  assertInOrder,
  type Pivot,
  type PivotKind,
  type PivotLabel,
  type StructureCandle,
  type StructureState,
} from './types';

/**
 * The structure state from the last two confirmed swing highs and the last two confirmed swing
 * lows: `UP` when both rise, `DOWN` when both fall, otherwise `RANGE` (an equal pivot counts as
 * neither). Null until there are two pivots of each kind.
 */
export function structureState(
  highs: readonly Pivot[],
  lows: readonly Pivot[],
): StructureState | null {
  const [highBefore, highNow] = highs.slice(-2);
  const [lowBefore, lowNow] = lows.slice(-2);
  if (!highBefore || !highNow || !lowBefore || !lowNow) return null;
  if (highNow.price > highBefore.price && lowNow.price > lowBefore.price) return 'UP';
  if (highNow.price < highBefore.price && lowNow.price < lowBefore.price) return 'DOWN';
  return 'RANGE';
}

function labelOf(kind: PivotKind, price: number, previous: Pivot | null): PivotLabel | null {
  if (previous === null) return null;
  if (kind === 'HIGH') return price > previous.price ? 'HH' : price < previous.price ? 'LH' : 'EH';
  return price > previous.price ? 'HL' : price < previous.price ? 'LL' : 'EL';
}

export interface SwingUpdate {
  /** The swing high that this candle's close confirmed, if any. */
  readonly high: Pivot | null;
  /** The swing low that this candle's close confirmed, if any. */
  readonly low: Pivot | null;
}

/**
 * Swing pivots (fractals), docs/02 section 4: candle j is a swing high when its high is strictly
 * above the highs of the `k` candles before and after it (swing low: strictly below the lows). It
 * becomes known when candle `j + k` closes, never earlier, so this class cannot look ahead. One
 * candle can confirm a swing high and a swing low at once (an outside bar).
 */
export class SwingDetector {
  /** Candles needed before the first pivot can be confirmed. */
  readonly warmup: number;
  private readonly highs: RollingWindow;
  private readonly lows: RollingWindow;
  private readonly times: RollingWindow;
  private readonly highList: Pivot[] = [];
  private readonly lowList: Pivot[] = [];
  private seen = 0;
  private lastOpenTime: number | null = null;

  constructor(
    readonly k: number = STRUCTURE_DEFAULTS.swingK,
    private readonly keep: number = STRUCTURE_DEFAULTS.keptPivots,
  ) {
    assertPeriod(k, 'k');
    assertPeriod(keep, 'keptPivots', 2);
    this.warmup = 2 * k + 1;
    this.highs = new RollingWindow(this.warmup);
    this.lows = new RollingWindow(this.warmup);
    this.times = new RollingWindow(this.warmup);
  }

  get count(): number {
    return this.seen;
  }

  /** Confirmed swing highs, oldest first (the newest `keptPivots`). */
  get highPivots(): readonly Pivot[] {
    return this.highList;
  }

  get lowPivots(): readonly Pivot[] {
    return this.lowList;
  }

  get lastHigh(): Pivot | null {
    return this.highList.at(-1) ?? null;
  }

  get lastLow(): Pivot | null {
    return this.lowList.at(-1) ?? null;
  }

  get state(): StructureState | null {
    return structureState(this.highList, this.lowList);
  }

  update(candle: StructureCandle): SwingUpdate {
    assertCandle(candle);
    assertInOrder(this.lastOpenTime, candle);
    this.lastOpenTime = candle.openTime;
    const index = this.seen;
    this.seen += 1;
    this.highs.push(candle.h);
    this.lows.push(candle.l);
    this.times.push(candle.openTime);
    if (!this.highs.full) return { high: null, low: null };

    const centre = this.k;
    const centreHigh = this.highs.at(centre);
    const centreLow = this.lows.at(centre);
    let isHigh = true;
    let isLow = true;
    for (let p = 0; p < this.warmup; p += 1) {
      if (p === centre) continue;
      if (this.highs.at(p) >= centreHigh) isHigh = false;
      if (this.lows.at(p) <= centreLow) isLow = false;
    }

    const make = (kind: PivotKind, price: number, previous: Pivot | null): Pivot => ({
      kind,
      price,
      index: index - this.k,
      openTime: this.times.at(centre),
      confirmedIndex: index,
      confirmedOpenTime: candle.openTime,
      label: labelOf(kind, price, previous),
    });
    const high = isHigh ? make('HIGH', centreHigh, this.lastHigh) : null;
    const low = isLow ? make('LOW', centreLow, this.lastLow) : null;
    if (high) this.remember(this.highList, high);
    if (low) this.remember(this.lowList, low);
    return { high, low };
  }

  private remember(list: Pivot[], pivot: Pivot): void {
    list.push(pivot);
    if (list.length > this.keep) list.shift();
  }
}
