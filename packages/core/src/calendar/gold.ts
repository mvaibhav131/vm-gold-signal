import type { GoldAfter } from './alerts';

/** A stored tick, as far as the move after a release needs it. */
export interface TickPoint {
  readonly ts: number;
  readonly bid: number;
  readonly ask: number;
}

/** A tick this much older than the moment it stands for is not used: the price may be far from it. */
export const GOLD_TICK_TOLERANCE_MS = 10_000;

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

const mid = (tick: TickPoint): number => (tick.bid + tick.ask) / 2;

/**
 * Where gold was `seconds` after `at`: the move of the mid price from the last tick at `at` to the
 * last tick at `at + seconds`, and the spread of the later one. Null when there is no tick near
 * either moment (the recorder was down or the feed was quiet): it is never guessed.
 */
export function goldAfterOf(
  ticks: readonly TickPoint[],
  at: number,
  seconds: number,
  toleranceMs: number = GOLD_TICK_TOLERANCE_MS,
): GoldAfter | null {
  const before = lastAtOrBefore(ticks, at, toleranceMs);
  const after = lastAtOrBefore(ticks, at + seconds * 1000, toleranceMs);
  if (before === null || after === null || after.ts <= at) return null;
  return {
    seconds,
    moveUsd: Math.round((mid(after) - mid(before)) * 10_000) / 10_000,
    spread: Math.round((after.ask - after.bid) * 10_000) / 10_000,
  };
}
