import {
  GRADES,
  type Grade,
  type Locale,
  type NewsImpact,
  type NotificationKind,
  type StrategyKey,
} from '../domain';
import {
  RESULT_TTL_SEC,
  pushCancelled,
  pushClosed,
  pushFinalReview,
  pushNewSignal,
  pushTp1,
  signalEventKey,
  type SignalMessageKind,
  type SignalStep,
} from '../messages/push';
import {
  renderFinalReview,
  renderSignalCancelled,
  renderSignalClosed,
  renderSignalTp1,
} from '../messages/results';
import { renderSignalNew } from '../messages/signalNew';
import type {
  CancelledData,
  ClosedData,
  DisplayOptions,
  FinalReviewData,
  NewSignalData,
  PushMessage,
  SignalRef,
  TelegramMessage,
  Tp1Data,
} from '../messages/types';

export const OUTBOX_CHANNELS = ['telegram', 'webpush'] as const;
export type OutboxChannel = (typeof OUTBOX_CHANNELS)[number];

/** The settings that decide who is told about a signal (`app_settings`, the shape of `settingsSchema`). */
export interface AlertSettings {
  readonly displayTz: string;
  readonly locale: Locale;
  readonly alerts: {
    readonly telegram: {
      readonly enabled: boolean;
      readonly minGrade: Grade;
      readonly kinds: readonly NotificationKind[];
    };
    readonly webpush: { readonly enabled: boolean; readonly minGrade: Grade };
  };
  /** A strategy that is off runs in shadow mode: its signals are stored and followed, nobody is told. */
  readonly strategyAlerts: Readonly<Record<StrategyKey, 'on' | 'off'>>;
  /** The news alerts: the least impact that is told (calendar events and headlines). */
  readonly newsAlerts: { readonly minImpact: NewsImpact };
}

export function displayOptionsOf(settings: AlertSettings): DisplayOptions {
  return { locale: settings.locale, displayTz: settings.displayTz };
}

export const gradeAtLeast = (grade: Grade, minimum: Grade): boolean =>
  GRADES.indexOf(grade) >= GRADES.indexOf(minimum);

/**
 * The channels that get the entry alert of a new signal: none for a strategy in shadow mode, else
 * every enabled channel whose minimum grade the signal reaches (Telegram also by message kind).
 */
export function newSignalChannels(
  settings: AlertSettings,
  strategyKey: StrategyKey,
  grade: Grade,
): OutboxChannel[] {
  if (settings.strategyAlerts[strategyKey] !== 'on') return [];
  const { telegram, webpush } = settings.alerts;
  const channels: OutboxChannel[] = [];
  if (
    telegram.enabled &&
    telegram.kinds.includes('SIGNAL_NEW') &&
    gradeAtLeast(grade, telegram.minGrade)
  ) {
    channels.push('telegram');
  }
  if (webpush.enabled && gradeAtLeast(grade, webpush.minGrade)) channels.push('webpush');
  return channels;
}

/**
 * The channels that get a later message about a signal (TP1, closed, cancelled, final review): only
 * where the owner was told about the entry, and only what the settings still allow. Whoever never
 * saw the signal does not get its result.
 */
export function followUpChannels(
  settings: AlertSettings,
  kind: SignalMessageKind,
  told: readonly OutboxChannel[],
): OutboxChannel[] {
  const { telegram, webpush } = settings.alerts;
  return OUTBOX_CHANNELS.filter((channel) => {
    if (!told.includes(channel)) return false;
    return channel === 'telegram'
      ? telegram.enabled && telegram.kinds.includes(kind)
      : webpush.enabled;
  });
}

/** A message about a signal, with the data it is written from. */
export type SignalMessage =
  | { readonly kind: 'SIGNAL_NEW'; readonly data: NewSignalData }
  | { readonly kind: 'SIGNAL_TP1'; readonly data: Tp1Data }
  | { readonly kind: 'SIGNAL_CLOSED'; readonly data: ClosedData }
  | { readonly kind: 'SIGNAL_CANCELLED'; readonly data: CancelledData }
  | { readonly kind: 'SIGNAL_REVIEW_FINAL'; readonly data: FinalReviewData };

/** A row of `notification_outbox`, before the database gives it an id: `UNIQUE(event_key, channel)` makes a repeat harmless. */
export interface OutboxRow {
  readonly eventKey: string;
  readonly channel: OutboxChannel;
  readonly kind: NotificationKind;
  /** The signal the message is about; null for a message that is not about one (system, news, test). */
  readonly signalId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  /** A message later than this is dropped, not sent (04 "Delivery rules"); null for none (the store gives it an hour). */
  readonly expiresAt: number | null;
}

const STEP: Record<SignalMessageKind, SignalStep> = {
  SIGNAL_NEW: 'confirmed',
  SIGNAL_TP1: 'tp1',
  SIGNAL_CLOSED: 'closed',
  SIGNAL_CANCELLED: 'closed',
  SIGNAL_REVIEW_FINAL: 'review',
};

function signalOf(message: SignalMessage): SignalRef {
  return message.data.signal;
}

function telegramOf(message: SignalMessage, options: DisplayOptions): TelegramMessage {
  switch (message.kind) {
    case 'SIGNAL_NEW':
      return renderSignalNew(message.data, options);
    case 'SIGNAL_TP1':
      return renderSignalTp1(message.data, options);
    case 'SIGNAL_CLOSED':
      return renderSignalClosed(message.data, options);
    case 'SIGNAL_CANCELLED':
      return renderSignalCancelled(message.data, options);
    case 'SIGNAL_REVIEW_FINAL':
      return renderFinalReview(message.data, options);
  }
}

function pushOf(message: SignalMessage, options: DisplayOptions): PushMessage {
  switch (message.kind) {
    case 'SIGNAL_NEW':
      return pushNewSignal(message.data);
    case 'SIGNAL_TP1':
      return pushTp1(message.data, options);
    case 'SIGNAL_CLOSED':
      return pushClosed(message.data, options);
    case 'SIGNAL_CANCELLED':
      return pushCancelled(message.data);
    case 'SIGNAL_REVIEW_FINAL':
      return pushFinalReview(message.data);
  }
}

/** When a message about a signal stops being worth sending: an entry alert at the end of the entry validity, the others 6 hours after `now`. */
export function expiresAtOf(message: SignalMessage, now: number): number {
  return message.kind === 'SIGNAL_NEW'
    ? signalOf(message).entryValidUntil
    : now + RESULT_TTL_SEC * 1000;
}

/**
 * The outbox rows of a message about a signal, one for each channel. The text is written now, in
 * the language and the time zone of the settings of this moment, so that the sender only has to
 * deliver it (04 "Delivery rules": the row is written in the same transaction as the event).
 */
export function signalOutboxRows(
  message: SignalMessage,
  options: DisplayOptions,
  channels: readonly OutboxChannel[],
  now: number,
): OutboxRow[] {
  const signal = signalOf(message);
  const eventKey = signalEventKey(signal.id, STEP[message.kind]);
  const expiresAt = expiresAtOf(message, now);
  return OUTBOX_CHANNELS.filter((channel) => channels.includes(channel)).map((channel) => {
    if (channel === 'telegram') {
      const { text, level, dropped } = telegramOf(message, options);
      return {
        eventKey,
        channel,
        kind: message.kind,
        signalId: signal.id,
        payload: { text, level, dropped: [...dropped] },
        expiresAt,
      };
    }
    const { title, body, url, ttlSec, urgency, tag } = pushOf(message, options);
    return {
      eventKey,
      channel,
      kind: message.kind,
      signalId: signal.id,
      payload: { title, body, url, ttlSec, urgency, tag },
      expiresAt,
    };
  });
}
