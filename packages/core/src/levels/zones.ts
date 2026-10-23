import { TOLERANCE, type Pivot, type PivotKind } from '../structure/types';
import { LEVEL_DEFAULTS, ZONE_TIMEFRAMES, type LevelParams, type ZoneTimeframe } from './types';

/** The swing points of one timeframe. */
export interface ZoneSource {
  readonly tf: ZoneTimeframe;
  /** Confirmed swing points, of both kinds. */
  readonly pivots: readonly Pivot[];
  /** How many candles of this timeframe have been processed. */
  readonly count: number;
}

/** A close of the 15m series: used to find out whether price has gone through a zone. */
export interface CloseSample {
  readonly openTime: number;
  readonly c: number;
}

export type ZoneRole = 'SUPPORT' | 'RESISTANCE';

export interface ZonePoint {
  readonly tf: ZoneTimeframe;
  readonly kind: PivotKind;
  readonly price: number;
  readonly index: number;
  readonly openTime: number;
  /** Timeframe weight x recency weight. */
  readonly weight: number;
}

export interface Zone {
  /** Follows the oldest swing point of the zone. */
  readonly id: string;
  /** The cluster range padded by 0.05 x ATR on each side. */
  readonly bottom: number;
  readonly top: number;
  readonly role: ZoneRole;
  /** The role from the kind of swing points alone (see `buildZones`). */
  readonly baseRole: ZoneRole;
  /** The role is not the base role because a close went through the zone. */
  readonly flipped: boolean;
  readonly touches: number;
  /** Sum of the weights of its points. */
  readonly strength: number;
  readonly timeframes: readonly ZoneTimeframe[];
  readonly points: readonly ZonePoint[];
  readonly newestOpenTime: number;
}

export interface ZoneInput {
  readonly sources: readonly ZoneSource[];
  /** Closes of the 15m series, oldest first. */
  readonly closes: readonly CloseSample[];
  /** ATR(15m). Null while it warms up: no zones. */
  readonly atr: number | null;
  readonly params?: LevelParams['zones'];
}

/**
 * Support and resistance zones (docs/02 section 4.1). Swing points of the last 300 5m, 200 15m and
 * 150 1h candles are clustered by price: points that lie within 0.25 x ATR(15m) of each other
 * (growing from the lowest price upward, so a cluster is never wider than that) form a zone when
 * there are at least two of them; the zone is the cluster range padded by 0.05 x ATR. Strength is
 * the sum over its points of the timeframe weight (1h 3, 15m 2, 5m 1) times a recency weight that
 * halves every 100 candles of the point's own timeframe.
 *
 * Role: the base role is RESISTANCE when most points are swing highs and SUPPORT when most are
 * swing lows (a tie follows the latest close: above the zone middle is SUPPORT). A close beyond the
 * zone by at least 0.2 x ATR, after its newest swing point, flips it: the latest such close decides,
 * above the zone makes it SUPPORT and below it RESISTANCE. Strongest zone first.
 */
export function buildZones(input: ZoneInput): Zone[] {
  const params = input.params ?? LEVEL_DEFAULTS.zones;
  const { atr } = input;
  if (atr === null || !(atr > 0)) return [];

  const points: ZonePoint[] = [];
  for (const source of input.sources) {
    const oldest = source.count - params.windows[source.tf];
    for (const pivot of source.pivots) {
      if (pivot.index < oldest) continue;
      const age = source.count - 1 - pivot.index;
      points.push({
        tf: source.tf,
        kind: pivot.kind,
        price: pivot.price,
        index: pivot.index,
        openTime: pivot.openTime,
        weight: params.weights[source.tf] * 0.5 ** (age / params.halfLife),
      });
    }
  }
  const timeframeRank = (tf: ZoneTimeframe) => ZONE_TIMEFRAMES.indexOf(tf);
  points.sort(
    (a, b) =>
      a.price - b.price || a.openTime - b.openTime || timeframeRank(a.tf) - timeframeRank(b.tf),
  );

  const tolerance = params.toleranceAtr * atr + TOLERANCE;
  const pad = params.padAtr * atr;
  const flip = params.flipAtr * atr;
  const lastClose = input.closes.at(-1)?.c ?? null;
  const zones: Zone[] = [];

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
    if (to - from + 1 < params.minPoints) {
      from += 1;
      continue;
    }
    const members = points.slice(from, to + 1);
    from = to + 1;

    const prices = members.map((p) => p.price);
    const bottom = Math.min(...prices) - pad;
    const top = Math.max(...prices) + pad;
    const newestOpenTime = Math.max(...members.map((p) => p.openTime));
    const highs = members.filter((p) => p.kind === 'HIGH').length;
    const lows = members.length - highs;
    const baseRole: ZoneRole =
      highs > lows
        ? 'RESISTANCE'
        : lows > highs
          ? 'SUPPORT'
          : lastClose !== null && lastClose > (bottom + top) / 2
            ? 'SUPPORT'
            : 'RESISTANCE';

    let role = baseRole;
    for (let i = input.closes.length - 1; i >= 0; i -= 1) {
      const sample = input.closes[i];
      if (!sample || sample.openTime <= newestOpenTime) break;
      if (sample.c >= top + flip - TOLERANCE) {
        role = 'SUPPORT';
        break;
      }
      if (sample.c <= bottom - flip + TOLERANCE) {
        role = 'RESISTANCE';
        break;
      }
    }

    const oldest = [...members].sort(
      (a, b) => a.openTime - b.openTime || timeframeRank(a.tf) - timeframeRank(b.tf),
    )[0];
    zones.push({
      id: `zone:${oldest?.tf ?? ''}:${String(oldest?.index ?? 0)}`,
      bottom,
      top,
      role,
      baseRole,
      flipped: role !== baseRole,
      touches: members.length,
      strength: members.reduce((sum, p) => sum + p.weight, 0),
      timeframes: ZONE_TIMEFRAMES.filter((tf) => members.some((p) => p.tf === tf)),
      points: members,
      newestOpenTime,
    });
  }
  return zones.sort((a, b) => b.strength - a.strength || a.bottom - b.bottom);
}

/** Distance from a price to a zone in ATRs: 0 inside it. */
export function zoneDistanceAtr(
  zone: Pick<Zone, 'bottom' | 'top'>,
  price: number,
  atr: number,
): number {
  if (!(atr > 0)) throw new RangeError('atr must be above zero');
  if (price > zone.top) return (price - zone.top) / atr;
  if (price < zone.bottom) return (zone.bottom - price) / atr;
  return 0;
}
