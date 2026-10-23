import { swingSequence } from '../levels/fibonacci';
import { TOLERANCE, type Pivot } from '../structure/types';
import {
  apexOf,
  candlesBetween,
  compresses,
  fitBoundary,
  usableFrom,
  widthAt,
  type FittedBoundary,
} from './geometry';
import {
  PATTERN_DEFAULTS,
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

/**
 * Flag or pennant (docs/02 section 4.1). The pole is the latest swing leg that is at least 3 x ATR
 * long and was made in at most 8 candles. The consolidation is what follows the end of the pole: 5 to
 * 20 candles that never take back more than half of the pole (measured on the lows after an up pole,
 * the highs after a down pole). Its two boundaries are fitted through the swing points after the pole
 * (at least two highs and two lows at least 3 candles apart, the rules of a trendline without the
 * slope limits): parallel boundaries (slopes within 0.05 x ATR per candle of each other) make a flag,
 * boundaries that compress (last third at most 0.6 x the first third) and meet ahead make a pennant.
 * The break counts in the direction of the pole only: through the upper boundary after an up pole,
 * through the lower one after a down pole. The measured move is the height of the pole.
 */
export function flagOf(input: PatternInput): Pattern | null {
  const params = input.params ?? PATTERN_DEFAULTS;
  const cfg = params.flag;
  const { atr } = input;
  const latest = input.candles.at(-1)?.openTime;
  if (atr === null || !(atr > 0) || latest === undefined) return null;
  const from = usableFrom(input, params);
  const sequence = swingSequence(input.highs, input.lows).filter((p) => p.index >= from);

  for (let i = sequence.length - 1; i >= 1; i -= 1) {
    const end = sequence[i];
    const start = sequence[i - 1];
    if (!end || !start) continue;
    const length = input.count - 1 - end.index;
    if (length > cfg.maxLength) break;
    const size = Math.abs(end.price - start.price);
    if (length < cfg.minLength) continue;
    if (size < cfg.poleAtr * atr - TOLERANCE || end.index - start.index > cfg.poleWithin) continue;

    const up = end.kind === 'HIGH';
    const after = candlesBetween(input, end.index + 1, input.count - 1);
    const retraced = up
      ? Math.min(...after.map((c) => c.l)) < end.price - cfg.maxRetrace * size - TOLERANCE
      : Math.max(...after.map((c) => c.h)) > end.price + cfg.maxRetrace * size + TOLERANCE;
    if (retraced) continue;

    const upper = fitBoundary({
      side: 'UPPER',
      points: input.highs.filter((p) => p.index > end.index),
      pattern: input,
      atr,
      minSpan: cfg.minSpan,
    });
    const lower = fitBoundary({
      side: 'LOWER',
      points: input.lows.filter((p) => p.index > end.index),
      pattern: input,
      atr,
      minSpan: cfg.minSpan,
    });
    if (!upper || !lower) continue;

    const startMs = Math.min(upper.a.openTime, lower.a.openTime);
    const endMs = Math.max(
      upper.touches.at(-1)?.openTime ?? upper.a.openTime,
      lower.touches.at(-1)?.openTime ?? lower.a.openTime,
    );
    if (!(widthAt(upper.boundary, lower.boundary, startMs) > 0)) continue;
    const parallel =
      Math.abs(upper.boundary.slope - lower.boundary.slope) <= cfg.parallelAtr * atr + TOLERANCE;
    const apex = apexOf(upper.boundary, lower.boundary);
    const pennant =
      !parallel &&
      compresses(upper.boundary, lower.boundary, startMs, endMs, cfg.compression) &&
      apex !== null &&
      apex > latest;
    if (!parallel && !pennant) continue;

    const name: PatternName = up
      ? parallel
        ? 'BULL_FLAG'
        : 'BULL_PENNANT'
      : parallel
        ? 'BEAR_FLAG'
        : 'BEAR_PENNANT';
    return {
      id: `${input.tag ?? ''}${parallel ? 'FL' : 'PN'}:${String(start.index)}:${String(end.index)}`,
      name,
      up: up ? upper.boundary : null,
      down: up ? null : lower.boundary,
      height: size,
      points: [
        pointsOf('POLE START', [start])[0],
        pointsOf('POLE END', [end])[0],
        ...pointsOf('UPPER', upper.touches),
        ...pointsOf('LOWER', lower.touches),
      ]
        .filter((p): p is PatternPoint => p !== undefined)
        .sort((a, b) => a.index - b.index),
      atr,
      firstIndex: start.index,
      lastIndex: Math.max(upper.lastTouchIndex, lower.lastTouchIndex),
      formedIndex: input.count - 1,
      formedOpenTime: latest,
      apexOpenTime: parallel ? null : apex,
      invalidAbove: null,
      invalidBelow: null,
      research: false,
    };
  }
  return null;
}

/**
 * Rising or falling wedge (docs/02 section 4.1; research only): boundaries fitted through the swing
 * points of the last 120 candles that both slope the same way, each by at least 0.02 x ATR per candle
 * (a hypothesis, to keep flat boundaries for rectangles and triangles), that compress (last third at
 * most 0.6 x the first third) and meet ahead. The break counts against the slope: a close below the
 * lower boundary of a rising wedge, above the upper boundary of a falling one. The measured move is the
 * width at the start.
 */
export function wedgeOf(input: PatternInput): Pattern | null {
  const params = input.params ?? PATTERN_DEFAULTS;
  const cfg = params.wedge;
  const { atr } = input;
  const latest = input.candles.at(-1)?.openTime;
  if (atr === null || !(atr > 0) || latest === undefined) return null;
  const from = usableFrom(input, params);
  const fit = (side: 'UPPER' | 'LOWER'): FittedBoundary | null =>
    fitBoundary({
      side,
      points: (side === 'UPPER' ? input.highs : input.lows).filter((p) => p.index >= from),
      pattern: input,
      atr,
      minSpan: cfg.minSpan,
    });
  const upper = fit('UPPER');
  const lower = fit('LOWER');
  if (!upper || !lower) return null;

  const su = upper.boundary.slope;
  const sl = lower.boundary.slope;
  const minSlope = cfg.minSlopeAtr * atr;
  const rising = su >= minSlope && sl >= minSlope;
  const falling = su <= -minSlope && sl <= -minSlope;
  if (!rising && !falling) return null;

  const startMs = Math.min(upper.a.openTime, lower.a.openTime);
  const endMs = Math.max(
    upper.touches.at(-1)?.openTime ?? upper.a.openTime,
    lower.touches.at(-1)?.openTime ?? lower.a.openTime,
  );
  if (!compresses(upper.boundary, lower.boundary, startMs, endMs, cfg.compression)) return null;
  const apex = apexOf(upper.boundary, lower.boundary);
  if (apex === null || apex <= latest) return null;

  return {
    id: `${input.tag ?? ''}WG:${String(upper.a.index)}:${String(lower.a.index)}`,
    name: rising ? 'RISING_WEDGE' : 'FALLING_WEDGE',
    up: falling ? upper.boundary : null,
    down: rising ? lower.boundary : null,
    height: widthAt(upper.boundary, lower.boundary, startMs),
    points: [...pointsOf('UPPER', upper.touches), ...pointsOf('LOWER', lower.touches)].sort(
      (a, b) => a.index - b.index,
    ),
    atr,
    firstIndex: Math.min(upper.a.index, lower.a.index),
    lastIndex: Math.max(upper.lastTouchIndex, lower.lastTouchIndex),
    formedIndex: input.count - 1,
    formedOpenTime: latest,
    apexOpenTime: apex,
    invalidAbove: null,
    invalidBelow: null,
    research: true,
  };
}
