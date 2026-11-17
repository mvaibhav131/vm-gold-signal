import type { NotificationKind, OutboxChannel, OutboxRow } from '@vmgs/core';
import { describe, expect, it } from 'vitest';

import type {
  OutboxEntry,
  OutboxStore,
  PushSubscriptionRecord,
  PushSubscriptionStore,
} from './store';

/** What the contract tests need besides the store: a way to look at a row and to add a subscription. */
export interface OutboxHarness {
  readonly store: OutboxStore & PushSubscriptionStore;
  readonly entry: (eventKey: string, channel: OutboxChannel) => Promise<OutboxEntry | undefined>;
  readonly addSubscription: (record: PushSubscriptionRecord) => Promise<void>;
  readonly lastOk: (endpoint: string) => Promise<number | null>;
}

let counter = 0;
const unique = (name: string): string => {
  counter += 1;
  return `${name}-${String(counter)}-${String(Date.now())}`;
};

export const T = Date.UTC(2026, 9, 23, 6, 10, 0);
const SECOND = 1000;
const HOUR = 3_600_000;

export function outboxRow(kind: NotificationKind, change: Partial<OutboxRow> = {}): OutboxRow {
  return {
    eventKey: unique(`test:${kind}`),
    channel: 'telegram',
    kind,
    signalId: null,
    payload: { text: `a ${kind} message` },
    expiresAt: T + HOUR,
    ...change,
  };
}

/**
 * The behaviour that every `OutboxStore` must have, run against the in-memory store (unit tests)
 * and the PostgreSQL one (integration tests).
 */
export function outboxStoreContract(
  name: string,
  makeHarness: () => Promise<{ harness: OutboxHarness; done: () => Promise<void> }>,
): void {
  async function withStore(test: (harness: OutboxHarness) => Promise<void>): Promise<void> {
    const { harness, done } = await makeHarness();
    try {
      await test(harness);
    } finally {
      await done();
    }
  }

  async function drain(
    harness: OutboxHarness,
    channel: OutboxChannel,
    now: number,
  ): Promise<OutboxEntry[]> {
    const claimed: OutboxEntry[] = [];
    for (;;) {
      const next = await harness.store.claimNext(channel, now);
      if (next === null) return claimed;
      claimed.push(next);
    }
  }

  describe(`${name}: the outbox store contract`, () => {
    it('writes a message once for each event key and channel', async () => {
      await withStore(async ({ store, entry }) => {
        const first = outboxRow('SIGNAL_NEW');
        expect(await store.enqueue([first], T)).toBe(1);
        expect(await store.enqueue([first], T + SECOND)).toBe(0);
        const otherChannel = { ...first, channel: 'webpush' as const, payload: { title: 't' } };
        expect(await store.enqueue([otherChannel, first], T)).toBe(1);
        const stored = await entry(first.eventKey, 'telegram');
        expect(stored).toMatchObject({
          kind: 'SIGNAL_NEW',
          status: 'PENDING',
          attempts: 0,
          nextAttemptAt: T,
          expiresAt: T + HOUR,
          createdAt: T,
          sentAt: null,
          providerMessageId: null,
          lastError: null,
          signalId: null,
          payload: { text: 'a SIGNAL_NEW message' },
        });
        expect((await entry(first.eventKey, 'webpush'))?.payload).toEqual({ title: 't' });
        expect(await store.enqueue([], T)).toBe(0);
      });
    });

    it('takes the most important message first, then the oldest, one channel at a time', async () => {
      await withStore(async ({ store, entry }) => {
        const review = outboxRow('SIGNAL_REVIEW_FINAL');
        const closed = outboxRow('SIGNAL_CLOSED');
        const news = outboxRow('SIGNAL_NEW');
        const test = outboxRow('TEST');
        const cancelled = outboxRow('SIGNAL_CANCELLED');
        const webpush = outboxRow('SIGNAL_NEW', { channel: 'webpush' });
        await store.enqueue([review], T);
        await store.enqueue([closed], T + SECOND);
        await store.enqueue([test, cancelled], T + 2 * SECOND);
        await store.enqueue([news, webpush], T + 3 * SECOND);

        const claimed = await drain({ store, entry } as OutboxHarness, 'telegram', T + 10 * SECOND);
        expect(claimed.map((item) => item.eventKey)).toEqual([
          news.eventKey,
          closed.eventKey,
          cancelled.eventKey,
          review.eventKey,
          test.eventKey,
        ]);
        const web = await store.claimNext('webpush', T + 10 * SECOND);
        expect(web?.eventKey).toBe(webpush.eventKey);
        expect(await store.claimNext('webpush', T + 10 * SECOND)).toBeNull();
      });
    });

    it('takes only the kinds of a lane, still most important first', async () => {
      await withStore(async ({ store }) => {
        const signal = outboxRow('SIGNAL_NEW');
        const result = outboxRow('SIGNAL_CLOSED');
        const degraded = outboxRow('SYSTEM_DEGRADED');
        const move = outboxRow('MARKET_MOVE');
        await store.enqueue([degraded], T);
        await store.enqueue([move, result, signal], T + SECOND);
        const signals = { only: ['SIGNAL_NEW', 'SIGNAL_CLOSED'] } as const;
        const rest = { except: ['SIGNAL_NEW', 'SIGNAL_CLOSED'] } as const;
        const now = T + 2 * SECOND;

        expect((await store.claimNext('telegram', now, signals))?.eventKey).toBe(signal.eventKey);
        // the rest: the oldest of the same importance first
        expect((await store.claimNext('telegram', now, rest))?.eventKey).toBe(degraded.eventKey);
        expect((await store.claimNext('telegram', now, signals))?.eventKey).toBe(result.eventKey);
        expect(await store.claimNext('telegram', now, signals)).toBeNull();
        expect((await store.claimNext('telegram', now, rest))?.eventKey).toBe(move.eventKey);
        expect(await store.claimNext('telegram', now, rest)).toBeNull();
      });
    });

    it('a claimed message is SENDING with one more attempt, and nobody gets it twice', async () => {
      await withStore(async (harness) => {
        const message = outboxRow('SIGNAL_NEW');
        await harness.store.enqueue([message], T);
        const claimed = await harness.store.claimNext('telegram', T + SECOND);
        expect(claimed).toMatchObject({
          eventKey: message.eventKey,
          status: 'SENDING',
          attempts: 1,
        });
        expect(await harness.store.claimNext('telegram', T + 2 * SECOND)).toBeNull();
        const stored = await harness.entry(message.eventKey, 'telegram');
        expect(stored).toMatchObject({ status: 'SENDING', attempts: 1, nextAttemptAt: T + SECOND });
      });
    });

    it('two senders at once never take the same message', async () => {
      await withStore(async (harness) => {
        const rows = Array.from({ length: 6 }, () => outboxRow('SIGNAL_CLOSED'));
        await harness.store.enqueue(rows, T);
        const results = await Promise.all(
          Array.from({ length: 10 }, () => harness.store.claimNext('telegram', T + SECOND)),
        );
        const keys = results.flatMap((item) => (item === null ? [] : [item.eventKey]));
        expect(new Set(keys).size).toBe(keys.length);
        expect(
          keys.filter((key) => rows.some((row) => row.eventKey === key)).length,
        ).toBeGreaterThanOrEqual(6);
      });
    });

    it('does not take a message before it is due or after it expired', async () => {
      await withStore(async (harness) => {
        const later = outboxRow('SIGNAL_CLOSED');
        const short = outboxRow('SIGNAL_NEW', { expiresAt: T + 3 * 60 * SECOND });
        await harness.store.enqueue([later, short], T);
        // a failed message waits for its next attempt
        const first = await harness.store.claimNext('telegram', T);
        expect(first?.eventKey).toBe(short.eventKey);
        await harness.store.markFailed(first?.id ?? '', T + 30 * SECOND, 'timeout');
        expect((await harness.store.claimNext('telegram', T + 10 * SECOND))?.eventKey).toBe(
          later.eventKey,
        );
        expect(await harness.store.claimNext('telegram', T + 29 * SECOND)).toBeNull();
        expect((await harness.store.claimNext('telegram', T + 30 * SECOND))?.eventKey).toBe(
          short.eventKey,
        );
        // and one past its expiry is never taken
        const stale = outboxRow('SIGNAL_NEW', { expiresAt: T + 5 * SECOND });
        await harness.store.enqueue([stale], T);
        expect(await harness.store.claimNext('telegram', T + 5 * SECOND)).toBeNull();
        expect(await harness.store.claimNext('telegram', T + 6 * SECOND)).toBeNull();
      });
    });

    it('records a result: sent, failed with its next attempt, dead, expired', async () => {
      await withStore(async (harness) => {
        const rows = [
          outboxRow('SIGNAL_NEW'),
          outboxRow('SIGNAL_TP1'),
          outboxRow('SIGNAL_CLOSED'),
          outboxRow('TEST'),
        ];
        await harness.store.enqueue(rows, T);
        const claimed = await drain(harness, 'telegram', T + SECOND);
        const byKey = new Map(claimed.map((item) => [item.eventKey, item]));
        const id = (index: number) => byKey.get(rows[index]?.eventKey ?? '')?.id ?? '';

        await harness.store.markSent(id(0), T + 2 * SECOND, '4711');
        await harness.store.markFailed(id(1), T + 9 * SECOND, 'HTTP 500');
        await harness.store.markDead(id(2), 'Bad Request: message is too long');
        await harness.store.markExpired(id(3), 'too late');

        const state = async (index: number) =>
          harness.entry(rows[index]?.eventKey ?? '', 'telegram');
        expect(await state(0)).toMatchObject({
          status: 'SENT',
          sentAt: T + 2 * SECOND,
          providerMessageId: '4711',
          attempts: 1,
        });
        expect(await state(1)).toMatchObject({
          status: 'FAILED',
          nextAttemptAt: T + 9 * SECOND,
          lastError: 'HTTP 500',
        });
        expect(await state(2)).toMatchObject({
          status: 'DEAD',
          lastError: 'Bad Request: message is too long',
        });
        expect(await state(3)).toMatchObject({ status: 'EXPIRED', lastError: 'too late' });

        // only the failed one comes back, when it is due, with one more attempt
        expect(await harness.store.claimNext('telegram', T + 8 * SECOND)).toBeNull();
        expect(await harness.store.claimNext('telegram', T + 9 * SECOND)).toMatchObject({
          eventKey: rows[1]?.eventKey,
          attempts: 2,
        });
      });
    });

    it('a sent message can have no provider id', async () => {
      await withStore(async (harness) => {
        const message = outboxRow('SIGNAL_NEW', { channel: 'webpush' });
        await harness.store.enqueue([message], T);
        const claimed = await harness.store.claimNext('webpush', T);
        await harness.store.markSent(claimed?.id ?? '', T + SECOND, null);
        expect(await harness.entry(message.eventKey, 'webpush')).toMatchObject({
          status: 'SENT',
          providerMessageId: null,
        });
      });
    });

    it('drops what cannot be sent in time as EXPIRED, and only what is still waiting', async () => {
      await withStore(async (harness) => {
        const failed = outboxRow('SIGNAL_TP1', { expiresAt: T + 20 * SECOND });
        const sent = outboxRow('TEST', { expiresAt: T + 5 * SECOND });
        const sending = outboxRow('TEST', { expiresAt: T + 5 * SECOND });
        await harness.store.enqueue([failed, sent, sending], T);
        const claimed = await drain(harness, 'telegram', T);
        const idOf = (row: OutboxRow) =>
          claimed.find((item) => item.eventKey === row.eventKey)?.id ?? '';
        await harness.store.markFailed(idOf(failed), T + 1_000_000, 'x');
        await harness.store.markSent(idOf(sent), T, null);
        const waiting = outboxRow('SIGNAL_NEW', { expiresAt: T + 10 * SECOND });
        const fine = outboxRow('SIGNAL_CLOSED', { expiresAt: T + HOUR });
        await harness.store.enqueue([waiting, fine], T);

        expect(await harness.store.expireOverdue(T + 15 * SECOND)).toBe(1);
        expect(await harness.store.expireOverdue(T + 15 * SECOND)).toBe(0);
        expect(await harness.store.expireOverdue(T + 25 * SECOND)).toBe(1);
        expect((await harness.entry(waiting.eventKey, 'telegram'))?.status).toBe('EXPIRED');
        expect((await harness.entry(failed.eventKey, 'telegram'))?.status).toBe('EXPIRED');
        expect((await harness.entry(fine.eventKey, 'telegram'))?.status).toBe('PENDING');
        expect((await harness.entry(sent.eventKey, 'telegram'))?.status).toBe('SENT');
        expect((await harness.entry(sending.eventKey, 'telegram'))?.status).toBe('SENDING');
        expect((await harness.entry(waiting.eventKey, 'telegram'))?.lastError).toMatch(/expired/);
        // an expired message is never taken
        expect((await harness.store.claimNext('telegram', T + 26 * SECOND))?.eventKey).toBe(
          fine.eventKey,
        );
      });
    });

    it('a message without an expiry lives an hour from when it was written', async () => {
      await withStore(async (harness) => {
        const message = outboxRow('TEST', { expiresAt: null });
        await harness.store.enqueue([message], T);
        expect(await harness.store.expireOverdue(T + HOUR - SECOND)).toBe(0);
        const claimed = await harness.store.claimNext('telegram', T + HOUR - SECOND);
        expect(claimed).not.toBeNull();
        await harness.store.markFailed(claimed?.id ?? '', T + HOUR - SECOND, 'x');
        expect(await harness.store.expireOverdue(T + HOUR)).toBe(1);
        expect((await harness.entry(message.eventKey, 'telegram'))?.status).toBe('EXPIRED');
        expect((await harness.entry(message.eventKey, 'telegram'))?.expiresAt).toBeNull();
      });
    });

    it('brings back a message whose sending was interrupted, once it is old enough', async () => {
      await withStore(async (harness) => {
        const message = outboxRow('SIGNAL_NEW');
        await harness.store.enqueue([message], T);
        await harness.store.claimNext('telegram', T + SECOND);
        expect(await harness.store.recoverStuck(T + 60 * SECOND, 120 * SECOND)).toBe(0);
        expect((await harness.entry(message.eventKey, 'telegram'))?.status).toBe('SENDING');
        // claimed at T + 1 s: exactly 120 s later it is not yet old enough
        expect(await harness.store.recoverStuck(T + 121 * SECOND, 120 * SECOND)).toBe(0);
        expect(await harness.store.recoverStuck(T + 200 * SECOND, 120 * SECOND)).toBe(1);
        expect(await harness.entry(message.eventKey, 'telegram')).toMatchObject({
          status: 'FAILED',
          nextAttemptAt: T + 200 * SECOND,
          attempts: 1,
          lastError: 'sending was interrupted',
        });
        expect(await harness.store.recoverStuck(T + 400 * SECOND, 120 * SECOND)).toBe(0);
        expect(await harness.store.claimNext('telegram', T + 200 * SECOND)).toMatchObject({
          attempts: 2,
        });
      });
    });

    it('keeps the push subscriptions: list, note a good delivery, remove one that is gone', async () => {
      await withStore(async (harness) => {
        const a = {
          endpoint: `https://push.example/${unique('a')}`,
          p256dh: 'key-a',
          auth: 'auth-a',
        };
        const b = {
          endpoint: `https://push.example/${unique('b')}`,
          p256dh: 'key-b',
          auth: 'auth-b',
        };
        await harness.addSubscription(a);
        await harness.addSubscription(b);
        const listed = await harness.store.list();
        expect(listed).toEqual(expect.arrayContaining([a, b]));
        expect(await harness.lastOk(a.endpoint)).toBeNull();
        await harness.store.touch(a.endpoint, T);
        expect(await harness.lastOk(a.endpoint)).toBe(T);
        expect(await harness.lastOk(b.endpoint)).toBeNull();
        await harness.store.remove(a.endpoint);
        const after = await harness.store.list();
        expect(after).toEqual(expect.arrayContaining([b]));
        expect(after.map((item) => item.endpoint)).not.toContain(a.endpoint);
        // touching or removing one that is not there is harmless
        await harness.store.touch(a.endpoint, T);
        await harness.store.remove(a.endpoint);
      });
    });
  });
}
