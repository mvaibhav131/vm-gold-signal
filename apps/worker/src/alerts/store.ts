import type { NotificationKind, OutboxChannel, OutboxRow } from '@vmgs/core';

/** The states of a message in `notification_outbox` (03_Data_Model: `notification_outbox.status`). */
export type OutboxStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'DEAD' | 'EXPIRED';

/** A row of the outbox as the sender sees it (times in epoch milliseconds). */
export interface OutboxEntry {
  readonly id: string;
  readonly eventKey: string;
  readonly channel: OutboxChannel;
  readonly kind: NotificationKind;
  readonly signalId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly status: OutboxStatus;
  /** How many attempts have been started, this one included while it is SENDING. */
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly expiresAt: number | null;
  readonly createdAt: number;
  readonly sentAt: number | null;
  readonly providerMessageId: string | null;
  readonly lastError: string | null;
}

/**
 * Which kinds a claim may take: only the listed ones, or everything except them. It is how the signal bot and the alert
 * bot each take their own messages from the one outbox.
 */
export type OutboxLane =
  { readonly only: readonly NotificationKind[] } | { readonly except: readonly NotificationKind[] };

/** Whether a message of `kind` belongs to the lane (no lane: all of them). */
export function inLane(kind: NotificationKind, lane: OutboxLane | undefined): boolean {
  if (lane === undefined) return true;
  return 'only' in lane ? lane.only.includes(kind) : !lane.except.includes(kind);
}

/**
 * The outbox as the sender uses it. Every write of a state is one statement, so a crash leaves a
 * row in a state that `recoverStuck` and the retry rules can read: SENDING means "claimed at
 * `nextAttemptAt`, no result yet".
 */
export interface OutboxStore {
  /** Writes rows that are not there yet (`UNIQUE(event_key, channel)`); returns how many were new. */
  enqueue(rows: readonly OutboxRow[], now: number): Promise<number>;
  /** PENDING and FAILED rows that can no longer be sent in time become EXPIRED; returns how many. */
  expireOverdue(now: number): Promise<number>;
  /**
   * Takes the next message of a channel that is due and not expired, most important first (SIGNAL_NEW,
   * then results, then the rest), oldest first within that. It becomes SENDING with one more attempt.
   * Two callers never get the same row. With a `lane` only the messages of those kinds are taken.
   */
  claimNext(channel: OutboxChannel, now: number, lane?: OutboxLane): Promise<OutboxEntry | null>;
  markSent(id: string, at: number, providerMessageId: string | null): Promise<void>;
  markFailed(id: string, nextAttemptAt: number, error: string): Promise<void>;
  markDead(id: string, error: string): Promise<void>;
  markExpired(id: string, error: string): Promise<void>;
  /** SENDING rows claimed before `now - olderThanMs` (the process died) become FAILED, due now. */
  recoverStuck(now: number, olderThanMs: number): Promise<number>;
}

export interface PushSubscriptionRecord {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

/** The browsers that asked for Web Push (`push_subscriptions`). The API writes them; the worker only reads and prunes. */
export interface PushSubscriptionStore {
  list(): Promise<PushSubscriptionRecord[]>;
  /** A subscription the push service says is gone (404, 410). */
  remove(endpoint: string): Promise<void>;
  touch(endpoint: string, at: number): Promise<void>;
}
