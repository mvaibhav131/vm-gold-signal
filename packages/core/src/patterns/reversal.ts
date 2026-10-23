import { TOLERANCE, type Pivot, type StructureCandle } from '../structure/types';
import { boundaryAt, candlesBetween, horizontal, usableFrom } from './geometry';
import { PATTERN_DEFAULTS, type Pattern, type PatternInput, type PatternPoint } from './types';

interface Extreme {
  readonly index: number;
  readonly openTime: number;
  readonly price: number;
}

/** The lowest low (`low` true) or highest high of the candles from position `from`, the earliest on a tie. */
function extremeOf(
  candles: readonly StructureCandle[],
  from: number,
  low: boolean,
): Extreme | null {
  let best: Extreme | null = null;
  candles.forEach((candle, n) => {
    const price = low ? candle.l : candle.h;
    if (best === null || (low ? price < best.price : price > best.price)) {
      best = { index: from + n, openTime: candle.openTime, price };
    }
  });
  return best;
}

/** Any of the candles has a high above (low below) the price. */
function goesBeyond(candles: readonly StructureCandle[], price: number, above: boolean): boolean {
  return candles.some((c) => (above ? c.h > price + TOLERANCE : c.l < price - TOLERANCE));
}

const pointOf = (label: string, p: Pivot): PatternPoint => ({
  label,
  kind: p.kind,
  index: p.index,
  openTime: p.openTime,
  price: p.price,
});

const lastOpenTime = (input: PatternInput, fallback: number) =>
  input.candles.at(-1)?.openTime ?? fallback;

/**
 * Double top or double bottom whose second top (bottom) is `second`, a swing point that has just
 * been confirmed (docs/02 section 4.1). Double top: the first top is the most recent earlier swing
 * high that is within 0.25 x ATR of `second`, 8 to 60 candles before it, with the lowest low between
 * the two at least 1.0 x ATR below the lower top, and no candle between them above the higher top by
 * more than 0.25 x ATR (the two tops are the highest points of the pattern). The neckline is that
 * lowest low, the height is the higher top minus the neckline, a close below the neckline by 0.10 x
 * ATR with a displacement candle is the trigger and the target is the neckline minus the height. A
 * close above the higher top by more than 0.25 x ATR ends the pattern. The double bottom is the
 * mirror image.
 */
export function doubleExtremeFor(second: Pivot, input: PatternInput): Pattern | null {
  const params = input.params ?? PATTERN_DEFAULTS;
  const cfg = params.doubleTop;
  const { atr } = input;
  if (atr === null || !(atr > 0)) return null;
  const top = second.kind === 'HIGH';
  const from = usableFrom(input, params);
  const pool = (top ? input.highs : input.lows)
    .filter((p) => p.index < second.index && p.index >= from)
    .sort((a, b) => b.index - a.index);

  for (const first of pool) {
    const span = second.index - first.index;
    if (span > cfg.maxSpan) break;
    if (span < cfg.minSpan) continue;
    if (Math.abs(first.price - second.price) > cfg.equalAtr * atr + TOLERANCE) continue;

    const between = candlesBetween(input, first.index + 1, second.index - 1);
    const neck = extremeOf(between, first.index + 1, top);
    if (!neck) continue;
    const outer = top ? Math.max(first.price, second.price) : Math.min(first.price, second.price);
    const inner = top ? Math.min(first.price, second.price) : Math.max(first.price, second.price);
    if (goesBeyond(between, top ? outer + cfg.equalAtr * atr : outer - cfg.equalAtr * atr, top))
      continue;
    const depth = top ? inner - neck.price : neck.price - inner;
    if (depth < cfg.minDepthAtr * atr - TOLERANCE) continue;

    const boundary = horizontal(neck.openTime, neck.price, input.candleMs);
    return {
      id: `${input.tag ?? ''}${top ? 'DT' : 'DB'}:${String(first.index)}:${String(second.index)}`,
      name: top ? 'DOUBLE_TOP' : 'DOUBLE_BOTTOM',
      up: top ? null : boundary,
      down: top ? boundary : null,
      height: top ? outer - neck.price : neck.price - outer,
      points: [
        pointOf(top ? 'TOP 1' : 'BOTTOM 1', first),
        {
          label: 'NECKLINE',
          kind: top ? 'LOW' : 'HIGH',
          index: neck.index,
          openTime: neck.openTime,
          price: neck.price,
        },
        pointOf(top ? 'TOP 2' : 'BOTTOM 2', second),
      ],
      atr,
      firstIndex: first.index,
      lastIndex: second.index,
      formedIndex: input.count - 1,
      formedOpenTime: lastOpenTime(input, second.confirmedOpenTime),
      apexOpenTime: null,
      invalidAbove: top ? outer + cfg.invalidAtr * atr : null,
      invalidBelow: top ? null : outer - cfg.invalidAtr * atr,
      research: false,
    };
  }
  return null;
}

/**
 * Head and shoulders (or the inverse) whose right shoulder is `right`, a swing point that has just
 * been confirmed (docs/02 section 4.1). The head is the most recent earlier swing high that is at
 * least 0.5 x ATR above `right` and the highest point between the two; the left shoulder is the most
 * recent swing high before the head that is within 0.5 x ATR of `right`, at least 0.5 x ATR below the
 * head, with the head the highest point between the shoulders. The neckline runs through the lowest
 * low between the left shoulder and the head and the lowest low between the head and the right
 * shoulder, and must slope by at most 0.1 x ATR per candle. The head must stand at least 1.0 x ATR
 * above the neckline (a hypothesis: the docs do not say how deep the dips must be). Trigger as for the
 * double top; the target is the neckline at the breaking candle minus the height of the head over
 * the neckline. A close above the head ends the pattern.
 */
export function headAndShouldersFor(right: Pivot, input: PatternInput): Pattern | null {
  const params = input.params ?? PATTERN_DEFAULTS;
  const cfg = params.headShoulders;
  const { atr } = input;
  if (atr === null || !(atr > 0)) return null;
  const top = right.kind === 'HIGH';
  const from = usableFrom(input, params);
  const pool = (top ? input.highs : input.lows)
    .filter((p) => p.index < right.index && p.index >= from)
    .sort((a, b) => b.index - a.index);
  const over = (head: Pivot, other: Pivot) =>
    top ? head.price - other.price : other.price - head.price;

  for (const head of pool) {
    const headSpan = right.index - head.index;
    if (headSpan > cfg.maxSpan) break;
    if (headSpan < cfg.minSpan) continue;
    if (over(head, right) < cfg.headAtr * atr - TOLERANCE) continue;
    const right2 = candlesBetween(input, head.index + 1, right.index - 1);
    if (goesBeyond(right2, head.price, top)) continue;
    const n2 = extremeOf(right2, head.index + 1, top);
    if (!n2) continue;

    for (const left of pool) {
      if (left.index >= head.index) continue;
      const leftSpan = head.index - left.index;
      if (leftSpan > cfg.maxSpan) break;
      if (leftSpan < cfg.minSpan) continue;
      if (Math.abs(left.price - right.price) > cfg.shoulderAtr * atr + TOLERANCE) continue;
      if (over(head, left) < cfg.headAtr * atr - TOLERANCE) continue;
      const left2 = candlesBetween(input, left.index + 1, head.index - 1);
      if (goesBeyond(left2, head.price, top)) continue;
      const n1 = extremeOf(left2, left.index + 1, top);
      if (!n1) continue;

      const slope = (n2.price - n1.price) / (n2.index - n1.index);
      if (Math.abs(slope) > cfg.maxNecklineSlopeAtr * atr + TOLERANCE) continue;
      const neckline = { openTime: n1.openTime, price: n1.price, slope, candleMs: input.candleMs };
      const height = top
        ? head.price - boundaryAt(neckline, head.openTime)
        : boundaryAt(neckline, head.openTime) - head.price;
      if (height < cfg.minHeightAtr * atr - TOLERANCE) continue;

      const dip = (label: string, e: Extreme) => ({
        label,
        kind: top ? ('LOW' as const) : ('HIGH' as const),
        index: e.index,
        openTime: e.openTime,
        price: e.price,
      });
      return {
        id: `${input.tag ?? ''}${top ? 'HS' : 'IHS'}:${String(left.index)}:${String(head.index)}:${String(right.index)}`,
        name: top ? 'HEAD_AND_SHOULDERS' : 'INVERSE_HEAD_AND_SHOULDERS',
        up: top ? null : neckline,
        down: top ? neckline : null,
        height,
        points: [
          pointOf('LEFT SHOULDER', left),
          dip('NECKLINE 1', n1),
          pointOf('HEAD', head),
          dip('NECKLINE 2', n2),
          pointOf('RIGHT SHOULDER', right),
        ],
        atr,
        firstIndex: left.index,
        lastIndex: right.index,
        formedIndex: input.count - 1,
        formedOpenTime: lastOpenTime(input, right.confirmedOpenTime),
        apexOpenTime: null,
        invalidAbove: top ? head.price : null,
        invalidBelow: top ? null : head.price,
        research: false,
      };
    }
  }
  return null;
}
