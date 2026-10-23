import { TOLERANCE, type Pivot } from '../structure/types';
import { lineValueAt, type Trendline } from './lines';
import { TRENDLINE_DEFAULTS, type TrendlineParams } from './types';

/** A line parallel to a trendline through the extreme swing point on the other side of the price between its two points. */
export interface Channel {
  /** The id of the base line with `:channel`. */
  readonly id: string;
  /** The trendline the channel is parallel to. */
  readonly line: Trendline;
  /** The swing point the parallel passes through: the highest swing high between A and B for a support line, the lowest swing low for a resistance line. */
  readonly anchor: Pivot;
  /** Price distance from the base line to the parallel at the same instant (positive above). */
  readonly offset: number;
  /** Swing points of the other kind, from A on, within 0.15 x ATR of the parallel; the anchor is one. */
  readonly touchPoints: readonly Pivot[];
  readonly touches: number;
}

/** The price of the parallel line at an instant. */
export function channelValueAt(
  channel: Pick<Channel, 'line' | 'offset'>,
  openTime: number,
): number {
  return lineValueAt(channel.line, openTime) + channel.offset;
}

export interface ChannelInput {
  readonly line: Trendline;
  /** Confirmed swing points, oldest first. */
  readonly highs: readonly Pivot[];
  readonly lows: readonly Pivot[];
  readonly atr: number | null;
  readonly params?: TrendlineParams;
}

/**
 * The channel of a trendline (docs/02 section 4.1): a parallel line through the extreme swing point
 * of the opposite kind that lies between the line's points A and B, valid with at least two touches
 * (the anchor and one more). Null when there is no swing point between A and B or too few touches.
 */
export function channelOf(input: ChannelInput): Channel | null {
  const params = input.params ?? TRENDLINE_DEFAULTS;
  const { line, atr } = input;
  if (atr === null || !(atr > 0)) return null;
  const support = line.side === 'SUPPORT';
  const others = (support ? input.highs : input.lows).filter((p) => p.index >= line.a.index);

  let anchor: Pivot | null = null;
  for (const p of others) {
    if (p.index <= line.a.index || p.index >= line.b.index) continue;
    const better = anchor === null || (support ? p.price > anchor.price : p.price < anchor.price);
    if (better) anchor = p;
  }
  if (anchor === null) return null;

  const offset = anchor.price - lineValueAt(line, anchor.openTime);
  const touchPoints = others.filter(
    (p) =>
      Math.abs(p.price - (lineValueAt(line, p.openTime) + offset)) <=
      params.touchAtr * atr + TOLERANCE,
  );
  if (touchPoints.length < params.channelMinTouches) return null;
  return {
    id: `${line.id}:channel`,
    line,
    anchor,
    offset,
    touchPoints,
    touches: touchPoints.length,
  };
}
