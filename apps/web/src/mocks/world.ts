import {
  Ema,
  Supertrend,
  bucketEnd,
  bucketStart,
  computeSeries,
  sessionWindowAt,
  tradingDayOf,
  type Session,
  type Timeframe,
} from '@vmgs/core';
import type { CandlesResponse, ChartObject, Level } from '@vmgs/contracts';

// The simulated market. Prices are a pure function of time (slow swings plus per-minute noise),
// so every reload shows the same chart, the chart agrees with the live quote, and the swing stays
// inside a band that the simulated signals never leave (their stops and targets sit outside it).

export const ANCHOR = 4017.285;
const MINUTE_MS = 60_000;

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Deterministic noise in [0, 1) for a whole number and a salt. */
export function hash01(n: number, salt: number): number {
  let x = (Math.imul(n | 0, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca6b)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4_294_967_296;
}

/** Largest distance of any simulated price from the anchor: swings 4.3 plus noise 0.45 plus wicks 0.35. */
export const BAND = 5.1;

function priceAtMinute(minute: number): number {
  const slow = 2.6 * Math.sin(minute / 311);
  const medium = 1.2 * Math.sin(minute / 47 + 0.7);
  const fast = 0.5 * Math.sin(minute / 11);
  const noise = (hash01(minute, 1) - 0.5) * 0.9;
  return ANCHOR + slow + medium + fast + noise;
}

export interface Ohlc {
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

/** The 1m candle that opens at the given minute index (minutes since the epoch). */
export function minuteOhlc(minute: number): Ohlc {
  const o = priceAtMinute(minute);
  const c = priceAtMinute(minute + 1);
  return {
    o: round3(o),
    h: round3(Math.max(o, c) + hash01(minute, 2) * 0.35),
    l: round3(Math.min(o, c) - hash01(minute, 3) * 0.35),
    c: round3(c),
  };
}

/** The mid price at an instant: a straight line between the two surrounding minute prices. */
export function priceAt(ms: number): number {
  const minute = Math.floor(ms / MINUTE_MS);
  const fraction = (ms - minute * MINUTE_MS) / MINUTE_MS;
  const from = priceAtMinute(minute);
  return from + (priceAtMinute(minute + 1) - from) * fraction;
}

/** One candle made of `count` consecutive 1m candles. */
export function foldMinutes(firstMinute: number, count: number): Ohlc {
  let h = Number.NEGATIVE_INFINITY;
  let l = Number.POSITIVE_INFINITY;
  const first = minuteOhlc(firstMinute);
  let c = first.c;
  for (let i = 0; i < count; i += 1) {
    const m = minuteOhlc(firstMinute + i);
    h = Math.max(h, m.h);
    l = Math.min(l, m.l);
    c = m.c;
  }
  return { o: first.o, h, l, c };
}

interface StampedCandle extends Ohlc {
  readonly openMs: number;
}

/** The latest `count` closed candles of a timeframe, oldest first. The candle still forming is left out. */
function closedCandles(tf: Timeframe, count: number, nowMs: number): StampedCandle[] {
  const wholeMinute = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
  let start = bucketStart(tf, wholeMinute - 1);
  if (bucketEnd(tf, start) > wholeMinute) start = bucketStart(tf, start - 1);
  const starts: number[] = [];
  for (let i = 0; i < count; i += 1) {
    starts.push(start);
    start = bucketStart(tf, start - 1);
  }
  return starts.reverse().map((openMs) => ({
    openMs,
    ...foldMinutes(openMs / MINUTE_MS, (bucketEnd(tf, openMs) - openMs) / MINUTE_MS),
  }));
}

/** EMA from `packages/core`, rounded to 3 decimals: the chart and the engine use the same code. */
export function ema(values: readonly number[], period: number): (number | null)[] {
  return computeSeries(new Ema(period), values).map((v) => (v === null ? null : round3(v)));
}

/** Supertrend(10, 3) from `packages/core`: the trailing band that flips when the close crosses it. */
export function supertrend(
  candles: readonly Ohlc[],
  period = 10,
  multiplier = 3,
): (number | null)[] {
  return computeSeries(new Supertrend(period, multiplier), candles).map((v) =>
    v === null ? null : round3(v.value),
  );
}
interface Pivot {
  readonly index: number;
  readonly price: number;
}

function pivots(candles: readonly StampedCandle[], side: 'h' | 'l', width: number): Pivot[] {
  const found: Pivot[] = [];
  for (let i = width; i < candles.length - width; i += 1) {
    const here = candles[i]?.[side];
    if (here === undefined) continue;
    let isPivot = true;
    for (let k = 1; k <= width && isPivot; k += 1) {
      const left = candles[i - k]?.[side];
      const right = candles[i + k]?.[side];
      if (left === undefined || right === undefined) isPivot = false;
      else if (side === 'h' ? here <= left || here <= right : here >= left || here >= right) {
        isPivot = false;
      }
    }
    if (isPivot) found.push({ index: i, price: here });
  }
  return found;
}

const OBJECT_KINDS_BY_REQUEST: Readonly<Record<string, readonly ChartObject['type'][]>> = {
  trendlines: ['trendline', 'channel'],
  zones: ['zone'],
  patterns: ['pattern'],
  fib: ['fib'],
};

/**
 * Chart objects found from swing points of the simulated candles. Drawing rules for the real
 * detectors (phase B7): trendline = 2 points; channel = 3 points (line through the first two,
 * parallel through the third); zone = 2 corners (left top, right bottom); pattern = the points of
 * its outline in time order; fib = 2 points (swing start and end), levels in `meta.levels`.
 */
function chartObjects(
  tf: Timeframe,
  candles: readonly StampedCandle[],
  requested: readonly string[],
): ChartObject[] {
  const wanted = new Set(requested.flatMap((kind) => OBJECT_KINDS_BY_REQUEST[kind] ?? []));
  if (wanted.size === 0 || candles.length < 40) return [];
  const recent = candles.slice(-120);
  const iso = (index: number) => new Date(recent[index]?.openMs ?? 0).toISOString();
  const lastIndex = recent.length - 1;
  const lows = pivots(recent, 'l', 4);
  const highs = pivots(recent, 'h', 4);
  const objects: ChartObject[] = [];

  const [lowA, lowB] = lows.slice(-2);
  if (lowA && lowB && wanted.has('trendline')) {
    const slope = (lowB.price - lowA.price) / (lowB.index - lowA.index);
    objects.push({
      id: 'tl-support',
      type: 'trendline',
      tf,
      points: [
        { t: iso(lowA.index), price: lowA.price },
        { t: iso(lastIndex), price: round3(lowB.price + slope * (lastIndex - lowB.index)) },
      ],
      meta: { name: 'Support line', touches: 2 },
    });
  }
  const highAfter = highs.find((p) => lowA && lowB && p.index > lowA.index);
  if (lowA && lowB && highAfter && wanted.has('channel')) {
    objects.push({
      id: 'ch-1',
      type: 'channel',
      tf,
      points: [
        { t: iso(lowA.index), price: lowA.price },
        { t: iso(lowB.index), price: lowB.price },
        { t: iso(highAfter.index), price: highAfter.price },
      ],
      meta: { name: 'Channel' },
    });
  }
  const lastHigh = highs.at(-1);
  if (lastHigh && wanted.has('zone')) {
    objects.push({
      id: 'zone-resistance',
      type: 'zone',
      tf,
      points: [
        { t: iso(lastHigh.index), price: round3(lastHigh.price + 0.2) },
        { t: iso(lastIndex), price: round3(lastHigh.price - 0.4) },
      ],
      meta: { name: 'Resistance zone', touches: 2 },
    });
  }
  const lastLow = lows.at(-1);
  if (lastLow && wanted.has('zone')) {
    objects.push({
      id: 'zone-support',
      type: 'zone',
      tf,
      points: [
        { t: iso(lastLow.index), price: round3(lastLow.price + 0.4) },
        { t: iso(lastIndex), price: round3(lastLow.price - 0.2) },
      ],
      meta: { name: 'Support zone', touches: 3 },
    });
  }
  const [bottomA, bottomB] = lows.slice(-2);
  const between =
    bottomA && bottomB
      ? highs.find((p) => p.index > bottomA.index && p.index < bottomB.index)
      : undefined;
  if (bottomA && bottomB && between && wanted.has('pattern')) {
    objects.push({
      id: 'pat-double-bottom',
      type: 'pattern',
      tf,
      points: [
        { t: iso(bottomA.index), price: bottomA.price },
        { t: iso(between.index), price: between.price },
        { t: iso(bottomB.index), price: bottomB.price },
      ],
      meta: { name: 'Double bottom', confirmed: false },
    });
  }
  const swingLow = lows.at(-1);
  const swingHigh = highs.at(-1);
  if (swingLow && swingHigh && wanted.has('fib')) {
    // The swing starts at the earlier pivot and ends at the later one (up-swing or down-swing).
    const [start, end] =
      swingLow.index < swingHigh.index ? [swingLow, swingHigh] : [swingHigh, swingLow];
    objects.push({
      id: 'fib-1',
      type: 'fib',
      tf,
      points: [
        { t: iso(start.index), price: start.price },
        { t: iso(end.index), price: end.price },
      ],
      meta: { name: 'Fibonacci retracement', levels: [0.382, 0.5, 0.618, 0.786] },
    });
  }
  return objects;
}

const SESSION_NAMES: Readonly<Record<Session, string>> = {
  ASIA: 'Asia',
  LONDON: 'London',
  OVERLAP: 'Overlap',
  NEW_YORK: 'New York',
  ROLLOVER: 'Rollover',
};

function highLow(startMs: number, endMs: number): { high: number; low: number } | null {
  const first = Math.floor(startMs / MINUTE_MS);
  const count = Math.floor((endMs - startMs) / MINUTE_MS);
  if (count < 1) return null;
  const { h, l } = foldMinutes(first, count);
  return { high: h, low: l };
}

/** Previous-day and session extremes (from the real B3 trading day and session functions) and round numbers. */
export function levels(nowMs: number): Level[] {
  const result: Level[] = [];
  const today = tradingDayOf(nowMs);
  const yesterday = tradingDayOf(today.startMs - 1);
  const previous = highLow(yesterday.startMs, yesterday.endMs);
  if (previous) {
    result.push({ key: 'pdh', label: 'PDH', price: previous.high });
    result.push({ key: 'pdl', label: 'PDL', price: previous.low });
  }
  const session = sessionWindowAt(nowMs);
  const sessionRange = highLow(session.startMs, Math.floor(nowMs / MINUTE_MS) * MINUTE_MS);
  if (sessionRange) {
    const name = SESSION_NAMES[session.session];
    result.push({ key: 'session-high', label: `${name} high`, price: sessionRange.high });
    result.push({ key: 'session-low', label: `${name} low`, price: sessionRange.low });
  }
  const mid = priceAt(nowMs);
  const rounds = new Map<number, number>();
  for (const step of [10, 50, 100]) {
    for (const price of [Math.floor(mid / step) * step, Math.ceil(mid / step) * step]) {
      rounds.set(price, Math.max(rounds.get(price) ?? 0, step));
    }
  }
  for (const [price, step] of [...rounds].sort(([a], [b]) => a - b)) {
    result.push({ key: `round-${String(price)}`, label: `$${String(step)} level`, price });
  }
  return result;
}

const OVERLAY_PERIODS = { ema20: 20, ema50: 50, ema200: 200 } as const;
/** Extra candles before the visible ones so the averages are settled where the chart starts. */
const WARMUP_CANDLES = 300;

export interface CandleRequest {
  tf: Timeframe;
  limit: number;
  overlays: readonly string[];
  objects: readonly string[];
}

export function candlesResponse(request: CandleRequest, nowMs: number): CandlesResponse {
  const all = closedCandles(request.tf, request.limit + WARMUP_CANDLES, nowMs);
  const visible = all.slice(-request.limit);
  const closes = all.map((c) => c.c);
  const overlays: CandlesResponse['overlays'] = {};
  for (const name of request.overlays) {
    if (name === 'supertrend') overlays.supertrend = supertrend(all).slice(-request.limit);
    else if (name in OVERLAY_PERIODS) {
      const key = name as keyof typeof OVERLAY_PERIODS;
      overlays[key] = ema(closes, OVERLAY_PERIODS[key]).slice(-request.limit);
    }
  }
  return {
    candles: visible.map(({ openMs, o, h, l, c }) => ({
      t: new Date(openMs).toISOString(),
      o,
      h,
      l,
      c,
    })),
    overlays,
    levels: levels(nowMs),
    objects: chartObjects(request.tf, visible, request.objects),
  };
}
