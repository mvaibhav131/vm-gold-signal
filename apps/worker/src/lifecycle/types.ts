import type {
  AfterCandle,
  AlertSettings,
  CauseCode,
  CourseCandle,
  ExitProfile,
  ExplanationDoc,
  GroupState,
  HighImpactSeen,
  LifecycleEvent,
  OutboxChannel,
  OutboxRow,
  QualityGroup,
  Regime,
  Review,
  Side,
  SignalEventType,
  SignalMode,
  StrategyKey,
  StrategyStatus,
  TickInput,
  TradeOutcome,
  TradeState,
} from '@vmgs/core';
import type { SignalDraft } from '@vmgs/contracts';
import type { StrategyConfig } from '@vmgs/config';

/** One entry of the signal log (`signal_events`): the events of the tracker, and the ones the lifecycle itself writes. */
export interface LogEvent {
  readonly type: SignalEventType;
  readonly at: number;
  readonly price: number | null;
}

/** A strategy version row: signals point at it, and its config is immutable. */
export interface StrategyVersionRef {
  readonly id: string;
  readonly strategyKey: StrategyKey;
  readonly version: string;
  readonly status: StrategyStatus;
}

/** A stored signal with what the lifecycle needs to follow, review and announce it (times in epoch milliseconds). */
export interface SignalRecord {
  readonly id: string;
  /** The number the owner sees: S-0042. */
  readonly seq: number;
  readonly createdAt: number;
  readonly strategy: StrategyVersionRef;
  readonly side: Side;
  readonly mode: SignalMode;
  readonly exitProfile: ExitProfile;
  readonly generatedAt: number;
  /** The time of the confirming tick: the simulated fill happens here. */
  readonly sourceAt: number;
  readonly entry: number;
  readonly maxValidEntry: number;
  readonly entryValidUntil: number;
  readonly stopLoss: number;
  readonly tp1: number;
  readonly tp2: number | null;
  readonly riskDistance: number;
  readonly atr5: number;
  readonly timeStopAt: number;
  readonly regime: Regime;
  readonly groups: readonly { readonly key: QualityGroup; readonly state: GroupState }[];
  /** The spread of the confirming quote: the number `spread` of the feature snapshot, null when it was not recorded. */
  readonly spreadAtEntry: number | null;
  readonly explanation: ExplanationDoc;
  /** From the config of the strategy version (immutable): what a fill and a commission cost. */
  readonly simSlippageUsd: number;
  readonly commissionUsdPerOz: number;
  readonly maxTickAgeSec: number;
  /** The channels that were told about the entry: only they get the TP1, the result and the review. */
  readonly told: readonly OutboxChannel[];
}

export interface CreatedSignal {
  readonly id: string;
  readonly seq: number;
  readonly createdAt: number;
}

export type CreateSignalResult =
  | { readonly status: 'CREATED'; readonly created: CreatedSignal }
  /** The setup already produced a signal for this strategy version and side (`signals_setup_once_idx`): nothing was written. */
  | { readonly status: 'DUPLICATE' };

/** What the closing of a signal writes besides the outcome. */
export interface ClosingWrite {
  readonly outcome: TradeOutcome;
  /** Extra facts of the outcome (`signal_outcomes.meta`), e.g. how long the feed was silent. */
  readonly meta: Readonly<Record<string, unknown>>;
  /** The preliminary review, for a trade that is reviewed. */
  readonly review: StoredReview | null;
}

export interface StoredReview {
  readonly review: Review;
  readonly computedAt: number;
  readonly finalizedAt: number | null;
}

/** One transaction of the outcome tracker: the events, the new state or the closing, and the messages that go with them. */
export interface LifecycleWrite {
  readonly signalId: string;
  /** Written once each: an event type that the signal already has is skipped (recovery repeats what it finds). */
  readonly events: readonly LifecycleEvent[];
  /** The working state to keep while the signal is open. */
  readonly state: TradeState | null;
  readonly closing: ClosingWrite | null;
  readonly outbox: readonly OutboxRow[];
  /** The time of this write (epoch milliseconds), for `signal_state.updated_at`. */
  readonly at: number;
}

export interface FinalReviewWrite {
  readonly signalId: string;
  readonly review: Review;
  readonly finalizedAt: number;
  readonly outbox: readonly OutboxRow[];
}

/** A closed signal whose preliminary review is waiting for its final version. */
export interface PendingReview {
  readonly record: SignalRecord;
  readonly outcome: TradeOutcome;
  readonly preliminary: Review;
}

/** The signal side of the database: writing a signal and its life, and reading it back. */
export interface LifecycleStore {
  /** Makes sure the strategy version exists; its config never changes (a changed config must be a new version). */
  ensureStrategyVersion(config: StrategyConfig): Promise<StrategyVersionRef>;
  /** The settings of the owner (`app_settings`), with the documented defaults for what is missing. */
  loadSettings(): Promise<AlertSettings>;
  /**
   * The signal transaction (01_HLD section 5): the signal, its working state, the `CREATED` event
   * and the messages, all or nothing. `outbox` writes the messages once the number of the signal is
   * known. A setup that already has a signal writes nothing.
   */
  createSignal(
    draft: SignalDraft,
    strategy: StrategyVersionRef,
    outbox: (created: CreatedSignal) => readonly OutboxRow[],
    now: number,
  ): Promise<CreateSignalResult>;
  /** Every signal that has a working state, i.e. that is still open, oldest first. */
  loadOpenSignals(): Promise<SignalRecord[]>;
  getSignal(id: string): Promise<SignalRecord | null>;
  /** False when the signal was already closed (nothing is written then). */
  commit(write: LifecycleWrite): Promise<boolean>;
  /** Replaces a preliminary review by the final one; false when there is none to replace. */
  commitFinalReview(write: FinalReviewWrite): Promise<boolean>;
  /** The preliminary reviews of the signals that closed at or before `closedBefore`. */
  loadPendingReviews(closedBefore: number): Promise<PendingReview[]>;
  /**
   * How many reviewed results of a month (the first day of the UTC month of their decision, `2026-10-01`) name
   * this cause as the primary one, for all strategies: the "tracked this month" of the final review.
   */
  causeCount(month: string, cause: CauseCode): Promise<number>;
}

/** The market data the lifecycle reads: stored ticks and candles, and the events that were scheduled. */
export interface MarketReader {
  /** The stored ticks of the traded symbol with source time in [from, until), in the order they were received. */
  readTicks(from: number, until: number): AsyncIterable<TickInput> | Iterable<TickInput>;
  /** The 5m candles of the closing side (bid for a BUY, ask for a SELL) that the stored ticks make, with source time in [from, until). */
  closingSideCandles(side: Side, from: number, until: number): Promise<AfterCandle[]>;
  /** The newest `limit` complete 5m candles that opened at or before `until`, oldest first. */
  lastCandles5m(until: number, limit: number): Promise<CourseCandle[]>;
  /** The HIGH-impact calendar events and headlines inside [from, until] (epoch milliseconds, both included). */
  highImpact(from: number, until: number): Promise<HighImpactSeen[]>;
}
