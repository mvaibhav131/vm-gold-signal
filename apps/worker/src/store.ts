import type { FeedGap, MarketCandle, TickInput } from '@vmgs/core';

import type { FeedIncidentEvent } from '@vmgs/feed';

export interface GapRecord {
  readonly symbol: string;
  readonly gap: FeedGap;
}

export interface IncidentRecord {
  readonly phase: 'OPEN' | 'CLOSE';
  readonly incident: FeedIncidentEvent;
}

export interface RecorderBatch {
  readonly ticks: readonly TickInput[];
  readonly candles: readonly MarketCandle[];
  readonly gaps: readonly GapRecord[];
  readonly incidents: readonly IncidentRecord[];
}

export interface PersistedCounts {
  readonly ticks: number;
  readonly candles: number;
  readonly gaps: number;
  readonly incidents: number;
}

export interface RecorderRecovery {
  /** Complete 1m candles retained for the recent replay window, grouped by symbol. */
  readonly minutesBySymbol: ReadonlyMap<string, readonly MarketCandle[]>;
  /** Most recent stored tick per symbol, used to prime the live normalizer. */
  readonly latestTicks: readonly TickInput[];
  /** Last stored XAUUSD tick before replayFromMs, used to restore gap detection. */
  readonly previousTradedTick: TickInput | null;
  /** Replay persisted XAUUSD ticks in [replayFromMs, replayUntilMs) into the candle builder. */
  readonly replayFromMs: number;
  readonly replayUntilMs: number;
}

export interface RecorderStore {
  ensureTickPartitions(): Promise<number>;
  closeOpenIncidents(at: number): Promise<number>;
  loadRecovery(
    symbols: readonly string[],
    tradedSymbol: string,
    now: number,
  ): Promise<RecorderRecovery>;
  readTicks(
    symbol: string,
    from: number,
    until: number,
  ): AsyncIterable<TickInput> | Iterable<TickInput>;
  writeBatch(batch: RecorderBatch): Promise<PersistedCounts>;
  writeHeartbeat(
    workerName: string,
    at: number,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void>;
}

export const EMPTY_BATCH: RecorderBatch = {
  ticks: [],
  candles: [],
  gaps: [],
  incidents: [],
};
