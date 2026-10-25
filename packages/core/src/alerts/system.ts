import type { NotificationKind } from '../domain';
import { fitMessage } from '../messages/text';
import { bold } from '../messages/markup';
import { ICON } from '../messages/style';
import { clockText } from '../messages/time';
import type { DisplayOptions, TelegramMessage } from '../messages/types';
import { fixedText, spanText } from '../explain/format';
import { signalTag } from '../messages/common';
import type { AlertSettings, OutboxChannel, OutboxRow } from '../lifecycle/alerts';
import { OUTBOX_CHANNELS } from '../lifecycle/alerts';
import { replyOf, type Reply } from './replies';
import { ALERT_WORDS } from './words';

// The messages that are not about one signal: the owner pausing the engine, the feed going down and
// coming back, the storage budget, and the test message (04_API_and_Notifications section 4.1).

/** System messages are worth sending for an hour (04, "Delivery rules"). */
export const SYSTEM_TTL_MS = 3_600_000;

/** A system message as it goes into the outbox: the Telegram text and the short Web Push form. */
export interface SystemMessage {
  readonly kind: NotificationKind;
  readonly telegram: TelegramMessage;
  readonly push: {
    readonly title: string;
    readonly body: string;
    readonly urgency: 'high' | 'normal';
    /** Where a click goes (the dashboard when not given). */
    readonly url?: string;
  };
}

/** Builds a message that is not about a signal from its lines (see `fitMessage`). */
export function systemMessage(
  kind: NotificationKind,
  lines: readonly string[],
  push: SystemMessage['push'],
): SystemMessage {
  return {
    kind,
    telegram: fitMessage(kind, () => ({ lines, dropped: [] }), 0),
    push,
  };
}

const system = systemMessage;

const at = (ms: number, options: DisplayOptions, reference?: number): string =>
  clockText(ms, options.displayTz, reference);

// ------------------------------------------------------------------------------- engine paused

export interface EnginePausedData {
  readonly at: number;
  /** When a timed pause ends; null until the owner resumes. */
  readonly until: number | null;
}

/** ENGINE_PAUSED: only when the owner pauses; the system never pauses itself. */
export function enginePausedMessage(
  data: EnginePausedData,
  options: DisplayOptions,
): SystemMessage {
  const w = ALERT_WORDS[options.locale];
  const lines = [`${ICON.paused} ${bold(w.enginePausedTitle(at(data.at, options)))}`, w.pausedBody];
  if (data.until !== null) {
    lines.push(
      w.pausedUntil(at(data.until, options, data.at), spanText(Math.max(0, data.until - data.at))),
    );
  }
  lines.push(w.resumeToContinue);
  return system('ENGINE_PAUSED', lines, {
    title: 'ENGINE PAUSED',
    body: 'New signals are not sent. Tracking continues.',
    urgency: 'normal',
  });
}

/** The reply to `/resume`. */
export function resumedReply(atMs: number, options: DisplayOptions): Reply {
  const w = ALERT_WORDS[options.locale];
  return replyOf([`${ICON.running} ${bold(w.engineResumed(at(atMs, options)))}`, w.resumedBody]);
}

export function alreadyPausedReply(since: number, options: DisplayOptions): Reply {
  return replyOf([ALERT_WORDS[options.locale].alreadyPaused(at(since, options))]);
}

export function notPausedReply(options: DisplayOptions): Reply {
  return replyOf([ALERT_WORDS[options.locale].notPaused]);
}

// ----------------------------------------------------------------------------------- the feed

export interface FeedDegradedData {
  readonly kind: 'STALE' | 'DISCONNECT';
  readonly since: number;
  /** How long no tick had come when the incident was reported; null when it is not known. */
  readonly silentMs: number | null;
  /** The numbers of the signals that are open and cannot be followed while the feed is down. */
  readonly openSeqs: readonly number[];
}

export function feedDegradedMessage(
  data: FeedDegradedData,
  options: DisplayOptions,
): SystemMessage {
  const w = ALERT_WORDS[options.locale];
  const sinceText = at(data.since, options);
  const title =
    data.kind === 'STALE' ? w.feedStaleTitle(sinceText) : w.feedDisconnectedTitle(sinceText);
  const first = `${ICON.feedDown} ${bold(title)}${data.silentMs === null ? '' : ` ${w.silentFor(spanText(data.silentMs))}`}`;
  const lines = [first, w.newSignalsBlocked];
  if (data.openSeqs.length > 0) {
    lines.push(w.openTradeNotTracked(data.openSeqs.map(signalTag).join(', ')));
  }
  return system('SYSTEM_DEGRADED', lines, {
    title: data.kind === 'STALE' ? 'FEED STALE' : 'FEED DISCONNECTED',
    body: `Since ${sinceText}. New signals are blocked.`,
    urgency: 'high',
  });
}

export interface FeedRecoveredData {
  readonly at: number;
  readonly downMs: number;
  /** When new signals are expected to resume; null when the engine cannot say yet. */
  readonly resumeAt: number | null;
}

export function feedRecoveredMessage(
  data: FeedRecoveredData,
  options: DisplayOptions,
): SystemMessage {
  const w = ALERT_WORDS[options.locale];
  const lines = [
    `${ICON.feedUp} ${bold(w.feedRecoveredTitle(at(data.at, options), spanText(data.downMs)))}`,
    data.resumeAt === null
      ? w.signalsResumeSoon
      : w.signalsResume(at(data.resumeAt, options, data.at)),
  ];
  return system('SYSTEM_RECOVERED', lines, {
    title: 'FEED RECOVERED',
    body: `At ${at(data.at, options)}, after ${spanText(data.downMs)}.`,
    urgency: 'normal',
  });
}

// ------------------------------------------------------------------------------------ storage

export interface StorageWarningData {
  readonly usedPercent: number;
  readonly budgetGb: number;
  readonly retentionDays: number;
  readonly largestTable: string;
  readonly largestGb: number;
}

export function storageWarningMessage(
  data: StorageWarningData,
  options: DisplayOptions,
): SystemMessage {
  const w = ALERT_WORDS[options.locale];
  const percent = `${String(Math.round(data.usedPercent))}%`;
  const lines = [
    `${ICON.storage} ${bold(w.storageTitle(percent, `${fixedText(data.budgetGb, 0)} GB`))}`,
    w.storageRetention(data.retentionDays),
    w.storageLargest(data.largestTable, `${fixedText(data.largestGb, 1)} GB`),
  ];
  return system('STORAGE_WARNING', lines, {
    title: `STORAGE ${percent}`,
    body: `Tick retention shortened to ${String(data.retentionDays)} days.`,
    urgency: 'normal',
  });
}

// --------------------------------------------------------------------------------------- test

/** TEST: the message of "Send test message" and of `pnpm cli telegram:test`. */
export function testMessage(atMs: number, options: DisplayOptions): SystemMessage {
  const w = ALERT_WORDS[options.locale];
  return system('TEST', [`${ICON.test} ${bold(w.testTitle(at(atMs, options)))}`, w.testBody], {
    title: 'TEST',
    body: 'Delivery works. Nothing here is a signal.',
    urgency: 'normal',
  });
}

// ------------------------------------------------------------------------ the outbox and event keys

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');

/** `health:STALE@1792735320000:degraded`: the incident is named by its kind and its start, which survive a restart. */
export function healthEventKey(
  kind: 'STALE' | 'DISCONNECT',
  startedAt: number,
  phase: 'degraded' | 'recovered',
): string {
  return `health:${kind}@${String(startedAt)}:${phase}`;
}

export const engineEventKey = (pauseId: string): string => `engine:${pauseId}:paused`;
export const storageEventKey = (ms: number): string => `storage:${day(ms)}:warning`;
export const testEventKey = (id: string): string => `test:${id}`;

/**
 * The channels that get a system message: Telegram when it is on and the kind is switched on,
 * Web Push when it is on. (Grade and strategy switches are about signals.)
 */
export function systemChannels(settings: AlertSettings, kind: NotificationKind): OutboxChannel[] {
  const { telegram, webpush } = settings.alerts;
  return OUTBOX_CHANNELS.filter((channel) =>
    channel === 'telegram' ? telegram.enabled && telegram.kinds.includes(kind) : webpush.enabled,
  );
}

/**
 * The outbox rows of a message that is not about a signal: one row for each channel, expiring
 * `lifetimeMs` after `now` (an hour for the system messages).
 */
export function systemOutboxRows(
  message: SystemMessage,
  eventKey: string,
  channels: readonly OutboxChannel[],
  now: number,
  lifetimeMs: number = SYSTEM_TTL_MS,
): OutboxRow[] {
  const expiresAt = now + lifetimeMs;
  return OUTBOX_CHANNELS.filter((channel) => channels.includes(channel)).map((channel) => ({
    eventKey,
    channel,
    kind: message.kind,
    signalId: null,
    payload:
      channel === 'telegram'
        ? {
            text: message.telegram.text,
            level: message.telegram.level,
            dropped: [...message.telegram.dropped],
          }
        : {
            title: message.push.title,
            body: message.push.body,
            url: message.push.url ?? '/',
            ttlSec: Math.max(1, Math.floor(lifetimeMs / 1000)),
            urgency: message.push.urgency,
            tag: eventKey,
          },
    expiresAt,
  }));
}
