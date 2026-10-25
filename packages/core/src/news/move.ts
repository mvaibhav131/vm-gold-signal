import type { MarketEventKind } from '../domain';
import type { TickPoint } from '../calendar/gold';

/** A move of at least this many ATR(5m) within 5 minutes is a spike (v0.1.0 hypothesis, 02 section 16). */
export const MOVE_ATR_5M = 2;
/** Or at least this many ATR(1m) within 1 minute (v0.1.0 hypothesis). */
export const MOVE_ATR_1M = 3;
/** The two windows, in milliseconds. */
export const MOVE_WINDOW_5M_MS = 300_000;
export const MOVE_WINDOW_1M_MS = 60_000;
/** A silence of this long between two ticks ends the run of ticks that can be a move: after it, a jump is a gap, not a move. */
export const MOVE_MAX_GAP_MS = 20_000;
/** After a spike another one is not told for this long (a hypothesis: a move goes on for a while). */
export const MOVE_COOLDOWN_MS = 10 * 60_000;

export interface MoveDetection {
  readonly kind: MarketEventKind;
  /** Seconds from the extreme of the move to the latest tick. */
  readonly windowS: number;
  readonly moveUsd: number;
  /** The move in the ATR of its window (5m or 1m). */
  readonly moveAtr: number;
  readonly basis: '5m' | '1m';
  /** The ATR that the move is measured against. */
  readonly atr: number;
  /** The time of the latest tick. */
  readonly at: number;
}

const mid = (tick: TickPoint): number => (tick.bid + tick.ask) / 2;
const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/** The ticks of the run that ends now: no silence of `maxGapMs` inside it, and none between its end and now. */
function recentRun(
  ticks: readonly TickPoint[],
  now: number,
  maxGapMs: number,
): readonly TickPoint[] {
  const sorted = ticks.filter((tick) => tick.ts <= now).sort((a, b) => a.ts - b.ts);
  const last = sorted[sorted.length - 1];
  if (last === undefined || now - last.ts > maxGapMs) return [];
  let start = sorted.length - 1;
  while (start > 0) {
    const before = sorted[start - 1];
    const here = sorted[start];
    if (before === undefined || here === undefined || here.ts - before.ts > maxGapMs) break;
    start -= 1;
  }
  return sorted.slice(start);
}

interface Candidate {
  readonly detection: MoveDetection;
  readonly strength: number;
}

function inWindow(
  run: readonly TickPoint[],
  windowMs: number,
  atr: number | null,
  threshold: number,
  basis: '5m' | '1m',
): Candidate | null {
  const latest = run[run.length - 1];
  if (latest === undefined || atr === null || !(atr > 0)) return null;
  const inside = run.filter((tick) => tick.ts >= latest.ts - windowMs);
  const first = inside[0];
  if (first === undefined || inside.length < 2) return null;
  let low = first;
  let high = first;
  for (const tick of inside) {
    if (mid(tick) <= mid(low)) low = tick;
    if (mid(tick) >= mid(high)) high = tick;
  }
  const up = mid(latest) - mid(low);
  const down = mid(high) - mid(latest);
  const kind: MarketEventKind = up >= down ? 'SPIKE_UP' : 'SPIKE_DOWN';
  // Prices have three decimals; rounding first keeps a move of exactly the threshold from missing it by float noise.
  const move = round(kind === 'SPIKE_UP' ? up : down, 4);
  const ratio = move / atr;
  if (ratio < threshold - 1e-9) return null;
  const extreme = kind === 'SPIKE_UP' ? low : high;
  return {
    strength: ratio / threshold,
    detection: {
      kind,
      windowS: Math.max(1, Math.round((latest.ts - extreme.ts) / 1000)),
      moveUsd: round(move, 3),
      moveAtr: round(ratio, 2),
      basis,
      atr,
      at: latest.ts,
    },
  };
}

/**
 * A sudden move of gold (02 section 16): from the lowest (highest) mid price of the last 5 minutes
 * up (down) to the latest one is at least 2.0 x ATR(5m), or the same over the last minute is at least
 * 3.0 x ATR(1m). It looks only at the run of ticks that ends now without a silence of 20 seconds, so
 * the jump after a feed gap or a weekend is not a move, and it says nothing without a fresh tick or
 * without an ATR. When both windows qualify, the one that is further beyond its threshold is reported.
 */
export function detectMove(
  ticks: readonly TickPoint[],
  now: number,
  atr5: number | null,
  atr1: number | null,
  maxGapMs: number = MOVE_MAX_GAP_MS,
): MoveDetection | null {
  const run = recentRun(ticks, now, maxGapMs);
  const five = inWindow(run, MOVE_WINDOW_5M_MS, atr5, MOVE_ATR_5M, '5m');
  const one = inWindow(run, MOVE_WINDOW_1M_MS, atr1, MOVE_ATR_1M, '1m');
  if (five === null) return one?.detection ?? null;
  if (one === null) return five.detection;
  return one.strength > five.strength ? one.detection : five.detection;
}
