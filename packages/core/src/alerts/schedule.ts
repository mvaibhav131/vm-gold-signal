import type { NotificationKind } from '../domain';

// How the outbox sender treats a message (04_API_and_Notifications section 4, "Delivery rules"):
// which message goes first, when a failed one is tried again, and when it is given up.

/** Waits after the first, second, ... failed attempt; later attempts wait `RETRY_CAP_MS`. */
export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 45_000, 120_000] as const;
export const RETRY_CAP_MS = 300_000;

/** How long a message without an `expires_at` may wait: the lifetime of a system message (04). */
export const NO_EXPIRY_MS = 3_600_000;

/** The wait before attempt `attempts + 1`, once `attempts` attempts (at least 1) have failed. */
export function retryDelayMs(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError('attempts is the number of attempts made, at least 1');
  }
  return RETRY_DELAYS_MS[attempts - 1] ?? RETRY_CAP_MS;
}

/** The time after which a message is dropped as expired. */
export function expiryOf(expiresAt: number | null, createdAt: number): number {
  return expiresAt ?? createdAt + NO_EXPIRY_MS;
}

/** 0 goes first. SIGNAL_NEW, then the results of a signal (TP1, closed, cancelled), then everything else. */
export type Priority = 0 | 1 | 2;

const PRIORITY: Readonly<Partial<Record<NotificationKind, Priority>>> = {
  SIGNAL_NEW: 0,
  SIGNAL_TP1: 1,
  SIGNAL_CLOSED: 1,
  SIGNAL_CANCELLED: 1,
};

export const priorityOf = (kind: NotificationKind): Priority => PRIORITY[kind] ?? 2;

/** Why a send did not work. A permanent failure is never retried: the message itself is refused. */
export interface SendFailure {
  readonly type: 'permanent' | 'transient' | 'rate_limited';
  readonly message: string;
  /** The wait the service asked for (Telegram `retry_after`). */
  readonly retryAfterMs?: number;
}

export type AfterFailure =
  | { readonly status: 'FAILED'; readonly nextAttemptAt: number }
  | { readonly status: 'EXPIRED' }
  | { readonly status: 'DEAD' };

/**
 * What to do with a message whose attempt number `attempts` just failed at `now`: give up on a
 * refused message (DEAD), try again after the backoff or the wait the service asked for, whichever
 * is longer, or drop it as EXPIRED when the next attempt could only come after `expiresAt`.
 */
export function afterFailure(input: {
  readonly attempts: number;
  readonly now: number;
  readonly expiresAt: number;
  readonly failure: SendFailure;
}): AfterFailure {
  const { attempts, now, expiresAt, failure } = input;
  if (failure.type === 'permanent') return { status: 'DEAD' };
  if (now >= expiresAt) return { status: 'EXPIRED' };
  const wait = Math.max(retryDelayMs(attempts), failure.retryAfterMs ?? 0);
  const nextAttemptAt = now + wait;
  if (nextAttemptAt >= expiresAt) return { status: 'EXPIRED' };
  return { status: 'FAILED', nextAttemptAt };
}
