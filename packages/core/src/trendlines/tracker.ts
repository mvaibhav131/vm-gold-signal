import { TIMEFRAME_MS, type Timeframe } from '../domain';
import { assertCandle, assertInOrder, type Pivot, type StructureCandle } from '../structure/types';
import { channelOf, type Channel } from './channels';
import { bestTrendline, findTrendlines, type Trendline } from './lines';
import { TRENDLINE_DEFAULTS, type TrendlineParams } from './types';

/** What the tracker needs from the market structure of the same timeframe: `MarketStructure` has all three. */
export interface PivotFeed {
  readonly atr: number | null;
  readonly highPivots: readonly Pivot[];
  readonly lowPivots: readonly Pivot[];
}

export interface TrendlineUpdate {
  /** Every valid line, best first (collinear swing points give several lines of the same geometry). */
  readonly lines: readonly Trendline[];
  /** The best support line and the best resistance line, the ones the engine keeps. */
  readonly support: Trendline | null;
  readonly resistance: Trendline | null;
  readonly supportChannel: Channel | null;
  readonly resistanceChannel: Channel | null;
}

/**
 * Trendlines and channels of one timeframe, candle by candle (docs/02 section 4.1). Feed it each
 * closed candle right after the `MarketStructure` of the same timeframe has taken it:
 * `structure.update(candle)` and then `trendlines.update(candle, structure)`. It keeps the last 80
 * candles itself and computes everything from them and the confirmed swing points, so it cannot
 * look ahead.
 */
export class TrendlineTracker {
  private readonly candles: StructureCandle[] = [];
  private readonly candleMs: number;
  private seen = 0;
  private lastOpenTime: number | null = null;
  private latest: TrendlineUpdate = {
    lines: [],
    support: null,
    resistance: null,
    supportChannel: null,
    resistanceChannel: null,
  };

  constructor(
    tf: Timeframe,
    private readonly params: TrendlineParams = TRENDLINE_DEFAULTS,
    private readonly tag: string = tf,
  ) {
    this.candleMs = TIMEFRAME_MS[tf];
  }

  get count(): number {
    return this.seen;
  }

  get value(): TrendlineUpdate {
    return this.latest;
  }

  update(candle: StructureCandle, feed: PivotFeed): TrendlineUpdate {
    assertCandle(candle);
    assertInOrder(this.lastOpenTime, candle);
    this.lastOpenTime = candle.openTime;
    this.seen += 1;
    this.candles.push(candle);
    if (this.candles.length > this.params.window) this.candles.shift();

    const lines = findTrendlines({
      candles: this.candles,
      count: this.seen,
      highs: feed.highPivots,
      lows: feed.lowPivots,
      atr: feed.atr,
      candleMs: this.candleMs,
      tag: this.tag,
      params: this.params,
    });
    const support = bestTrendline(lines, 'SUPPORT');
    const resistance = bestTrendline(lines, 'RESISTANCE');
    const channel = (line: Trendline | null) =>
      line
        ? channelOf({
            line,
            highs: feed.highPivots,
            lows: feed.lowPivots,
            atr: feed.atr,
            params: this.params,
          })
        : null;
    this.latest = {
      lines,
      support,
      resistance,
      supportChannel: channel(support),
      resistanceChannel: channel(resistance),
    };
    return this.latest;
  }
}
