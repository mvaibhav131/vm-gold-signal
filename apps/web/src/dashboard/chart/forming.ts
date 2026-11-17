import { TIMEFRAME_MS, bucketStart, type Timeframe } from '@vmgs/core';

/**
 * The candle that is still forming, built in the browser from the quotes of the stream. It is a picture, not a record: the
 * worker stores the candle when it closes, and from then on the chart shows that one. It opens where the last price was (the
 * close of the candle before it, or the first quote seen, when the page was opened inside the candle).
 */
export interface FormingCandle {
  readonly startMs: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

/** The newest closed candle of the chart: when it opened and where it closed. */
export interface ClosedCandle {
  readonly startMs: number;
  readonly c: number;
}

/**
 * The forming candle after a quote of `price` at `atMs`. A quote inside the candle in hand moves its high, low and close; the
 * first quote of the next candle starts a new one that opens at the last price. A quote older than the candle in hand (the
 * clock of the PC stepped back) changes nothing.
 */
export function formingStep(
  previous: FormingCandle | null,
  tf: Timeframe,
  atMs: number,
  price: number,
  lastClosed: ClosedCandle | null,
): FormingCandle {
  const startMs = bucketStart(tf, atMs);
  if (previous !== null && previous.startMs === startMs) {
    return {
      startMs,
      o: previous.o,
      h: Math.max(previous.h, price),
      l: Math.min(previous.l, price),
      c: price,
    };
  }
  if (previous !== null && previous.startMs > startMs) return previous;
  const size = TIMEFRAME_MS[tf];
  let open = price;
  if (previous !== null && previous.startMs + size === startMs) open = previous.c;
  else if (lastClosed !== null && lastClosed.startMs + size === startMs) open = lastClosed.c;
  return { startMs, o: open, h: Math.max(open, price), l: Math.min(open, price), c: price };
}

/** Milliseconds from `nowMs` to the first instant of the next candle of `tf`. */
export function msToNextCandle(tf: Timeframe, nowMs: number): number {
  return bucketStart(tf, nowMs) + TIMEFRAME_MS[tf] - nowMs;
}

/** "04:09" for a time under an hour, "1:04:09" above it (rounded up to the second, like a clock counting down). */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`;
}

/**
 * The server's clock minus this PC's, from a snapshot that was fetched at `fetchedAtMs` (this PC's clock): the snapshot says
 * when the server got its newest tick and how old that was, so the server's "now" is the sum. Off by the delay of the
 * request, which is far below a candle. 0 when there is no snapshot yet.
 */
export function serverClockOffsetMs(
  snapshot: { readonly receivedAt: string; readonly ageMs: number } | undefined,
  fetchedAtMs: number,
): number {
  if (snapshot === undefined || fetchedAtMs <= 0) return 0;
  const serverNow = Date.parse(snapshot.receivedAt) + snapshot.ageMs;
  return Number.isFinite(serverNow) ? serverNow - fetchedAtMs : 0;
}

/**
 * When to ask for the candles again: a little after the next candle closes (the worker needs a moment to store it), and
 * at the latest after five minutes, in case that answer came early.
 */
export function candleRefetchDelayMs(tf: Timeframe, nowMs: number): number {
  const wanted = msToNextCandle(tf, nowMs) + 4000;
  return Math.min(Math.max(wanted, 5000), 300_000);
}
