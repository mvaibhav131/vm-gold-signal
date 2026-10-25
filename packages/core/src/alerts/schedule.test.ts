import { describe, expect, it } from 'vitest';

import { NOTIFICATION_KINDS } from '../domain';
import {
  NO_EXPIRY_MS,
  RETRY_CAP_MS,
  RETRY_DELAYS_MS,
  afterFailure,
  expiryOf,
  priorityOf,
  retryDelayMs,
} from './schedule';

describe('retryDelayMs: 2 s, 5 s, 15 s, 45 s, 2 min, then every 5 min', () => {
  it('follows the schedule of the delivery rules', () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([2_000, 5_000, 15_000, 45_000, 120_000]);
    expect(RETRY_DELAYS_MS).toEqual([2_000, 5_000, 15_000, 45_000, 120_000]);
    expect(retryDelayMs(6)).toBe(300_000);
    expect(retryDelayMs(40)).toBe(RETRY_CAP_MS);
  });

  it('is counted from the first failed attempt', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => retryDelayMs(bad)).toThrow(RangeError);
  });
});

describe('expiryOf', () => {
  it('is the expiry of the row, or one hour after it was written when it has none', () => {
    expect(expiryOf(5_000, 1_000)).toBe(5_000);
    expect(expiryOf(null, 1_000)).toBe(1_000 + NO_EXPIRY_MS);
    expect(NO_EXPIRY_MS).toBe(3_600_000);
    expect(expiryOf(0, 1_000)).toBe(0);
  });
});

describe('priorityOf: the entry alert, then the results, then the rest', () => {
  it('ranks every kind', () => {
    expect(priorityOf('SIGNAL_NEW')).toBe(0);
    for (const kind of ['SIGNAL_TP1', 'SIGNAL_CLOSED', 'SIGNAL_CANCELLED'] as const) {
      expect(priorityOf(kind), kind).toBe(1);
    }
    const rest = NOTIFICATION_KINDS.filter(
      (kind) => !['SIGNAL_NEW', 'SIGNAL_TP1', 'SIGNAL_CLOSED', 'SIGNAL_CANCELLED'].includes(kind),
    );
    expect(rest).toContain('SIGNAL_REVIEW_FINAL');
    expect(rest).toContain('TEST');
    for (const kind of rest) expect(priorityOf(kind), kind).toBe(2);
  });
});

describe('afterFailure', () => {
  const base = { attempts: 1, now: 10_000, expiresAt: 1_000_000 };
  const transient = { type: 'transient' as const, message: 'timeout' };

  it('gives up on a message that was refused', () => {
    expect(afterFailure({ ...base, failure: { type: 'permanent', message: 'bad' } })).toEqual({
      status: 'DEAD',
    });
    // even a message that is still valid, or already expired: refused is refused
    expect(
      afterFailure({ ...base, now: 2_000_000, failure: { type: 'permanent', message: 'bad' } }),
    ).toEqual({ status: 'DEAD' });
  });

  it('tries again after the backoff of the attempt', () => {
    for (const [attempts, wait] of [
      [1, 2_000],
      [2, 5_000],
      [3, 15_000],
      [4, 45_000],
      [5, 120_000],
      [6, 300_000],
      [9, 300_000],
    ] as const) {
      expect(afterFailure({ ...base, attempts, failure: transient })).toEqual({
        status: 'FAILED',
        nextAttemptAt: 10_000 + wait,
      });
    }
  });

  it('waits the longer of the backoff and what the service asked for', () => {
    const limited = (retryAfterMs: number) => ({
      type: 'rate_limited' as const,
      message: '429',
      retryAfterMs,
    });
    expect(afterFailure({ ...base, failure: limited(30_000) })).toEqual({
      status: 'FAILED',
      nextAttemptAt: 40_000,
    });
    expect(afterFailure({ ...base, attempts: 5, failure: limited(1_000) })).toEqual({
      status: 'FAILED',
      nextAttemptAt: 130_000,
    });
  });

  it('drops the message when the next attempt could only come at or after its expiry', () => {
    expect(afterFailure({ ...base, expiresAt: 12_001, failure: transient })).toEqual({
      status: 'FAILED',
      nextAttemptAt: 12_000,
    });
    expect(afterFailure({ ...base, expiresAt: 12_000, failure: transient })).toEqual({
      status: 'EXPIRED',
    });
    expect(afterFailure({ ...base, expiresAt: 10_000, failure: transient })).toEqual({
      status: 'EXPIRED',
    });
    expect(afterFailure({ ...base, expiresAt: 5_000, failure: transient })).toEqual({
      status: 'EXPIRED',
    });
  });

  it('a long wait asked for by the service can also run past the expiry', () => {
    expect(
      afterFailure({
        ...base,
        expiresAt: 60_000,
        failure: { type: 'rate_limited', message: '429', retryAfterMs: 90_000 },
      }),
    ).toEqual({ status: 'EXPIRED' });
  });
});
