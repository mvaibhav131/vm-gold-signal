import { bucketStart } from '@vmgs/core';

/** The change of the price since the trading day opened (17:00 New York, the day of the 1d candle). */
export interface DayChange {
  readonly change: number;
  readonly pct: number;
  /** The price the change is counted from: the open of the first candle of the day. */
  readonly reference: number;
  /** When that candle opened. */
  readonly sinceMs: number;
  /** The day has been recorded only from `sinceMs`, which is more than two hours after it opened. */
  readonly partial: boolean;
}

interface CandleLike {
  readonly t: string;
  readonly o: number;
  readonly c: number;
}

const HOUR_MS = 3_600_000;
/** With no candle of the day yet, the last close is the reference only when it is this recent (a weekend is a little under 50 hours). */
const MAX_CLOSE_AGE_MS = 72 * HOUR_MS;

/**
 * The change since the trading day opened, from candles (oldest first) that reach back past the start of the day. The
 * reference is the open of the first candle of the day. On a database that has recorded only part of the day it is the open
 * of the first candle there is, and `partial` says so, so the screen can name the time instead of "today". With no candle
 * of the day yet (the market has just opened) it is the last close.
 */
export function dayChangeOf(
  candles: readonly CandleLike[],
  price: number,
  nowMs: number,
): DayChange | null {
  const newest = candles.at(-1);
  if (newest === undefined) return null;
  const dayStart = bucketStart('1d', nowMs);
  const first = candles.find((candle) => Date.parse(candle.t) >= dayStart);
  let reference: number;
  let sinceMs: number;
  if (first !== undefined) {
    reference = first.o;
    sinceMs = Date.parse(first.t);
  } else {
    if (nowMs - Date.parse(newest.t) > MAX_CLOSE_AGE_MS) return null;
    reference = newest.c;
    sinceMs = dayStart;
  }
  if (reference <= 0) return null;
  const change = price - reference;
  return {
    change,
    pct: (change / reference) * 100,
    reference,
    sinceMs,
    partial: sinceMs - dayStart > 2 * HOUR_MS,
  };
}

/** `+6.358`, `-1.250`, `0.000`: the sign is always written, so a rise and a fall differ without colour. */
export function signedFixed(value: number, decimals: number): string {
  const text = Math.abs(value).toFixed(decimals);
  const zero = Number(text) === 0;
  if (zero) return text;
  return `${value > 0 ? '+' : '-'}${text}`;
}

export type TickDirection = 'up' | 'down' | 'flat';

/**
 * Which characters of a price differ from the price before (same length: position by position). Only those are coloured when
 * the price moves, and the rest keeps its colour. With no price before nothing is marked; if the length changed (999.999 to
 * 1000.000) every character is.
 */
export function changedMask(previous: string | null, next: string): boolean[] {
  const chars = [...next];
  if (previous === null) return chars.map(() => false);
  if (previous.length !== chars.length) return chars.map(() => true);
  return chars.map((char, index) => char !== previous[index]);
}

/**
 * The direction of the newest move of a price: the direction of this change, or of the one before when the price did not
 * change (the colour stays until the next move).
 */
export function nextDirection(
  previous: number | null,
  next: number | null,
  before: TickDirection,
): TickDirection {
  if (previous === null || next === null) return 'flat';
  if (next > previous) return 'up';
  if (next < previous) return 'down';
  return before;
}
