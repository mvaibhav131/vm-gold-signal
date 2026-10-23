import type { Pivot } from '../structure/types';
import {
  DIVERGENCE_DEFAULTS,
  type Divergence,
  type DivergenceKind,
  type DivergenceParams,
  type DivergenceSource,
} from './types';

const SOURCE_CODE: Readonly<Record<DivergenceSource, string>> = {
  RSI: 'RSI',
  MACD_HISTOGRAM: 'MACDH',
};

/**
 * The divergence between two consecutive confirmed swing points of the same kind and the oscillator
 * at their candles (docs/02 section 4.1), or null.
 *
 * - Bullish, regular: swing lows, price makes a lower low and the oscillator a higher low, and the
 *   oscillator at the first low is at or below the zone (RSI 40). Hidden: a higher low in price and a
 *   lower low in the oscillator. Bearish is the mirror, on swing highs (RSI at or above 60).
 * - The two points are `minSpan` to `maxSpan` candles apart. Equal prices or equal oscillator values
 *   are no divergence. The zone is asked of regular divergence only, as written in the definition.
 */
export function divergenceOf(
  first: Pivot,
  second: Pivot,
  firstValue: number,
  secondValue: number,
  source: DivergenceSource,
  tag = '',
  params: DivergenceParams = DIVERGENCE_DEFAULTS,
): Divergence | null {
  if (first.kind !== second.kind || second.index <= first.index) return null;
  const span = second.index - first.index;
  if (span < params.minSpan || span > params.maxSpan) return null;

  const lows = second.kind === 'LOW';
  const priceBeyond = lows ? second.price < first.price : second.price > first.price;
  const priceBack = lows ? second.price > first.price : second.price < first.price;
  const valueBeyond = lows ? secondValue < firstValue : secondValue > firstValue;
  const valueBack = lows ? secondValue > firstValue : secondValue < firstValue;
  const zone = params.zone[source];
  const inZone = lows ? firstValue <= zone.low : firstValue >= zone.high;

  let kind: DivergenceKind;
  if (priceBeyond && valueBack && inZone) kind = 'REGULAR';
  else if (priceBack && valueBeyond) kind = 'HIDDEN';
  else return null;

  const direction = lows ? 'UP' : 'DOWN';
  return {
    id: `${tag}DIV:${SOURCE_CODE[source]}:${kind}:${direction}:${String(first.index)}:${String(second.index)}`,
    source,
    kind,
    direction,
    first: { index: first.index, openTime: first.openTime, price: first.price, value: firstValue },
    second: {
      index: second.index,
      openTime: second.openTime,
      price: second.price,
      value: secondValue,
    },
    index: second.confirmedIndex,
    openTime: second.confirmedOpenTime,
  };
}
