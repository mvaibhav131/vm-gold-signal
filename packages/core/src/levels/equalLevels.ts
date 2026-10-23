import { TOLERANCE, type Pivot, type PivotKind } from '../structure/types';
import { LEVEL_DEFAULTS, type LevelParams } from './types';

/** Two or more swing highs (or lows) at almost the same price: stops are expected to rest beyond them. */
export interface EqualLevel {
  /** Stable while the group keeps its oldest swing point. */
  readonly id: string;
  /** `HIGH`: equal highs, the liquidity is above. `LOW`: equal lows, below. */
  readonly side: 'HIGH' | 'LOW';
  /** The highest of the equal highs, or the lowest of the equal lows: the price that stops sit beyond. */
  readonly price: number;
  /** The highest minus the lowest swing point of the group. */
  readonly spread: number;
  readonly touches: number;
  /** Oldest first. */
  readonly members: readonly Pivot[];
  readonly firstIndex: number;
  readonly lastIndex: number;
}

export interface EqualLevelInput {
  /** Confirmed swing points, of both kinds, of one timeframe. */
  readonly pivots: readonly Pivot[];
  /** ATR of that timeframe (null while it warms up: nothing is found). */
  readonly atr: number | null;
  /** How many candles of that timeframe have been processed. */
  readonly count: number;
  /** Keeps ids apart between timeframes, for example `5m`. */
  readonly tag?: string;
  readonly params?: LevelParams['equal'];
}

/**
 * Equal highs and equal lows (docs/02 sections 3 and 4): two or more swing highs (lows) of the last
 * `lookback` candles whose prices lie within 0.15 x ATR of each other. Clusters grow from the
 * lowest price upward, so a group is never wider than the tolerance. Most recent group first.
 */
export function findEqualLevels(input: EqualLevelInput): EqualLevel[] {
  const params = input.params ?? LEVEL_DEFAULTS.equal;
  const { atr, count } = input;
  if (atr === null || !(atr > 0)) return [];
  const tolerance = params.toleranceAtr * atr + TOLERANCE;
  const oldest = count - params.lookback;
  const found: EqualLevel[] = [];

  for (const kind of ['HIGH', 'LOW'] as const satisfies readonly PivotKind[]) {
    const points = input.pivots
      .filter((p) => p.kind === kind && p.index >= oldest)
      .sort((a, b) => a.price - b.price || a.index - b.index);
    let from = 0;
    while (from < points.length) {
      const first = points[from];
      if (!first) break;
      let to = from;
      while (
        to + 1 < points.length &&
        (points[to + 1]?.price ?? Infinity) - first.price <= tolerance
      ) {
        to += 1;
      }
      if (to - from + 1 >= params.minPoints) {
        const members = points.slice(from, to + 1).sort((a, b) => a.index - b.index);
        const prices = members.map((p) => p.price);
        const firstIndex = members[0]?.index ?? 0;
        found.push({
          id: `${input.tag ?? ''}EQ${kind === 'HIGH' ? 'H' : 'L'}:${String(firstIndex)}`,
          side: kind,
          price: kind === 'HIGH' ? Math.max(...prices) : Math.min(...prices),
          spread: Math.max(...prices) - Math.min(...prices),
          touches: members.length,
          members,
          firstIndex,
          lastIndex: members.at(-1)?.index ?? firstIndex,
        });
        from = to + 1;
      } else {
        from += 1;
      }
    }
  }
  return found.sort((a, b) => b.lastIndex - a.lastIndex || a.price - b.price);
}
