import { type Indicator, RollingWindow, assertFinite, assertPeriod } from '../indicators/types';

/** 24 hours of 5m candles: the window of "its 24h median" in docs/02 section 5. */
export const BASELINE_CANDLES_24H = 288;

/**
 * The "normal" level of a value: the median of the `window` values before it. `update(value)`
 * answers with that median and then takes the value in, so a spike is always compared with what
 * was normal before it and never with itself. Used for ATR(5m) and for the spread, whose 24h medians
 * are the yardstick of the news shock and of the news window.
 *
 * The window counts candles, not clock time: a weekend has no candles, so it does not widen it.
 */
export class MedianBaseline implements Indicator<number, number> {
  readonly warmup: number;
  private readonly items: RollingWindow;
  private seen = 0;
  private latest: number | null = null;

  constructor(readonly window: number = BASELINE_CANDLES_24H) {
    assertPeriod(window, 'window');
    this.warmup = window + 1;
    this.items = new RollingWindow(window);
  }

  get count(): number {
    return this.seen;
  }

  get value(): number | null {
    return this.latest;
  }

  update(input: number): number | null {
    assertFinite(input, 'input');
    this.seen += 1;
    this.latest = this.items.full ? medianOf(this.items.toArray()) : null;
    this.items.push(input);
    return this.latest;
  }
}

/** The median of a list: the middle value, or the mean of the two middle values. */
export function medianOf(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('the median of nothing does not exist');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? Number.NaN;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[middle - 1] ?? Number.NaN) + upper) / 2;
}
