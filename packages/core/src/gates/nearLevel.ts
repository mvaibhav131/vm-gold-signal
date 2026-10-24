import type { Side } from '../domain';
import { assertFinite } from '../indicators/types';
import { roundLevelsAround } from '../levels/roundNumbers';
import { atLeast } from '../structure/types';

/** The NEAR_LEVEL flag of docs/02 section 6: how close and which levels count as major. */
export interface NearLevelParams {
  /** The entry is within this many ATR(5m) of the level. */
  readonly distanceAtr: number;
  /** Round numbers of these steps are major ($10 levels are too many to matter). */
  readonly roundSteps: readonly number[];
  /** A zone with at least this many swing points is major. */
  readonly zoneMinTouches: number;
}

export const NEAR_LEVEL_DEFAULTS: NearLevelParams = {
  distanceAtr: 0.3,
  roundSteps: [50, 100],
  zoneMinTouches: 3,
};

export type MajorLevelKind = 'LIQUIDITY' | 'ZONE' | 'ROUND';

export interface NearLevel {
  readonly id: string;
  readonly kind: MajorLevelKind;
  /** The level, or the edge of a zone that faces the entry. */
  readonly price: number;
  /** Distance from the entry in ATR(5m); 0 when the entry lies inside a zone. */
  readonly distanceAtr: number;
}

export interface NearLevelInput {
  readonly side: Side;
  readonly entry: number;
  readonly atr5: number | null;
  /** The liquidity levels of the book (previous day, Asia and London sessions, equal highs and lows): all major. */
  readonly liquidity: readonly { readonly id: string; readonly price: number }[];
  readonly zones: readonly {
    readonly id: string;
    readonly bottom: number;
    readonly top: number;
    readonly touches: number;
  }[];
  /** The level that the setup itself sweeps: it is the reason for the trade, not an obstacle. */
  readonly sweptLevelId?: string;
}

/**
 * The nearest major level that stands in the way of the trade within `distanceAtr` x ATR(5m) of the
 * entry, or null. In the way means ahead of the entry in the direction of the trade (above it for a
 * BUY, below it for a SELL) or, for a zone, around it. A level behind the entry is support, not an
 * obstacle. The level that the setup sweeps is left out. Without an ATR nothing can be judged.
 */
export function nearOpposingLevel(
  input: NearLevelInput,
  params: NearLevelParams = NEAR_LEVEL_DEFAULTS,
): NearLevel | null {
  assertFinite(input.entry, 'entry');
  const { atr5 } = input;
  if (atr5 === null || !(atr5 > 0)) return null;
  const toward = input.side === 'BUY' ? 1 : -1;
  const ahead = (price: number) => (price - input.entry) * toward;
  const found: NearLevel[] = [];
  const add = (id: string, kind: MajorLevelKind, price: number, distance: number) => {
    if (id === input.sweptLevelId) return;
    if (!atLeast(params.distanceAtr * atr5, distance)) return;
    found.push({ id, kind, price, distanceAtr: Math.max(0, distance) / atr5 });
  };

  for (const level of input.liquidity) {
    const distance = ahead(level.price);
    if (distance >= 0) add(level.id, 'LIQUIDITY', level.price, distance);
  }
  for (const zone of input.zones) {
    if (zone.touches < params.zoneMinTouches) continue;
    const near = input.side === 'BUY' ? zone.bottom : zone.top;
    const far = input.side === 'BUY' ? zone.top : zone.bottom;
    // An entry that is already beyond the far edge has left the zone behind.
    if (ahead(far) < 0) continue;
    add(zone.id, 'ZONE', near, Math.max(0, ahead(near)));
  }
  for (const round of roundLevelsAround(input.entry, params.roundSteps)) {
    const distance = ahead(round.price);
    if (distance >= 0) add(`ROUND:${String(round.price)}`, 'ROUND', round.price, distance);
  }

  found.sort((a, b) => a.distanceAtr - b.distanceAtr || (a.id < b.id ? -1 : 1));
  return found[0] ?? null;
}
