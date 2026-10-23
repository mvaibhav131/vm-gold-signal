import { TOLERANCE, type Pivot } from '../structure/types';
import { LEVEL_DEFAULTS, type LevelParams } from './types';

/** A swing from one confirmed pivot to the next of the other kind. */
export interface ImpulseLeg {
  readonly from: Pivot;
  readonly to: Pivot;
  /** `UP` runs from a swing low to a swing high. */
  readonly direction: 'UP' | 'DOWN';
  readonly size: number;
  readonly sizeAtr: number;
}

/**
 * The swing sequence: the confirmed highs and lows in time order, with consecutive pivots of the
 * same kind collapsed into the more extreme one (the earlier one if they are equal). If one candle
 * is both a swing high and a swing low, the order that keeps high and low alternating is used.
 */
export function swingSequence(highs: readonly Pivot[], lows: readonly Pivot[]): Pivot[] {
  const byIndex = new Map<number, Pivot[]>();
  for (const pivot of [...highs, ...lows]) {
    byIndex.set(pivot.index, [...(byIndex.get(pivot.index) ?? []), pivot]);
  }
  const sequence: Pivot[] = [];
  const push = (pivot: Pivot) => {
    const last = sequence.at(-1);
    if (last?.kind !== pivot.kind) {
      sequence.push(pivot);
      return;
    }
    const better = pivot.kind === 'HIGH' ? pivot.price > last.price : pivot.price < last.price;
    if (better) sequence[sequence.length - 1] = pivot;
  };
  for (const index of [...byIndex.keys()].sort((a, b) => a - b)) {
    const group = byIndex.get(index) ?? [];
    if (group.length === 2) {
      const lastKind = sequence.at(-1)?.kind ?? 'LOW';
      group.sort((a, b) => (a.kind === lastKind ? 1 : 0) - (b.kind === lastKind ? 1 : 0));
    }
    for (const pivot of group) push(pivot);
  }
  return sequence;
}

/**
 * The last confirmed impulse leg (docs/02 section 4.1): the most recent swing, low to high or high
 * to low, that is at least 2.5 x ATR(15m) long. `direction` limits the search to up legs (for a
 * pullback to buy) or down legs. Null if there is none.
 */
export function lastImpulseLeg(input: {
  readonly highs: readonly Pivot[];
  readonly lows: readonly Pivot[];
  readonly atr: number | null;
  readonly direction?: 'UP' | 'DOWN';
  readonly params?: LevelParams['fibonacci'];
}): ImpulseLeg | null {
  const params = input.params ?? LEVEL_DEFAULTS.fibonacci;
  const { atr } = input;
  if (atr === null || !(atr > 0)) return null;
  const sequence = swingSequence(input.highs, input.lows);
  for (let i = sequence.length - 1; i >= 1; i -= 1) {
    const to = sequence[i];
    const from = sequence[i - 1];
    if (!to || !from) continue;
    const direction = to.kind === 'HIGH' ? 'UP' : 'DOWN';
    if (input.direction && input.direction !== direction) continue;
    const size = Math.abs(to.price - from.price);
    if (size >= params.minLegAtr * atr - TOLERANCE) {
      return { from, to, direction, size, sizeAtr: size / atr };
    }
  }
  return null;
}

export interface FibonacciLevel {
  readonly ratio: number;
  readonly price: number;
}

export interface PriceBand {
  readonly bottom: number;
  readonly top: number;
}

export interface Fibonacci {
  readonly leg: ImpulseLeg;
  /** Prices a pullback of the leg is expected to reach: 38.2, 50, 61.8 and 78.6 percent back. */
  readonly retracements: readonly FibonacciLevel[];
  /** Between the 61.8 and the 78.6 retracement. */
  readonly entryZone: PriceBand;
  /** Between the 38.2 and the 61.8 retracement (the value zone of a pullback). */
  readonly valueZone: PriceBand;
  /** Targets beyond the end of the leg: 127.2 and 161.8 percent of it, measured from its start. */
  readonly extensions: readonly FibonacciLevel[];
}

/** Retracement and extension levels of an impulse leg. */
export function fibonacciOf(
  leg: ImpulseLeg,
  params: LevelParams['fibonacci'] = LEVEL_DEFAULTS.fibonacci,
): Fibonacci {
  const sign = leg.direction === 'UP' ? 1 : -1;
  const retrace = (ratio: number) => leg.to.price - sign * ratio * leg.size;
  const band = (a: number, b: number): PriceBand => {
    const [x, y] = [retrace(a), retrace(b)];
    return { bottom: Math.min(x, y), top: Math.max(x, y) };
  };
  return {
    leg,
    retracements: params.retracements.map((ratio) => ({ ratio, price: retrace(ratio) })),
    entryZone: band(params.entry[0], params.entry[1]),
    valueZone: band(params.value[0], params.value[1]),
    extensions: params.extensions.map((ratio) => ({
      ratio,
      price: leg.from.price + sign * ratio * leg.size,
    })),
  };
}
