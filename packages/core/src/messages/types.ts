import type {
  CauseCode,
  ExitProfile,
  Locale,
  NotificationKind,
  Side,
  SignalMode,
  StrategyKey,
  StrategyStatus,
} from '../domain';
import type { AutopsyStatus, QualityGroup } from '../domain';
import type { ExplanationDoc } from '../explain/types';
import type { TradeOutcome } from '../trade/types';

/** How a message is written for the owner: the language of the labels and the zone of the clock times. */
export interface DisplayOptions {
  readonly locale: Locale;
  /** An IANA zone, `Asia/Kolkata` by default in the settings. Times are stored in UTC. */
  readonly displayTz: string;
}

/** What every message about one signal needs to know about it (the stored signal, times in epoch milliseconds). */
export interface SignalRef {
  /** The id of the signal (a uuid); the link of a push opens `/signals/<id>`. */
  readonly id: string;
  /** The number that the owner sees: `S-0042`. */
  readonly seq: number;
  readonly side: Side;
  readonly strategyKey: StrategyKey;
  readonly strategyVersion: string;
  readonly mode: SignalMode;
  readonly strategyStatus: StrategyStatus;
  readonly exitProfile: ExitProfile;
  readonly generatedAt: number;
  readonly entryValidUntil: number;
  readonly timeStopAt: number;
  readonly entry: number;
  readonly maxValidEntry: number;
  readonly stopLoss: number;
  readonly tp1: number;
  readonly tp2: number | null;
  readonly riskDistance: number;
}

/** SIGNAL_NEW: the signal and its stored explanation. The levels of both must agree. */
export interface NewSignalData {
  readonly signal: SignalRef;
  readonly explanation: ExplanationDoc;
}

/** SIGNAL_TP1: the half of an `EP1_PARTIAL` trade was closed at TP1 and the stop moved to the entry. */
export interface Tp1Data {
  readonly signal: SignalRef;
  readonly at: number;
  readonly price: number;
}

/** The numbers behind a cause, as the review stores them. Only simple values are shown. */
export type CauseEvidence = Readonly<Record<string, unknown>>;

/** The automatic review of a trade (`autopsySchema` of the contracts, times in epoch milliseconds). */
export interface ReviewData {
  readonly status: AutopsyStatus;
  readonly primaryCause: CauseCode;
  readonly causes: readonly { readonly code: CauseCode; readonly evidence: CauseEvidence }[];
  readonly weakGroupsAtEntry: readonly {
    readonly group: QualityGroup;
    readonly state: 'WEAK' | 'FAIL';
  }[];
  readonly counterfactual: {
    readonly reachedTp1: boolean;
    readonly candlesToTp1: number | null;
  } | null;
}

/** SIGNAL_CLOSED: how a trade ended (`TradeTracker.outcome`), with the review when there is one. */
export interface ClosedData {
  readonly signal: SignalRef;
  readonly outcome: TradeOutcome;
  readonly review: ReviewData | null;
  /** What worked, for a win: short phrases from the groups that stayed strong. Optional. */
  readonly worked?: readonly string[];
}

/** SIGNAL_CANCELLED: market data went stale during the entry window, so the signal could not be followed. */
export interface CancelledData {
  readonly signal: SignalRef;
  /** For how long the data was stale, in seconds, when that is known. */
  readonly staleSeconds: number | null;
}

/** SIGNAL_REVIEW_FINAL. */
export interface FinalReviewData {
  readonly signal: SignalRef;
  readonly review: ReviewData;
  /** The primary cause of the preliminary review, to say that it changed. */
  readonly previousPrimary: CauseCode | null;
  /** How many trades of this cause the month has (the line "Tracked in Analytics"), when known. */
  readonly trackedThisMonth: number | null;
}

/** A Telegram message: plain text, already escaped for HTML parse mode. */
export interface TelegramMessage {
  readonly kind: NotificationKind;
  readonly text: string;
  /** 0 is the full message; a higher level left out more of the optional parts to fit the length. */
  readonly level: number;
  /** The optional parts that were left out. */
  readonly dropped: readonly string[];
}

/** A Web Push notification (04_API_and_Notifications section 5). */
export interface PushMessage {
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  /** Where a click goes: `/signals/<id>`. */
  readonly url: string;
  /** How long the push service may hold it, in seconds. */
  readonly ttlSec: number;
  readonly urgency: 'high' | 'normal';
  /** The outbox event key, so that a repeated push replaces the earlier one. */
  readonly tag: string;
}
