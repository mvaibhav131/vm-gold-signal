import type { TickPoint } from '../calendar/gold';

/** A tick counts for a moment when it is at most this old at that moment. */
export const IMPACT_TICK_TOLERANCE_MS = 30_000;
/** The horizons at which gold is measured after a headline. */
export const IMPACT_HORIZONS_MS = [120_000, 300_000, 600_000] as const;
export const IMPACT_WINDOW_MS = 600_000;

const mid = (tick: TickPoint): number => (tick.bid + tick.ask) / 2;
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

function lastAtOrBefore(
  ticks: readonly TickPoint[],
  moment: number,
  toleranceMs: number,
): TickPoint | null {
  let found: TickPoint | null = null;
  for (const tick of ticks) {
    if (tick.ts > moment || moment - tick.ts > toleranceMs) continue;
    if (found === null || tick.ts >= found.ts) found = tick;
  }
  return found;
}

/** What gold did after a headline (02 section 16, "Relevance filter and measured impact"), in USD. */
export interface ImpactSample {
  /** Signed moves 2, 5 and 10 minutes after the time; null where no tick was near that moment. */
  readonly move2m: number | null;
  readonly move5m: number | null;
  readonly move10m: number;
  /** The largest distance from the price at the time within the 10 minutes. */
  readonly maxAbs10m: number;
}

/**
 * Gold's move after `at`: from the last tick at or before it to the last tick at or before 2, 5 and 10
 * minutes later, and the largest excursion within the 10 minutes. Null unless there is a tick near
 * `at` and one near the 10-minute mark (the recorder was down, the market was closed): a missing
 * measure is never made up. A horizon whose last tick is not after `at` is null.
 */
export function impactSampleOf(
  ticks: readonly TickPoint[],
  at: number,
  toleranceMs: number = IMPACT_TICK_TOLERANCE_MS,
): ImpactSample | null {
  const start = lastAtOrBefore(ticks, at, toleranceMs);
  if (start === null) return null;
  const reference = mid(start);
  const moveAt = (horizon: number): number | null => {
    const tick = lastAtOrBefore(ticks, at + horizon, toleranceMs);
    return tick === null || tick.ts <= at ? null : round3(mid(tick) - reference);
  };
  const [h2, h5, h10] = IMPACT_HORIZONS_MS;
  const move10m = moveAt(h10);
  if (move10m === null) return null;
  let maxAbs = 0;
  for (const tick of ticks) {
    if (tick.ts > at && tick.ts <= at + IMPACT_WINDOW_MS) {
      maxAbs = Math.max(maxAbs, Math.abs(mid(tick) - reference));
    }
  }
  return { move2m: moveAt(h2), move5m: moveAt(h5), move10m, maxAbs10m: round3(maxAbs) };
}

/** Gold since a headline was published, for its alert: the move in USD and in ATR(5m), and the spread now. */
export interface MoveSince {
  readonly usd: number;
  readonly atr: number | null;
  readonly spread: number | null;
}

/**
 * The move of gold from the last tick at or before `at` to the last tick at or before `now`
 * (each at most 30 seconds old at its moment). Null without a tick at either moment, or when
 * the later tick is not after the earlier one.
 */
export function moveSince(
  ticks: readonly TickPoint[],
  at: number,
  now: number,
  atr5: number | null,
  toleranceMs: number = IMPACT_TICK_TOLERANCE_MS,
): MoveSince | null {
  const start = lastAtOrBefore(ticks, at, toleranceMs);
  const end = lastAtOrBefore(ticks, now, toleranceMs);
  if (start === null || end === null || end.ts <= start.ts) return null;
  const usd = round3(mid(end) - mid(start));
  return {
    usd,
    atr: atr5 !== null && atr5 > 0 ? Math.round((Math.abs(usd) / atr5) * 100) / 100 : null,
    spread: round3(end.ask - end.bid),
  };
}
