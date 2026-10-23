import type { Timeframe } from '../domain';
import { Macd, Rsi } from '../indicators/momentum';
import { assertCandle, assertInOrder, type Pivot, type StructureCandle } from '../structure/types';
import { divergenceOf } from './divergence';
import {
  DIVERGENCE_DEFAULTS,
  type Divergence,
  type DivergenceParams,
  type DivergenceSource,
} from './types';

/** What the tracker needs from the market structure of the same timeframe: `MarketStructure` has both. */
export interface SwingFeed {
  readonly highPivots: readonly Pivot[];
  readonly lowPivots: readonly Pivot[];
}

interface OscillatorValues {
  readonly rsi: number | null;
  readonly histogram: number | null;
}

/**
 * The divergences of one timeframe, candle by candle (docs/02 section 4.1). Feed it each closed
 * candle after the `MarketStructure` of the same timeframe: `structure.update(candle)`, then
 * `divergence.update(candle, structure)`. It runs RSI(14) and the MACD(12, 26, 9) histogram on the
 * closes itself and, when a swing point is confirmed, compares it with the swing point of the same
 * kind just before it. The answer is the divergences that became known on this candle, `RSI` ones
 * first. Only the oscillator at each swing point's own candle is used, so nothing looks ahead.
 */
export class DivergenceTracker {
  private readonly rsi = new Rsi();
  private readonly macd = new Macd();
  private readonly values: OscillatorValues[] = [];
  private readonly keep: number;
  private seen = 0;
  private lastOpenTime: number | null = null;

  constructor(
    tf: Timeframe,
    private readonly params: DivergenceParams = DIVERGENCE_DEFAULTS,
    private readonly tag: string = tf,
  ) {
    // the swing points of the spans are looked up here, with room for the confirmation delay
    this.keep = params.maxSpan + 50;
  }

  get count(): number {
    return this.seen;
  }

  update(candle: StructureCandle, feed: SwingFeed): readonly Divergence[] {
    assertCandle(candle);
    assertInOrder(this.lastOpenTime, candle);
    this.lastOpenTime = candle.openTime;
    const index = this.seen;
    this.seen += 1;
    this.values.push({
      rsi: this.rsi.update(candle.c),
      histogram: this.macd.update(candle.c)?.histogram ?? null,
    });
    if (this.values.length > this.keep) this.values.shift();

    const found: Divergence[] = [];
    const sources: readonly DivergenceSource[] = ['RSI', 'MACD_HISTOGRAM'];
    for (const source of sources) {
      for (const pivots of [feed.lowPivots, feed.highPivots]) {
        const second = pivots[pivots.length - 1];
        const first = pivots[pivots.length - 2];
        if (second?.confirmedIndex !== index || !first) continue;
        const firstValue = this.valueAt(first.index, source);
        const secondValue = this.valueAt(second.index, source);
        if (firstValue === null || secondValue === null) continue;
        const divergence = divergenceOf(
          first,
          second,
          firstValue,
          secondValue,
          source,
          this.tag,
          this.params,
        );
        if (divergence) found.push(divergence);
      }
    }
    return found;
  }

  private valueAt(index: number, source: DivergenceSource): number | null {
    const entry = this.values[index - (this.seen - this.values.length)];
    if (!entry) return null;
    return source === 'RSI' ? entry.rsi : entry.histogram;
  }
}
