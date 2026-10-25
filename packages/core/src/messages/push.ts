import type { NotificationKind } from '../domain';
import { priceText, signedRText, spanText } from '../explain/format';
import { causeText, rewardR, signalTag } from './common';
import { WORDS } from './words';
import { clockText } from './time';
import type {
  CancelledData,
  ClosedData,
  DisplayOptions,
  FinalReviewData,
  NewSignalData,
  PushMessage,
  Tp1Data,
} from './types';

/** How long a result may wait in a push service: results are still useful late (04 section 4, "Delivery rules"). */
export const RESULT_TTL_SEC = 6 * 3600;

export type SignalStep = 'confirmed' | 'tp1' | 'closed' | 'review';

/** The outbox event key of a signal message (`signal:<id>:confirmed`): one message per key and channel. */
export const signalEventKey = (signalId: string, step: SignalStep): string =>
  `signal:${signalId}:${step}`;

/** The kinds of message that are about one signal. */
export type SignalMessageKind = Extract<
  NotificationKind,
  'SIGNAL_NEW' | 'SIGNAL_TP1' | 'SIGNAL_CLOSED' | 'SIGNAL_CANCELLED' | 'SIGNAL_REVIEW_FINAL'
>;

/**
 * How long a message about a signal may be delayed before it is dropped: an entry alert for the
 * length of the entry validity (a late one would invite a late entry), the others for 6 hours.
 */
export function messageTtlSec(kind: SignalMessageKind, entryValiditySec: number): number {
  return kind === 'SIGNAL_NEW' ? entryValiditySec : RESULT_TTL_SEC;
}

const urlOf = (id: string): string => `/signals/${id}`;

/**
 * The Web Push of a new signal (04 section 5): the title has the direction, the number and the
 * grade, the body the four levels, and a click opens the signal. The text is the same in both
 * languages: a push is too short for labels, and its words are the trading terms.
 */
export function pushNewSignal(data: NewSignalData): PushMessage {
  const { signal, explanation } = data;
  const levels = [
    `Entry ${priceText(signal.entry)}`,
    `stop ${priceText(signal.stopLoss)}`,
    `TP1 ${priceText(signal.tp1)}`,
  ];
  if (signal.tp2 !== null) levels.push(`TP2 ${priceText(signal.tp2)}`);
  return {
    kind: 'SIGNAL_NEW',
    title: `${signal.side} XAUUSD ${signalTag(signal.seq)} (${explanation.quality.grade} ${String(Math.round(explanation.quality.score))})`,
    body: levels.join(', '),
    url: urlOf(signal.id),
    ttlSec: messageTtlSec(
      'SIGNAL_NEW',
      Math.round((signal.entryValidUntil - signal.generatedAt) / 1000),
    ),
    urgency: 'high',
    tag: signalEventKey(signal.id, 'confirmed'),
  };
}

export function pushTp1(data: Tp1Data, options: DisplayOptions): PushMessage {
  const { signal } = data;
  return {
    kind: 'SIGNAL_TP1',
    title: `TP1 HIT ${signalTag(signal.seq)} ${signedRText(rewardR(signal, signal.tp1))}`,
    body: `Price ${priceText(data.price)} at ${clockText(data.at, options.displayTz, signal.generatedAt)}. Close half, move stop to entry ${priceText(signal.entry)}`,
    url: urlOf(signal.id),
    ttlSec: RESULT_TTL_SEC,
    urgency: 'high',
    tag: signalEventKey(signal.id, 'tp1'),
  };
}

const RESULT_TITLE = {
  WIN: 'WIN',
  PARTIAL_WIN: 'PARTIAL WIN',
  LOSS: 'LOSS',
  TIME_EXIT: 'TIME EXIT',
  DATA_INVALID: 'DATA INVALID',
} as const;

export function pushClosed(data: ClosedData, options: DisplayOptions): PushMessage {
  const { signal, outcome } = data;
  if (outcome.result === 'CANCELLED') {
    throw new RangeError('a cancelled signal has its own push (pushCancelled)');
  }
  const tag = signalTag(signal.seq);
  const base = {
    kind: 'SIGNAL_CLOSED',
    url: urlOf(signal.id),
    ttlSec: RESULT_TTL_SEC,
    urgency: 'normal',
    tag: signalEventKey(signal.id, 'closed'),
  } as const;
  if (outcome.result === 'DATA_INVALID') {
    return {
      ...base,
      title: `${RESULT_TITLE.DATA_INVALID} ${tag}`,
      body: 'Feed gap during the trade: not counted. Manage it manually if you are still in.',
    };
  }
  if (outcome.realizedRNet === null || outcome.exitPrice === null) {
    throw new RangeError(`a ${outcome.result} outcome needs its net R and its exit price`);
  }
  const w = WORDS.en;
  const at = clockText(outcome.closedAt, options.displayTz, signal.generatedAt);
  return {
    ...base,
    title: `${RESULT_TITLE[outcome.result]} ${tag} ${signedRText(outcome.realizedRNet)}`,
    body: `${w.exitName[outcome.exitReason](priceText(outcome.exitPrice))} at ${at}, ${spanText(outcome.durationS * 1000)}`,
  };
}

export function pushCancelled(data: CancelledData): PushMessage {
  const { signal } = data;
  return {
    kind: 'SIGNAL_CANCELLED',
    title: `CANCELLED ${signalTag(signal.seq)}`,
    body: 'Market data went stale before the entry. Not counted. Manage it manually if you entered.',
    url: urlOf(signal.id),
    ttlSec: RESULT_TTL_SEC,
    urgency: 'normal',
    tag: signalEventKey(signal.id, 'closed'),
  };
}

export function pushFinalReview(data: FinalReviewData): PushMessage {
  const { signal, review } = data;
  return {
    kind: 'SIGNAL_REVIEW_FINAL',
    title: `FINAL REVIEW ${signalTag(signal.seq)}`,
    body: `Cause: ${causeText(review.primaryCause, WORDS.en)}`,
    url: urlOf(signal.id),
    ttlSec: RESULT_TTL_SEC,
    urgency: 'normal',
    tag: signalEventKey(signal.id, 'review'),
  };
}
