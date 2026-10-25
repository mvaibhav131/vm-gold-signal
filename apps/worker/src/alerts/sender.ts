import { afterFailure, expiryOf, type SendFailure } from '@vmgs/core';

import { classifyTelegramError } from '../telegram/client';
import type { TelegramTransport } from '../telegram/transport';
import type { OutboxEntry, OutboxStore, PushSubscriptionStore } from './store';
import type { PushPayload, WebPushSink } from './webpush';

export interface SenderStats {
  readonly sent: number;
  readonly retried: number;
  readonly dead: number;
  readonly expired: number;
  readonly recovered: number;
  readonly errors: number;
}

export interface OutboxSenderOptions {
  readonly store: OutboxStore;
  /** Telegram; `chatId` is the linked chat, null while nothing is linked. Without it Telegram rows wait. */
  readonly telegram?: {
    readonly transport: TelegramTransport;
    readonly chatId: () => Promise<number | string | null>;
  };
  /** Web Push; without it Web Push rows wait. */
  readonly webpush?: { readonly sink: WebPushSink; readonly subscriptions: PushSubscriptionStore };
  readonly now?: () => number;
  /** How long the loop sleeps when there is nothing to do. */
  readonly pollMs?: number;
  /** A SENDING row older than this is taken to be left by a process that died. */
  readonly sendingTimeoutMs?: number;
  /** How often rows left SENDING are looked for. */
  readonly recoverEveryMs?: number;
  /** The most Web Push messages in one pass. */
  readonly webpushBatch?: number;
  readonly log?: (
    level: 'info' | 'error',
    message: string,
    details?: Record<string, unknown>,
  ) => void;
}

const ERROR_LIMIT = 500;
const clip = (text: string): string =>
  text.length > ERROR_LIMIT ? `${text.slice(0, ERROR_LIMIT)}...` : text;

const URGENCIES = ['very-low', 'low', 'normal', 'high'] as const;

/** Reads the payload of a Web Push row; null when it is not what the builders write. */
function pushPayloadOf(payload: Readonly<Record<string, unknown>>): PushPayload | null {
  const { title, body, url, tag, ttlSec, urgency } = payload;
  const known = URGENCIES.find((candidate) => candidate === urgency);
  if (
    typeof title !== 'string' ||
    typeof body !== 'string' ||
    typeof url !== 'string' ||
    typeof tag !== 'string' ||
    typeof ttlSec !== 'number' ||
    known === undefined
  ) {
    return null;
  }
  return { title, body, url, tag, ttlSec, urgency: known };
}

/**
 * The outbox sender (01_HLD section 4.2): it runs on its own loop, so a slow Telegram call never
 * delays signal evaluation, and sends what the lifecycle wrote into `notification_outbox`.
 *
 * - **Order and rate.** Most important first (the entry alert, then results, then the rest), at most
 *   one Telegram message per second (the transport), Web Push without that limit.
 * - **Retry.** A failed message is tried again after 2 s, 5 s, 15 s, 45 s, 2 min, then every 5 min,
 *   or after the `retry_after` Telegram asks for; a refused message (400) is dead; a message that
 *   could only be retried after its expiry is dropped as EXPIRED. A late entry alert is harmful, so
 *   an expired message is never sent.
 * - **Crash.** A row left SENDING by a process that died is retried (at-least-once: if the message
 *   had gone out just before the crash, the owner may see it twice, never zero times).
 * - **The database.** A failure of the database stops nothing: the loop logs it and tries again.
 */
export class OutboxSender {
  private readonly store: OutboxStore;
  private readonly telegram: OutboxSenderOptions['telegram'];
  private readonly webpush: OutboxSenderOptions['webpush'];
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly sendingTimeoutMs: number;
  private readonly recoverEveryMs: number;
  private readonly webpushBatch: number;
  private readonly log: NonNullable<OutboxSenderOptions['log']>;
  private lastRecoverAt = Number.NEGATIVE_INFINITY;
  private counters = { sent: 0, retried: 0, dead: 0, expired: 0, recovered: 0, errors: 0 };
  private running = false;
  private loop: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;
  private pendingWake = false;

  constructor(options: OutboxSenderOptions) {
    this.store = options.store;
    this.telegram = options.telegram;
    this.webpush = options.webpush;
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? 500;
    this.sendingTimeoutMs = options.sendingTimeoutMs ?? 120_000;
    this.recoverEveryMs = options.recoverEveryMs ?? 60_000;
    this.webpushBatch = options.webpushBatch ?? 20;
    this.log = options.log ?? (() => undefined);
    for (const [name, value] of [
      ['pollMs', this.pollMs],
      ['sendingTimeoutMs', this.sendingTimeoutMs],
      ['recoverEveryMs', this.recoverEveryMs],
      ['webpushBatch', this.webpushBatch],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0)
        throw new RangeError(`${name} must be a positive integer`);
    }
  }

  get stats(): SenderStats {
    return { ...this.counters };
  }

  /** One pass: bring back what a dead process left, drop what is too late, send what is due. Returns how many messages it handled. */
  async runOnce(): Promise<number> {
    const start = this.now();
    if (start - this.lastRecoverAt >= this.recoverEveryMs) {
      this.lastRecoverAt = start;
      const recovered = await this.store.recoverStuck(start, this.sendingTimeoutMs);
      this.counters.recovered += recovered;
      if (recovered > 0)
        this.log('info', 'messages left sending were taken back', { count: recovered });
    }
    this.counters.expired += await this.store.expireOverdue(start);

    let handled = 0;
    const telegram = this.telegram;
    if (telegram !== undefined) {
      while (telegram.transport.waitMs() === 0) {
        const row = await this.store.claimNext('telegram', this.now());
        if (row === null) break;
        await this.sendTelegram(row, telegram);
        handled += 1;
      }
    }
    const webpush = this.webpush;
    if (webpush !== undefined) {
      for (let i = 0; i < this.webpushBatch; i += 1) {
        const row = await this.store.claimNext('webpush', this.now());
        if (row === null) break;
        await this.sendWebPush(row, webpush);
        handled += 1;
      }
    }
    return handled;
  }

  /** Starts the loop (idempotent). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.pendingWake = false;
    this.loop = this.run();
  }

  /** Stops the loop and waits for the pass in hand. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake();
    await this.loop;
    this.loop = null;
  }

  /** Cuts the sleep short: something was written to the outbox. A wake during a pass is kept for the next sleep. */
  wake(): void {
    if (this.wakeUp === null) this.pendingWake = true;
    else this.wakeUp();
  }

  private async run(): Promise<void> {
    while (this.running) {
      let wait = this.pollMs;
      try {
        const handled = await this.runOnce();
        if (handled > 0) {
          const gate = this.telegram?.transport.waitMs() ?? 0;
          wait = Math.min(this.pollMs, gate);
        }
      } catch (error) {
        this.counters.errors += 1;
        this.log('error', 'the outbox sender could not finish a pass', {
          error: error instanceof Error ? error.message : String(error),
        });
        wait = Math.max(this.pollMs, 2_000);
      }
      if (wait > 0) await this.sleep(wait);
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.pendingWake) {
      this.pendingWake = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.wakeUp = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wakeUp = finish;
    });
  }

  private async sendTelegram(
    row: OutboxEntry,
    telegram: NonNullable<OutboxSenderOptions['telegram']>,
  ): Promise<void> {
    const text = row.payload.text;
    if (typeof text !== 'string' || text === '') {
      await this.settle(row, { type: 'permanent', message: 'the message has no text' });
      return;
    }
    let chatId: number | string | null;
    try {
      chatId = await telegram.chatId();
    } catch (error) {
      await this.settle(row, {
        type: 'transient',
        message: `the linked chat could not be read: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (chatId === null) {
      await this.settle(row, {
        type: 'transient',
        message: 'Telegram is not linked to a chat yet',
      });
      return;
    }
    let messageId: number;
    try {
      ({ messageId } = await telegram.transport.send(chatId, text));
    } catch (error) {
      await this.settle(row, classifyTelegramError(error));
      return;
    }
    await this.store.markSent(row.id, this.now(), String(messageId));
    this.counters.sent += 1;
  }

  private async sendWebPush(
    row: OutboxEntry,
    webpush: NonNullable<OutboxSenderOptions['webpush']>,
  ): Promise<void> {
    const payload = pushPayloadOf(row.payload);
    if (payload === null) {
      await this.settle(row, { type: 'permanent', message: 'the push message is not complete' });
      return;
    }
    const now = this.now();
    const remainingSec = Math.floor((expiryOf(row.expiresAt, row.createdAt) - now) / 1000);
    const ttlSec = Math.min(payload.ttlSec, remainingSec);
    if (ttlSec < 1) {
      await this.store.markExpired(row.id, 'expired before it could be sent');
      this.counters.expired += 1;
      return;
    }
    const subscriptions = await webpush.subscriptions.list();
    if (subscriptions.length === 0) {
      await this.settle(row, {
        type: 'transient',
        message: 'no browser is subscribed to Web Push',
      });
      return;
    }
    const results = await Promise.all(
      subscriptions.map(async (subscription) => ({
        subscription,
        result: await webpush.sink.send(subscription, payload, ttlSec),
      })),
    );
    let delivered = 0;
    let permanent: string | null = null;
    let transient: string | null = null;
    let gone = 0;
    for (const { subscription, result } of results) {
      if (result.ok) {
        delivered += 1;
        await webpush.subscriptions.touch(subscription.endpoint, this.now());
      } else if (result.gone) {
        gone += 1;
        await webpush.subscriptions.remove(subscription.endpoint);
      } else if (result.permanent) {
        permanent ??= result.message;
      } else {
        transient ??= result.message;
      }
    }
    if (delivered > 0) {
      // sent when at least one browser took it: a row has no per-browser state
      await this.store.markSent(row.id, this.now(), null);
      this.counters.sent += 1;
    } else if (transient !== null) {
      await this.settle(row, { type: 'transient', message: transient });
    } else if (permanent !== null) {
      await this.settle(row, { type: 'permanent', message: permanent });
    } else {
      await this.settle(row, {
        type: 'transient',
        message: `every Web Push subscription was gone (${String(gone)} removed)`,
      });
    }
  }

  private async settle(row: OutboxEntry, failure: SendFailure): Promise<void> {
    const now = this.now();
    const decision = afterFailure({
      attempts: row.attempts,
      now,
      expiresAt: expiryOf(row.expiresAt, row.createdAt),
      failure,
    });
    const message = clip(failure.message);
    if (decision.status === 'DEAD') {
      await this.store.markDead(row.id, message);
      this.counters.dead += 1;
      this.log('error', 'a message was refused and is dead', {
        kind: row.kind,
        channel: row.channel,
        error: message,
      });
    } else if (decision.status === 'EXPIRED') {
      await this.store.markExpired(row.id, `${message} (expired before it could be sent)`);
      this.counters.expired += 1;
    } else {
      await this.store.markFailed(row.id, decision.nextAttemptAt, message);
      this.counters.retried += 1;
    }
  }
}
