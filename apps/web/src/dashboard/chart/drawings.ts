import { bucketStart, type Timeframe } from '@vmgs/core';

/**
 * The lines that the owner draws on the chart. They are kept in this browser only (local storage): they are marks for the
 * eye, not data of the system, and nothing is sent anywhere. A point has an absolute time (seconds) and a price, so a drawing
 * made on the 5 minute chart is also there on the 1 hour chart.
 */
export const DRAWING_TOOLS = ['hline', 'trend', 'fib'] as const;
export type DrawingTool = (typeof DRAWING_TOOLS)[number];

/** Retracement levels, measured back from the second point (as the Fibonacci objects of the engine are). */
export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

export const MAX_DRAWINGS = 40;
export const DRAWINGS_KEY = 'vmgs.chart.drawings.v1';

export interface DrawingPoint {
  /** Epoch seconds. */
  readonly t: number;
  readonly price: number;
}

export type Drawing =
  | { readonly id: string; readonly kind: 'hline'; readonly price: number }
  | {
      readonly id: string;
      readonly kind: 'trend';
      readonly a: DrawingPoint;
      readonly b: DrawingPoint;
    }
  | {
      readonly id: string;
      readonly kind: 'fib';
      readonly a: DrawingPoint;
      readonly b: DrawingPoint;
    };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewDrawing = DistributiveOmit<Drawing, 'id'>;

export const TOOL_LABELS: Readonly<Record<DrawingTool, string>> = {
  hline: 'Horizontal line',
  trend: 'Trendline',
  fib: 'Fibonacci retracement',
};

/** Clicks that a tool needs. */
export const TOOL_POINTS: Readonly<Record<DrawingTool, 1 | 2>> = { hline: 1, trend: 2, fib: 2 };

/** The prices of the retracement levels between two points: 0 is at the second point, 1 at the first. */
export function fibPrices(a: DrawingPoint, b: DrawingPoint): { ratio: number; price: number }[] {
  return FIB_RATIOS.map((ratio) => ({ ratio, price: b.price - (b.price - a.price) * ratio }));
}

/**
 * A point put on the candle of the chart that holds it. A point whose time is not a candle of the chart would add a bar of its
 * own to the time axis, so every point is moved to the open of its candle in the timeframe of the chart.
 */
export function snapSeconds(tf: Timeframe, seconds: number): number {
  return bucketStart(tf, seconds * 1000) / 1000;
}

/**
 * The segment between two points, cut to the candles that are on the chart (`firstSec` to `lastSec`). A segment that ends
 * before the first candle or starts after the last one is not on the chart: null.
 */
export function clipSegment(
  tf: Timeframe,
  a: DrawingPoint,
  b: DrawingPoint,
  firstSec: number,
  lastSec: number,
): [DrawingPoint, DrawingPoint] | null {
  const [from, to] = a.t <= b.t ? [a, b] : [b, a];
  if (to.t < firstSec || from.t > lastSec) return null;
  const at = (t: number): DrawingPoint => {
    const clamped = Math.min(Math.max(t, firstSec), lastSec);
    const slope = to.t === from.t ? 0 : (to.price - from.price) / (to.t - from.t);
    return { t: snapSeconds(tf, clamped), price: from.price + slope * (clamped - from.t) };
  };
  const start = at(from.t);
  const end = at(to.t);
  return start.t < end.t ? [start, end] : null;
}

const isPoint = (value: unknown): value is DrawingPoint => {
  if (typeof value !== 'object' || value === null) return false;
  const { t, price } = value as Record<string, unknown>;
  return (
    typeof t === 'number' &&
    Number.isFinite(t) &&
    t > 0 &&
    typeof price === 'number' &&
    Number.isFinite(price) &&
    price > 0
  );
};

function parseOne(value: unknown): Drawing | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = value as Record<string, unknown>;
  const { id, kind } = item;
  if (typeof id !== 'string' || id === '' || id.length > 40) return null;
  if (kind === 'hline') {
    const { price } = item;
    return typeof price === 'number' && Number.isFinite(price) && price > 0
      ? { id, kind, price }
      : null;
  }
  if ((kind === 'trend' || kind === 'fib') && isPoint(item.a) && isPoint(item.b)) {
    return {
      id,
      kind,
      a: { t: item.a.t, price: item.a.price },
      b: { t: item.b.t, price: item.b.price },
    };
  }
  return null;
}

/** What local storage held: only what is a valid drawing is kept (a hand-edited or old value never breaks the chart). */
export function parseDrawings(raw: string | null | undefined): Drawing[] {
  if (raw === null || raw === undefined || raw === '') return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: Drawing[] = [];
  for (const entry of data) {
    const drawing = parseOne(entry);
    if (drawing === null || seen.has(drawing.id)) continue;
    seen.add(drawing.id);
    out.push(drawing);
  }
  return out.slice(-MAX_DRAWINGS);
}

export function serializeDrawings(drawings: readonly Drawing[]): string {
  return JSON.stringify(drawings.slice(-MAX_DRAWINGS));
}

let counter = 0;
export function newDrawingId(nowMs: number = Date.now()): string {
  counter += 1;
  return `d${nowMs.toString(36)}${counter.toString(36)}`;
}

/** The list with one more drawing; at the limit the oldest one goes. */
export function withDrawing(list: readonly Drawing[], drawing: NewDrawing, id: string): Drawing[] {
  return [...list, { ...drawing, id } as Drawing].slice(-MAX_DRAWINGS);
}
