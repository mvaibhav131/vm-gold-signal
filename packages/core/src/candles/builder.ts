import { CandleAggregator, type ClosedCandle, sortClosed } from './aggregator';
import { type FeedGap, makeGap } from './gaps';
import { divideRoundHalfUp, fromMilli, midMilli, toMilli } from './price';
import { MINUTE_MS, type MarketCandle, type TickInput } from './types';

/** A tick older than the newest data by more than this is dropped and counted (02_Signal_Engine section 2). */
export const DEFAULT_LATE_TOLERANCE_MS = 2_000;
/** No tick for longer than this is a feed gap (a trade open across it becomes DATA_INVALID, section 9). */
export const DEFAULT_GAP_THRESHOLD_MS = 60_000;
/** A tick stamped further ahead of the receive time than this is garbage and must not move the clock. */
export const DEFAULT_MAX_FUTURE_MS = 300_000;

export interface CandleBuilderOptions {
  readonly symbol: string;
  readonly lateToleranceMs?: number;
  readonly gapThresholdMs?: number;
  readonly maxFutureMs?: number;
}

/**
 * ACCEPTED: used. LATE: its minute is already sealed, dropped and counted. INVALID: not a usable
 * quote (wrong symbol, non-finite or non-positive price, ask below bid, stamped in the future).
 */
export type TickOutcome = 'ACCEPTED' | 'LATE' | 'INVALID';

export interface PushResult {
  readonly outcome: TickOutcome;
  /** Candles of every timeframe that became complete, in a fixed order. */
  readonly closed: readonly MarketCandle[];
  /** Feed gaps found between this tick and the previous one. */
  readonly gaps: readonly FeedGap[];
}

export interface BuilderStats {
  readonly accepted: number;
  readonly late: number;
  readonly invalid: number;
  readonly gaps: number;
  readonly minutesBuilt: number;
}

interface MinuteAccumulator {
  readonly start: number;
  openTs: number;
  closeTs: number;
  o: number;
  h: number;
  l: number;
  c: number;
  spreadSum: number;
  spreadMax: number;
  ticks: number;
}

function toMinuteCandle(symbol: string, acc: MinuteAccumulator): ClosedCandle {
  return {
    endMs: acc.start + MINUTE_MS,
    candle: {
      symbol,
      tf: '1m',
      openTime: acc.start,
      o: fromMilli(acc.o),
      h: fromMilli(acc.h),
      l: fromMilli(acc.l),
      c: fromMilli(acc.c),
      spreadAvg: fromMilli(divideRoundHalfUp(acc.spreadSum, acc.ticks)),
      spreadMax: fromMilli(acc.spreadMax),
      tickCount: acc.ticks,
      complete: true,
      source: 'live',
    },
  };
}

/**
 * Builds candles from ticks. Pure and deterministic: the same ticks in the same order always give
 * the same candles, so the live worker, the backtester and the tests agree.
 *
 * - The source timestamp is the clock; mid = (bid + ask) / 2 rounded half up to 3 decimals.
 * - A 1m candle is sealed once the newest source time is `lateToleranceMs` past its end. Until
 *   then ticks that arrive slightly out of order still go into the right minute. Later than that
 *   they are dropped and counted.
 * - Higher timeframes are derived from sealed 1m candles only, never from ticks.
 * - Minutes without ticks produce no candle. Gaps are reported, never filled.
 */
export class CandleBuilder {
  private readonly symbol: string;
  private readonly lateToleranceMs: number;
  private readonly gapThresholdMs: number;
  private readonly maxFutureMs: number;
  private readonly aggregator: CandleAggregator;
  private readonly open = new Map<number, MinuteAccumulator>();
  /** Newest source time seen: the builder's clock. */
  private watermark = Number.NEGATIVE_INFINITY;
  /** Every 1m candle that ends at or before this instant is sealed. */
  private sealedUntil = Number.NEGATIVE_INFINITY;
  private lastTickTs: number | null = null;
  private accepted = 0;
  private late = 0;
  private invalid = 0;
  private gapCount = 0;
  private minutesBuilt = 0;

  constructor(options: CandleBuilderOptions) {
    this.symbol = options.symbol;
    this.lateToleranceMs = options.lateToleranceMs ?? DEFAULT_LATE_TOLERANCE_MS;
    this.gapThresholdMs = options.gapThresholdMs ?? DEFAULT_GAP_THRESHOLD_MS;
    this.maxFutureMs = options.maxFutureMs ?? DEFAULT_MAX_FUTURE_MS;
    this.aggregator = new CandleAggregator(options.symbol);
  }

  get stats(): BuilderStats {
    return {
      accepted: this.accepted,
      late: this.late,
      invalid: this.invalid,
      gaps: this.gapCount,
      minutesBuilt: this.minutesBuilt,
    };
  }

  push(tick: TickInput): PushResult {
    if (!this.isUsable(tick)) {
      this.invalid += 1;
      return { outcome: 'INVALID', closed: [], gaps: [] };
    }
    const minute = Math.floor(tick.ts / MINUTE_MS) * MINUTE_MS;
    if (minute + MINUTE_MS <= this.sealedUntil) {
      this.late += 1;
      return { outcome: 'LATE', closed: [], gaps: [] };
    }

    const gaps: FeedGap[] = [];
    if (this.lastTickTs !== null && tick.ts - this.lastTickTs > this.gapThresholdMs) {
      gaps.push(makeGap(this.lastTickTs, tick.ts));
      this.gapCount += 1;
    }
    this.lastTickTs = Math.max(this.lastTickTs ?? tick.ts, tick.ts);

    this.accumulate(minute, tick);
    this.accepted += 1;
    this.watermark = Math.max(this.watermark, tick.ts);
    return { outcome: 'ACCEPTED', closed: this.seal(), gaps };
  }

  /**
   * Moves the clock forward without a tick, for example when the market is closed and no tick
   * will ever arrive for the last candles. Pass source time, not the worker's wall clock.
   */
  advanceTo(sourceTs: number): readonly MarketCandle[] {
    this.watermark = Math.max(this.watermark, sourceTs);
    return this.seal();
  }

  /**
   * Restores state after a restart from closed 1m candles of the buckets still in progress
   * (loaded from the database). Call it before the first tick. Returns the higher timeframe
   * candles that completed while seeding so the caller can upsert them idempotently.
   */
  seedMinutes(minutes: readonly MarketCandle[]): readonly MarketCandle[] {
    if (this.watermark !== Number.NEGATIVE_INFINITY || this.open.size > 0) {
      throw new Error('seedMinutes must be called before any tick');
    }
    const closed: ClosedCandle[] = [];
    for (const minute of minutes) closed.push(...this.aggregator.add(minute));
    const last = minutes.at(-1);
    if (last) {
      this.sealedUntil = last.openTime + MINUTE_MS;
      this.watermark = this.sealedUntil + this.lateToleranceMs;
      closed.push(...this.aggregator.closeThrough(this.sealedUntil));
    }
    return sortClosed(closed);
  }

  /**
   * Restores the most recent tick before replaying ticks after the last persisted minute. This
   * preserves gap detection without adding the tick to a candle that has already been sealed.
   */
  seedLastTick(tick: TickInput): void {
    if (this.accepted > 0 || this.lastTickTs !== null) {
      throw new Error('seedLastTick must be called before any tick');
    }
    if (!this.isUsable(tick)) throw new RangeError('the seed tick is not usable');
    this.lastTickTs = tick.ts;
  }

  /** The 1m candles still collecting ticks, as incomplete candles. */
  openMinutes(): MarketCandle[] {
    return [...this.open.values()]
      .sort((a, b) => a.start - b.start)
      .map((acc) => ({ ...toMinuteCandle(this.symbol, acc).candle, complete: false }));
  }

  private isUsable(tick: TickInput): boolean {
    return (
      tick.symbol === this.symbol &&
      Number.isFinite(tick.ts) &&
      Number.isFinite(tick.rxAt) &&
      Number.isFinite(tick.bid) &&
      Number.isFinite(tick.ask) &&
      tick.bid > 0 &&
      tick.ask >= tick.bid &&
      tick.ts - tick.rxAt <= this.maxFutureMs
    );
  }

  private accumulate(minute: number, tick: TickInput): void {
    const bid = toMilli(tick.bid);
    const ask = toMilli(tick.ask);
    const mid = midMilli(bid, ask);
    const spread = ask - bid;
    const acc = this.open.get(minute);
    if (!acc) {
      this.open.set(minute, {
        start: minute,
        openTs: tick.ts,
        closeTs: tick.ts,
        o: mid,
        h: mid,
        l: mid,
        c: mid,
        spreadSum: spread,
        spreadMax: spread,
        ticks: 1,
      });
      return;
    }
    // Ticks inside one minute may arrive slightly out of order: open is the earliest, close the
    // latest. On equal timestamps the first open and the last close (arrival order) win.
    if (tick.ts < acc.openTs) {
      acc.openTs = tick.ts;
      acc.o = mid;
    }
    if (tick.ts >= acc.closeTs) {
      acc.closeTs = tick.ts;
      acc.c = mid;
    }
    acc.h = Math.max(acc.h, mid);
    acc.l = Math.min(acc.l, mid);
    acc.spreadSum += spread;
    acc.spreadMax = Math.max(acc.spreadMax, spread);
    acc.ticks += 1;
  }

  private seal(): MarketCandle[] {
    const target = Math.floor((this.watermark - this.lateToleranceMs) / MINUTE_MS) * MINUTE_MS;
    if (!(target > this.sealedUntil)) return [];

    const ready = [...this.open.values()]
      .filter((acc) => acc.start + MINUTE_MS <= target)
      .sort((a, b) => a.start - b.start);
    const closed: ClosedCandle[] = [];
    for (const acc of ready) {
      this.open.delete(acc.start);
      const minute = toMinuteCandle(this.symbol, acc);
      this.minutesBuilt += 1;
      closed.push(minute, ...this.aggregator.add(minute.candle));
    }
    closed.push(...this.aggregator.closeThrough(target));
    this.sealedUntil = target;
    return sortClosed(closed);
  }
}

/** Builds all candles from a finished list of ticks (history, tests, backtests). Open minutes are not returned. */
export function buildCandles(
  options: CandleBuilderOptions,
  ticks: Iterable<TickInput>,
  finalClockTs?: number,
): { candles: MarketCandle[]; gaps: FeedGap[]; stats: BuilderStats } {
  const builder = new CandleBuilder(options);
  const candles: MarketCandle[] = [];
  const gaps: FeedGap[] = [];
  for (const tick of ticks) {
    const result = builder.push(tick);
    candles.push(...result.closed);
    gaps.push(...result.gaps);
  }
  if (finalClockTs !== undefined) candles.push(...builder.advanceTo(finalClockTs));
  return { candles, gaps, stats: builder.stats };
}
