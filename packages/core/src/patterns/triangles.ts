import { findEqualLevels, type EqualLevel } from '../levels/equalLevels';
import { TOLERANCE, type Pivot } from '../structure/types';
import type { TrendlineUpdate } from '../trendlines/tracker';
import type { Trendline } from '../trendlines/lines';
import {
  apexOf,
  boundaryOfLine,
  candlesBetween,
  compresses,
  horizontal,
  usableFrom,
  widthAt,
} from './geometry';
import {
  PATTERN_DEFAULTS,
  type Boundary,
  type Pattern,
  type PatternInput,
  type PatternName,
  type PatternPoint,
} from './types';

const pointsOf = (label: string, pivots: readonly Pivot[]): PatternPoint[] =>
  pivots.map((p) => ({
    label,
    kind: p.kind,
    index: p.index,
    openTime: p.openTime,
    price: p.price,
  }));

/** Equal highs (or lows) whose boundary is still intact: no close beyond it by more than 0.10 x ATR since its first point. */
function intactGroups(
  input: PatternInput,
  side: 'HIGH' | 'LOW',
  toleranceAtr: number,
  minPoints: number,
): EqualLevel[] {
  const params = input.params ?? PATTERN_DEFAULTS;
  const { atr } = input;
  if (atr === null || !(atr > 0)) return [];
  const from = usableFrom(input, params);
  const groups = findEqualLevels({
    pivots: [...input.highs, ...input.lows],
    atr,
    count: input.count,
    params: { toleranceAtr, lookback: params.window, minPoints },
  });
  return groups
    .filter((g) => g.side === side && g.firstIndex >= from)
    .filter((g) =>
      candlesBetween(input, g.firstIndex, input.count - 1).every((c) => {
        const beyond = side === 'HIGH' ? c.c - g.price : g.price - c.c;
        return beyond <= params.triangle.boundaryCloseAtr * atr + TOLERANCE;
      }),
    )
    .sort((a, b) => b.touches - a.touches || b.lastIndex - a.lastIndex);
}

interface Side {
  readonly boundary: Boundary;
  readonly firstIndex: number;
  readonly firstOpenTime: number;
  readonly lastIndex: number;
  readonly lastOpenTime: number;
  readonly touches: readonly Pivot[];
}

const sideOfGroup = (group: EqualLevel, candleMs: number): Side => ({
  boundary: horizontal(group.members[0]?.openTime ?? 0, group.price, candleMs),
  firstIndex: group.firstIndex,
  firstOpenTime: group.members[0]?.openTime ?? 0,
  lastIndex: group.lastIndex,
  lastOpenTime: group.members.at(-1)?.openTime ?? 0,
  touches: group.members,
});

const sideOfLine = (line: Trendline): Side => ({
  boundary: boundaryOfLine(line),
  firstIndex: line.a.index,
  firstOpenTime: line.a.openTime,
  lastIndex: line.lastTouchIndex,
  lastOpenTime: line.touchPoints.at(-1)?.openTime ?? line.a.openTime,
  touches: line.touchPoints,
});

function converging(
  input: PatternInput,
  name: PatternName,
  idCode: string,
  upper: Side,
  lower: Side,
): Pattern | null {
  const params = input.params ?? PATTERN_DEFAULTS;
  const { atr } = input;
  const latest = input.candles.at(-1)?.openTime;
  if (atr === null || latest === undefined) return null;
  const startMs = Math.min(upper.firstOpenTime, lower.firstOpenTime);
  const endMs = Math.max(upper.lastOpenTime, lower.lastOpenTime);
  if (!compresses(upper.boundary, lower.boundary, startMs, endMs, params.triangle.compression))
    return null;
  const apex = apexOf(upper.boundary, lower.boundary);
  if (apex === null || apex <= latest) return null;
  const firstIndex = Math.min(upper.firstIndex, lower.firstIndex);
  const lastIndex = Math.max(upper.lastIndex, lower.lastIndex);
  return {
    id: `${input.tag ?? ''}${idCode}`,
    name,
    up: upper.boundary,
    down: lower.boundary,
    height: widthAt(upper.boundary, lower.boundary, startMs),
    points: [...pointsOf('UPPER', upper.touches), ...pointsOf('LOWER', lower.touches)].sort(
      (a, b) => a.index - b.index,
    ),
    atr,
    firstIndex,
    lastIndex,
    formedIndex: input.count - 1,
    formedOpenTime: latest,
    apexOpenTime: apex,
    invalidAbove: null,
    invalidBelow: null,
    research: false,
  };
}

/**
 * Triangles (docs/02 section 4.1), from the trendlines of `TrendlineTracker` and the equal highs and
 * lows of the same timeframe:
 *
 * - ascending: horizontal resistance (two or more swing highs within 0.2 x ATR) and the valid rising
 *   support line; descending: horizontal support and the valid falling resistance line;
 * - symmetrical: the valid falling resistance line and the valid rising support line, when there is
 *   no ascending or descending triangle (a flat boundary takes precedence).
 *
 * The pattern runs from the earliest point of its boundaries to the latest touch. It needs
 * compression, the width over its last third at most 0.6 x the width over its first third, and an
 * apex still ahead of the latest candle. The height of the measured move is the width at the start.
 * A boundary that has been closed through by more than 0.10 x ATR is not intact, so a pattern that was
 * broken is not found again.
 */
export function trianglesOf(input: PatternInput, trend: TrendlineUpdate): Pattern[] {
  const params = input.params ?? PATTERN_DEFAULTS;
  const found: Pattern[] = [];
  const { support, resistance } = trend;
  const cfg = params.triangle;

  const flatTop = intactGroups(input, 'HIGH', cfg.horizontalAtr, cfg.minTouches)[0];
  if (flatTop && support) {
    const upper = sideOfGroup(flatTop, input.candleMs);
    const pattern = converging(
      input,
      'ASCENDING_TRIANGLE',
      `AT:${String(flatTop.firstIndex)}:${String(support.a.index)}:${String(support.b.index)}`,
      upper,
      sideOfLine(support),
    );
    if (pattern) found.push(pattern);
  }
  const flatBottom = intactGroups(input, 'LOW', cfg.horizontalAtr, cfg.minTouches)[0];
  if (flatBottom && resistance) {
    const pattern = converging(
      input,
      'DESCENDING_TRIANGLE',
      `DTR:${String(flatBottom.firstIndex)}:${String(resistance.a.index)}:${String(resistance.b.index)}`,
      sideOfLine(resistance),
      sideOfGroup(flatBottom, input.candleMs),
    );
    if (pattern) found.push(pattern);
  }
  if (found.length === 0 && support && resistance) {
    const pattern = converging(
      input,
      'SYMMETRICAL_TRIANGLE',
      `ST:${String(resistance.a.index)}:${String(resistance.b.index)}:${String(support.a.index)}:${String(support.b.index)}`,
      sideOfLine(resistance),
      sideOfLine(support),
    );
    if (pattern) found.push(pattern);
  }
  return found;
}

/**
 * Rectangle (docs/02 section 4.1): horizontal resistance and horizontal support, each with at least
 * two touches within 0.2 x ATR, between 1.5 and 4 x ATR apart, lasting at least 12 candles from
 * the first touch to the last, with no close beyond either of them by more than 0.10 x ATR. If
 * there are several, the one with the most touches. The height of the measured move is the distance
 * between the two boundaries.
 */
export function rectangleOf(input: PatternInput): Pattern | null {
  const params = input.params ?? PATTERN_DEFAULTS;
  const cfg = params.rectangle;
  const { atr } = input;
  const latest = input.candles.at(-1)?.openTime;
  if (atr === null || !(atr > 0) || latest === undefined) return null;
  const tops = intactGroups(input, 'HIGH', cfg.touchAtr, cfg.minTouches);
  const bottoms = intactGroups(input, 'LOW', cfg.touchAtr, cfg.minTouches);

  let best: { top: EqualLevel; bottom: EqualLevel } | null = null;
  for (const top of tops) {
    for (const bottom of bottoms) {
      const height = top.price - bottom.price;
      if (
        height < cfg.minHeightAtr * atr - TOLERANCE ||
        height > cfg.maxHeightAtr * atr + TOLERANCE
      )
        continue;
      const start = Math.min(top.firstIndex, bottom.firstIndex);
      const end = Math.max(top.lastIndex, bottom.lastIndex);
      if (end - start < cfg.minLength) continue;
      const inside = candlesBetween(input, start, input.count - 1).every(
        (c) =>
          c.c - top.price <= params.triangle.boundaryCloseAtr * atr + TOLERANCE &&
          bottom.price - c.c <= params.triangle.boundaryCloseAtr * atr + TOLERANCE,
      );
      if (!inside) continue;
      const better =
        best === null ||
        top.touches + bottom.touches > best.top.touches + best.bottom.touches ||
        (top.touches + bottom.touches === best.top.touches + best.bottom.touches &&
          end > Math.max(best.top.lastIndex, best.bottom.lastIndex));
      if (better) best = { top, bottom };
    }
  }
  if (!best) return null;
  const upper = sideOfGroup(best.top, input.candleMs);
  const lower = sideOfGroup(best.bottom, input.candleMs);
  return {
    id: `${input.tag ?? ''}RC:${String(best.top.firstIndex)}:${String(best.bottom.firstIndex)}`,
    name: 'RECTANGLE',
    up: upper.boundary,
    down: lower.boundary,
    height: best.top.price - best.bottom.price,
    points: [...pointsOf('UPPER', upper.touches), ...pointsOf('LOWER', lower.touches)].sort(
      (a, b) => a.index - b.index,
    ),
    atr,
    firstIndex: Math.min(upper.firstIndex, lower.firstIndex),
    lastIndex: Math.max(upper.lastIndex, lower.lastIndex),
    formedIndex: input.count - 1,
    formedOpenTime: latest,
    apexOpenTime: null,
    invalidAbove: null,
    invalidBelow: null,
    research: false,
  };
}
