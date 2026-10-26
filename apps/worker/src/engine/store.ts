import type {
  AdvisoryModes,
  BucketDims,
  EngineCandle,
  EngineStateDoc,
  EngineTimeframe,
  ExplanationEvidence,
  OpenSignalInput,
  Rejection,
  StrategyKey,
} from '@vmgs/core';

/** A closed candle with its timeframe, as the store hands it over. */
export interface StoredCandle {
  readonly tf: EngineTimeframe;
  readonly candle: EngineCandle;
}

/** The newest candle of each timeframe that the engine has been given (null: none yet). */
export type CandleCursor = Readonly<Record<EngineTimeframe, number | null>>;

export interface CandleSource {
  /** The newest `limits[tf]` complete candles of each timeframe, oldest first: the warm-up. */
  history(limits: Readonly<Record<EngineTimeframe, number>>): Promise<StoredCandle[]>;
  /**
   * The complete candles after the cursor, oldest first, read in one statement: they are one consistent
   * state of the table, so a 15m or 1h candle that closes with a 5m candle is never missing from the pass
   * that has the 5m candle (they are written together). At most `limit` rows.
   */
  after(cursor: CandleCursor, limit: number): Promise<StoredCandle[]>;
}

/** The quote of a decision: source time, bid and ask, and when the worker received it. */
export interface StoredQuote {
  readonly t: number;
  readonly rxAt: number;
  readonly bid: number;
  readonly ask: number;
}

export interface QuoteSource {
  /** The first tick of the traded symbol at or after `ts`, null when there is none (yet). */
  firstQuoteAtOrAfter(ts: number): Promise<StoredQuote | null>;
}

/** What the owner has set that the decision reads each time: the pause, the advisory switches and the strategy switches. */
export interface EngineControls {
  readonly paused: boolean;
  readonly modes: Partial<AdvisoryModes>;
  /** The strategies the owner has switched off: they make no new signal and no rejection. */
  readonly disabled: readonly StrategyKey[];
}

/** An open signal as the decision needs it, with its public label (`#S-0042`). */
export interface OpenSignalFacts extends OpenSignalInput {
  readonly label: string;
}

/** Everything the decision loop reads and writes in the database. */
export interface EngineStore extends CandleSource, QuoteSource {
  controls(now: number): Promise<EngineControls>;
  openSignals(): Promise<OpenSignalFacts[]>;
  /** The evidence of a kind of setup: the rollups of the forward test, then of the backtest, as the signal shows them. */
  evidence(dims: BucketDims): Promise<ExplanationEvidence>;
  /** A setup that satisfied its strategy but may not become a signal (`rejections`, "WAIT: reason"). */
  recordRejection(at: number, rejection: Rejection): Promise<void>;
  /** The engine state after a decision (`app_settings.engineState`): `/status`, `/open` and the dashboard read it. */
  saveState(state: EngineStateDoc, at: number): Promise<void>;
}
