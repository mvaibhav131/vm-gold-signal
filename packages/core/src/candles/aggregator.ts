import { type CandleSource, TIMEFRAMES } from '../domain';
import { bucketEnd, bucketStart } from './buckets';
import { divideRoundHalfUp, fromMilli, toMilli } from './price';
import { HIGHER_TIMEFRAMES, type HigherTimeframe, MINUTE_MS, type MarketCandle } from './types';

/** A finished candle together with the instant it ended (used to emit candles in a fixed order). */
export interface ClosedCandle {
  readonly candle: MarketCandle;
  readonly endMs: number;
}

/** Closed candles ordered by the instant they ended, then by timeframe (1m before 5m ...). */
export function sortClosed(closed: readonly ClosedCandle[]): MarketCandle[] {
  const rank = (tf: MarketCandle['tf']) => TIMEFRAMES.indexOf(tf);
  return [...closed]
    .sort(
      (a, b) =>
        a.endMs - b.endMs ||
        rank(a.candle.tf) - rank(b.candle.tf) ||
        a.candle.openTime - b.candle.openTime,
    )
    .map((entry) => entry.candle);
}

// A bucket that mixes sources takes the least live one: any bootstrap minute marks the candle.
const SOURCE_RANK: Readonly<Record<CandleSource, number>> = {
  live: 0,
  biquote_ohlc_bootstrap: 1,
  histdata_bootstrap: 2,
};

interface Bucket {
  readonly tf: HigherTimeframe;
  readonly start: number;
  readonly end: number;
  o: number;
  h: number;
  l: number;
  c: number;
  spreadWeighted: number;
  spreadWeight: number;
  spreadMax: number | null;
  ticks: number;
  source: CandleSource;
}

function openBucket(tf: HigherTimeframe, minute: MarketCandle): Bucket {
  const start = bucketStart(tf, minute.openTime);
  const bucket: Bucket = {
    tf,
    start,
    end: bucketEnd(tf, start),
    o: toMilli(minute.o),
    h: toMilli(minute.h),
    l: toMilli(minute.l),
    c: toMilli(minute.c),
    spreadWeighted: 0,
    spreadWeight: 0,
    spreadMax: null,
    ticks: 0,
    source: minute.source,
  };
  addSpreadAndTicks(bucket, minute);
  return bucket;
}

function addSpreadAndTicks(bucket: Bucket, minute: MarketCandle): void {
  // Average spread is weighted by tick count, the same way a single tick-built candle would do it.
  if (minute.spreadAvg !== null && minute.tickCount > 0) {
    bucket.spreadWeighted += toMilli(minute.spreadAvg) * minute.tickCount;
    bucket.spreadWeight += minute.tickCount;
  }
  if (minute.spreadMax !== null) {
    bucket.spreadMax = Math.max(bucket.spreadMax ?? 0, toMilli(minute.spreadMax));
  }
  bucket.ticks += minute.tickCount;
  if (SOURCE_RANK[minute.source] > SOURCE_RANK[bucket.source]) bucket.source = minute.source;
}

function finish(symbol: string, bucket: Bucket): ClosedCandle {
  return {
    endMs: bucket.end,
    candle: {
      symbol,
      tf: bucket.tf,
      openTime: bucket.start,
      o: fromMilli(bucket.o),
      h: fromMilli(bucket.h),
      l: fromMilli(bucket.l),
      c: fromMilli(bucket.c),
      spreadAvg:
        bucket.spreadWeight > 0
          ? fromMilli(divideRoundHalfUp(bucket.spreadWeighted, bucket.spreadWeight))
          : null,
      spreadMax: bucket.spreadMax === null ? null : fromMilli(bucket.spreadMax),
      tickCount: bucket.ticks,
      complete: true,
      source: bucket.source,
    },
  };
}

/**
 * Derives 5m, 15m, 1h, 4h and 1d candles from closed 1m candles (higher timeframes never look at
 * ticks). Minutes must arrive in increasing order. A bucket is closed when a later minute starts
 * a new bucket, or when `closeThrough` says time has passed its end. Missing minutes are not
 * invented: a candle is built from the minutes that exist.
 */
export class CandleAggregator {
  private readonly buckets = new Map<HigherTimeframe, Bucket>();
  private lastMinute = Number.NEGATIVE_INFINITY;

  constructor(private readonly symbol: string) {}

  /** Adds one closed 1m candle. Returns the higher timeframe candles that closed because of it. */
  add(minute: MarketCandle): ClosedCandle[] {
    if (minute.tf !== '1m') throw new RangeError('the aggregator takes 1m candles only');
    if (minute.symbol !== this.symbol) throw new RangeError(`candle is not ${this.symbol}`);
    if (minute.openTime <= this.lastMinute) {
      throw new RangeError('1m candles must arrive in increasing order, without duplicates');
    }
    this.lastMinute = minute.openTime;

    const closed: ClosedCandle[] = [];
    for (const tf of HIGHER_TIMEFRAMES) {
      const current = this.buckets.get(tf);
      if (current && minute.openTime < current.end) {
        current.h = Math.max(current.h, toMilli(minute.h));
        current.l = Math.min(current.l, toMilli(minute.l));
        current.c = toMilli(minute.c);
        addSpreadAndTicks(current, minute);
        continue;
      }
      if (current) closed.push(finish(this.symbol, current));
      this.buckets.set(tf, openBucket(tf, minute));
    }
    return closed;
  }

  /** Closes every bucket that ends at or before `untilMs`. */
  closeThrough(untilMs: number): ClosedCandle[] {
    const closed: ClosedCandle[] = [];
    for (const tf of HIGHER_TIMEFRAMES) {
      const current = this.buckets.get(tf);
      if (current && current.end <= untilMs) {
        closed.push(finish(this.symbol, current));
        this.buckets.delete(tf);
      }
    }
    return closed;
  }
}

/**
 * Batch version for history (bootstrap, backtests): all higher timeframe candles that are
 * complete at `sealedUntilMs` (default: the end of the last minute), in emission order.
 */
export function aggregateMinutes(
  symbol: string,
  minutes: readonly MarketCandle[],
  sealedUntilMs?: number,
): MarketCandle[] {
  const aggregator = new CandleAggregator(symbol);
  const closed: ClosedCandle[] = [];
  for (const minute of minutes) closed.push(...aggregator.add(minute));
  const last = minutes.at(-1);
  const sealedUntil =
    sealedUntilMs ?? (last ? last.openTime + MINUTE_MS : Number.NEGATIVE_INFINITY);
  closed.push(...aggregator.closeThrough(sealedUntil));
  return sortClosed(closed);
}
