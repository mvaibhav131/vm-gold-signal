import { CandleBuilder, TRADED_SYMBOL, findCandleGaps, type MarketCandle } from '@vmgs/core';
import type { Feed, FeedEvent, FeedStats, RejectReason } from '@vmgs/feed';

import {
  EMPTY_BATCH,
  type GapRecord,
  type PersistedCounts,
  type RecorderBatch,
  type RecorderStore,
} from './store';

const HEARTBEAT_EVERY_MS = 15_000;
const PARTITION_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export interface RecorderWorkerOptions {
  readonly feed: Feed;
  readonly store: RecorderStore;
  readonly symbols: readonly string[];
  readonly providerName: string;
  readonly workerName?: string;
  readonly tradedSymbol?: string;
  readonly now?: () => number;
  readonly batchSize?: number;
  readonly flushEveryMs?: number;
  readonly maxQueuedFrames?: number;
  readonly heartbeatEveryMs?: number;
  readonly partitionCheckEveryMs?: number;
  /** Replay inputs are already in the ticks table, so only their candles and gaps are persisted. */
  readonly persistTicks?: boolean;
  readonly onFatalError?: (error: unknown) => void;
}

export interface RecorderWorkerStats {
  readonly feed: FeedStats;
  readonly acceptedByBuilders: number;
  readonly lateByBuilders: number;
  readonly invalidByBuilders: number;
  readonly persisted: PersistedCounts;
  readonly queuedFrames: number;
  readonly lastPersistAt: number | null;
  readonly currentFeedState: string | null;
}

interface PendingFrame {
  readonly batch: RecorderBatch;
}

function emptyPersisted(): PersistedCounts {
  return { ticks: 0, candles: 0, gaps: 0, incidents: 0 };
}

function addCounts(
  target: { ticks: number; candles: number; gaps: number; incidents: number },
  counts: PersistedCounts,
) {
  target.ticks += counts.ticks;
  target.candles += counts.candles;
  target.gaps += counts.gaps;
  target.incidents += counts.incidents;
}

function noDataBatch(): RecorderBatch {
  return EMPTY_BATCH;
}

export class RecorderWorker {
  private readonly feed: Feed;
  private readonly store: RecorderStore;
  private readonly symbols: readonly string[];
  private readonly providerName: string;
  private readonly workerName: string;
  private readonly tradedSymbol: string;
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly maxQueuedFrames: number;
  private readonly persistTicks: boolean;
  private readonly onFatalError: (error: unknown) => void;
  private readonly builders = new Map<string, CandleBuilder>();
  private readonly rejected: Record<RejectReason, number> = {
    MALFORMED: 0,
    UNKNOWN_SYMBOL: 0,
    BAD_TIME: 0,
    BAD_PRICE: 0,
    CROSSED: 0,
    FUTURE: 0,
    DUPLICATE: 0,
    OUT_OF_ORDER: 0,
    JUMP: 0,
  };
  private readonly persisted = emptyPersisted();
  private readonly pending: PendingFrame[] = [];
  private readonly flushEveryMs: number;
  private readonly heartbeatEveryMs: number;
  private readonly partitionCheckEveryMs: number;
  private listener: (() => void) | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private partitionTimer: ReturnType<typeof setInterval> | null = null;
  private flushPromise: Promise<void> | null = null;
  private lastPersistAt: number | null = null;
  private currentFeedState: string | null = null;
  private fatalError: Error | null = null;
  private started = false;
  private stopping = false;

  constructor(options: RecorderWorkerOptions) {
    if (options.symbols.length === 0)
      throw new RangeError('at least one recorder symbol is needed');
    const tradedSymbol = options.tradedSymbol ?? TRADED_SYMBOL;
    if (!options.symbols.includes(tradedSymbol)) {
      throw new RangeError(`recorder symbols must include ${tradedSymbol}`);
    }
    this.feed = options.feed;
    this.store = options.store;
    this.symbols = [...new Set(options.symbols)];
    if (this.symbols.length !== options.symbols.length) {
      throw new RangeError('recorder symbols must be unique');
    }
    this.providerName = options.providerName;
    this.workerName = options.workerName ?? 'worker';
    this.tradedSymbol = tradedSymbol;
    this.now = options.now ?? Date.now;
    this.batchSize = options.batchSize ?? 500;
    this.flushEveryMs = options.flushEveryMs ?? 1_000;
    this.maxQueuedFrames = options.maxQueuedFrames ?? 10_000;
    this.heartbeatEveryMs = options.heartbeatEveryMs ?? HEARTBEAT_EVERY_MS;
    this.partitionCheckEveryMs = options.partitionCheckEveryMs ?? PARTITION_CHECK_EVERY_MS;
    this.persistTicks = options.persistTicks ?? true;
    this.onFatalError =
      options.onFatalError ??
      ((error) => {
        queueMicrotask(() => {
          throw error;
        });
      });

    for (const symbol of this.symbols) {
      this.builders.set(symbol, new CandleBuilder({ symbol }));
    }
    for (const [name, value] of [
      ['batchSize', this.batchSize],
      ['flushEveryMs', this.flushEveryMs],
      ['maxQueuedFrames', this.maxQueuedFrames],
      ['heartbeatEveryMs', this.heartbeatEveryMs],
      ['partitionCheckEveryMs', this.partitionCheckEveryMs],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
  }

  get stats(): RecorderWorkerStats {
    let acceptedByBuilders = 0;
    let lateByBuilders = 0;
    let invalidByBuilders = 0;
    for (const builder of this.builders.values()) {
      const stats = builder.stats;
      acceptedByBuilders += stats.accepted;
      lateByBuilders += stats.late;
      invalidByBuilders += stats.invalid;
    }
    return {
      feed: this.feed.stats,
      acceptedByBuilders,
      lateByBuilders,
      invalidByBuilders,
      persisted: { ...this.persisted },
      queuedFrames: this.pending.length,
      lastPersistAt: this.lastPersistAt,
      currentFeedState: this.currentFeedState,
    };
  }

  async start(): Promise<void> {
    if (this.started || this.stopping) throw new Error('recorder worker can only be started once');
    try {
      await this.store.ensureTickPartitions();
      await this.store.closeOpenIncidents(this.now());
      const recovery = await this.store.loadRecovery(this.symbols, this.tradedSymbol, this.now());
      await this.recover(recovery);
      this.feed.prime(recovery.latestTicks);
      this.listener = this.feed.on((event) => {
        this.onFeedEvent(event);
      });
      await this.writeHeartbeat();
      this.flushTimer = setInterval(() => {
        this.scheduleFlush();
      }, this.flushEveryMs);
      this.heartbeatTimer = setInterval(() => {
        void this.writeHeartbeat().catch((error: unknown) => this.fail(error));
      }, this.heartbeatEveryMs);
      this.partitionTimer = setInterval(() => {
        void this.ensurePartitions().catch((error: unknown) => this.fail(error));
      }, this.partitionCheckEveryMs);
      await this.feed.start();
      this.started = true;
    } catch (error) {
      this.clearTimers();
      this.listener?.();
      this.listener = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.clearTimers();
    await this.feed.stop();
    this.listener?.();
    this.listener = null;
    await this.flush();
    this.started = false;
  }

  private async recover(
    recovery: Awaited<ReturnType<RecorderStore['loadRecovery']>>,
  ): Promise<void> {
    const candles: MarketCandle[] = [];
    const gaps: GapRecord[] = [];
    for (const symbol of this.symbols) {
      const minutes = recovery.minutesBySymbol.get(symbol) ?? [];
      let previousOpenTime = Number.NEGATIVE_INFINITY;
      for (const minute of minutes) {
        if (minute.symbol !== symbol || minute.tf !== '1m' || !minute.complete) {
          throw new Error(`recovery data for ${symbol} must contain complete 1m candles only`);
        }
        if (minute.openTime <= previousOpenTime) {
          throw new Error(`recovery candles for ${symbol} are not strictly ordered`);
        }
        previousOpenTime = minute.openTime;
      }
      gaps.push(...findCandleGaps(minutes, '1m').map((gap) => ({ symbol, gap })));
      const builder = this.builders.get(symbol);
      if (builder === undefined) throw new Error(`no candle builder for ${symbol}`);
      candles.push(...builder.seedMinutes(minutes));
    }

    const tradedBuilder = this.builders.get(this.tradedSymbol);
    if (tradedBuilder === undefined) throw new Error(`no candle builder for ${this.tradedSymbol}`);
    if (recovery.previousTradedTick !== null) {
      tradedBuilder.seedLastTick(recovery.previousTradedTick);
    }

    let previousReplayTs = Number.NEGATIVE_INFINITY;
    for await (const tick of this.store.readTicks(
      this.tradedSymbol,
      recovery.replayFromMs,
      recovery.replayUntilMs,
    )) {
      if (tick.symbol !== this.tradedSymbol) {
        throw new Error(`recovery returned a non-traded symbol: ${tick.symbol}`);
      }
      if (tick.ts < previousReplayTs)
        throw new Error('recovery ticks are not in source-time order');
      previousReplayTs = tick.ts;
      const result = tradedBuilder.push(tick);
      if (result.outcome === 'INVALID') {
        throw new Error(`stored recovery tick at ${new Date(tick.ts).toISOString()} is invalid`);
      }
      candles.push(...result.closed);
      gaps.push(...result.gaps.map((gap) => ({ symbol: this.tradedSymbol, gap })));
      if (candles.length + gaps.length >= this.batchSize) {
        await this.persistRecovery(candles.splice(0), gaps.splice(0));
      }
    }
    if (candles.length > 0 || gaps.length > 0) {
      await this.persistRecovery(candles, gaps);
    }
  }

  private async persistRecovery(
    candles: readonly MarketCandle[],
    gaps: readonly GapRecord[],
  ): Promise<void> {
    const counts = await this.store.writeBatch({
      ...noDataBatch(),
      candles,
      gaps,
    });
    addCounts(this.persisted, counts);
    this.lastPersistAt = this.now();
  }

  private onFeedEvent(event: FeedEvent): void {
    if (this.fatalError !== null || this.stopping) return;
    if (event.type === 'state') {
      this.currentFeedState = event.state;
      if (event.state === 'MARKET_CLOSED') {
        const candles = [...this.builders.values()].flatMap((builder) =>
          builder.advanceTo(event.at),
        );
        if (candles.length > 0) {
          this.enqueue({
            ...EMPTY_BATCH,
            candles,
          });
        }
      }
      return;
    }
    if (event.type === 'rejected') {
      this.rejected[event.reason] += 1;
      return;
    }
    if (event.type === 'incident') {
      this.enqueue({
        ...noDataBatch(),
        incidents: [{ phase: event.phase, incident: event.incident }],
      });
      return;
    }

    const builder = this.builders.get(event.tick.symbol);
    if (builder === undefined) {
      this.fail(new Error(`no candle builder for ${event.tick.symbol}`));
      return;
    }
    const result = builder.push(event.tick);
    if (result.outcome === 'INVALID') {
      this.fail(new Error(`feed emitted an invalid tick for ${event.tick.symbol}`));
      return;
    }
    const ticks = this.persistTicks && event.tick.symbol === this.tradedSymbol ? [event.tick] : [];
    const gaps = result.gaps.map((gap) => ({ symbol: event.tick.symbol, gap }));
    if (ticks.length > 0 || result.closed.length > 0 || gaps.length > 0) {
      this.enqueue({
        ticks,
        candles: result.closed,
        gaps,
        incidents: [],
      });
    }
  }

  private enqueue(batch: RecorderBatch): void {
    this.pending.push({ batch });
    if (this.pending.length > this.maxQueuedFrames) {
      this.fail(new Error(`recorder queue exceeded ${this.maxQueuedFrames} frames`));
      return;
    }
    if (this.pending.length >= this.batchSize) this.scheduleFlush();
  }

  private scheduleFlush(): void {
    void this.flush().catch((error: unknown) => this.fail(error));
  }

  private async flush(): Promise<void> {
    if (this.fatalError !== null) throw this.fatalError;
    if (this.flushPromise !== null) return this.flushPromise;
    this.flushPromise = this.flushQueued();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }
  }

  private async flushQueued(): Promise<void> {
    while (this.pending.length > 0) {
      if (this.fatalError !== null) throw this.fatalError;
      const frames = this.pending.splice(0, this.batchSize);
      const batch: RecorderBatch = {
        ticks: frames.flatMap(({ batch: frame }) => frame.ticks),
        candles: frames.flatMap(({ batch: frame }) => frame.candles),
        gaps: frames.flatMap(({ batch: frame }) => frame.gaps),
        incidents: frames.flatMap(({ batch: frame }) => frame.incidents),
      };
      try {
        const counts = await this.store.writeBatch(batch);
        addCounts(this.persisted, counts);
        this.lastPersistAt = this.now();
      } catch (error) {
        this.pending.unshift(...frames);
        this.fail(error);
        throw error;
      }
    }
  }

  private async writeHeartbeat(): Promise<void> {
    await this.store.writeHeartbeat(this.workerName, this.now(), {
      mode: 'record-only',
      provider: this.providerName,
      symbols: this.symbols,
      feed: this.feed.stats,
      recorder: {
        acceptedByBuilders: this.totalBuilderCount('accepted'),
        lateByBuilders: this.totalBuilderCount('late'),
        invalidByBuilders: this.totalBuilderCount('invalid'),
        rejected: { ...this.rejected },
        persisted: { ...this.persisted },
        queuedFrames: this.pending.length,
        feedState: this.currentFeedState,
      },
    });
  }

  private totalBuilderCount(kind: 'accepted' | 'late' | 'invalid'): number {
    let count = 0;
    for (const builder of this.builders.values()) count += builder.stats[kind];
    return count;
  }

  private async ensurePartitions(): Promise<void> {
    const created = await this.store.ensureTickPartitions();
    if (created > 0) {
      await this.writeHeartbeat();
    }
  }

  private fail(error: unknown): Error {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (this.fatalError === null) {
      this.fatalError = failure;
      this.onFatalError(failure);
    }
    return failure;
  }

  private clearTimers(): void {
    if (this.flushTimer !== null) clearInterval(this.flushTimer);
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    if (this.partitionTimer !== null) clearInterval(this.partitionTimer);
    this.flushTimer = null;
    this.heartbeatTimer = null;
    this.partitionTimer = null;
  }
}
