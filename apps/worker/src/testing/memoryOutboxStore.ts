import { randomUUID } from 'node:crypto';

import { expiryOf, priorityOf, type OutboxChannel, type OutboxRow } from '@vmgs/core';

import type {
  OutboxEntry,
  OutboxStore,
  PushSubscriptionRecord,
  PushSubscriptionStore,
} from '../alerts/store';

type Mutable = { -readonly [K in keyof OutboxEntry]: OutboxEntry[K] };

/**
 * The outbox in memory, with the semantics of `PostgresOutboxStore`: one row for each event key and
 * channel, claiming by priority, SENDING recovery. Unit tests use it; one contract test file runs
 * the same expectations against both.
 */
export class MemoryOutboxStore implements OutboxStore, PushSubscriptionStore {
  private readonly rows: Mutable[] = [];
  private readonly subscriptions = new Map<
    string,
    PushSubscriptionRecord & { lastOkAt: number | null }
  >();
  /** Makes the next write of a result fail, to test what a sender does when the database is down. */
  failNextWrite = false;

  /** A copy of every row, oldest first. */
  entries(): OutboxEntry[] {
    return this.rows.map((row) => ({ ...row }));
  }

  entry(eventKey: string, channel: OutboxChannel): OutboxEntry | undefined {
    const found = this.rows.find((row) => row.eventKey === eventKey && row.channel === channel);
    return found === undefined ? undefined : { ...found };
  }

  enqueue(rows: readonly OutboxRow[], now: number): Promise<number> {
    let inserted = 0;
    for (const row of rows) {
      if (this.rows.some((item) => item.eventKey === row.eventKey && item.channel === row.channel))
        continue;
      this.rows.push({
        id: randomUUID(),
        eventKey: row.eventKey,
        channel: row.channel,
        kind: row.kind,
        signalId: row.signalId,
        payload: row.payload,
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: now,
        expiresAt: row.expiresAt,
        createdAt: now,
        sentAt: null,
        providerMessageId: null,
        lastError: null,
      });
      inserted += 1;
    }
    return Promise.resolve(inserted);
  }

  expireOverdue(now: number): Promise<number> {
    let count = 0;
    for (const row of this.rows) {
      if (
        (row.status === 'PENDING' || row.status === 'FAILED') &&
        expiryOf(row.expiresAt, row.createdAt) <= now
      ) {
        row.status = 'EXPIRED';
        row.lastError = row.lastError ?? 'expired before it could be sent';
        count += 1;
      }
    }
    return Promise.resolve(count);
  }

  claimNext(channel: OutboxChannel, now: number): Promise<OutboxEntry | null> {
    const due = this.rows
      .map((row, index) => ({ row, index }))
      .filter(
        ({ row }) =>
          row.channel === channel &&
          (row.status === 'PENDING' || row.status === 'FAILED') &&
          row.nextAttemptAt <= now &&
          expiryOf(row.expiresAt, row.createdAt) > now,
      )
      .sort(
        (a, b) =>
          priorityOf(a.row.kind) - priorityOf(b.row.kind) ||
          a.row.nextAttemptAt - b.row.nextAttemptAt ||
          a.row.createdAt - b.row.createdAt ||
          a.index - b.index,
      );
    const next = due[0]?.row;
    if (next === undefined) return Promise.resolve(null);
    next.status = 'SENDING';
    next.attempts += 1;
    next.nextAttemptAt = now;
    return Promise.resolve({ ...next });
  }

  private write(id: string, change: (row: Mutable) => void): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      return Promise.reject(new Error('the database is not available'));
    }
    const row = this.rows.find((item) => item.id === id);
    if (row === undefined) return Promise.reject(new Error(`no outbox row ${id}`));
    change(row);
    return Promise.resolve();
  }

  markSent(id: string, at: number, providerMessageId: string | null): Promise<void> {
    return this.write(id, (row) => {
      row.status = 'SENT';
      row.sentAt = at;
      row.providerMessageId = providerMessageId;
    });
  }

  markFailed(id: string, nextAttemptAt: number, error: string): Promise<void> {
    return this.write(id, (row) => {
      row.status = 'FAILED';
      row.nextAttemptAt = nextAttemptAt;
      row.lastError = error;
    });
  }

  markDead(id: string, error: string): Promise<void> {
    return this.write(id, (row) => {
      row.status = 'DEAD';
      row.lastError = error;
    });
  }

  markExpired(id: string, error: string): Promise<void> {
    return this.write(id, (row) => {
      row.status = 'EXPIRED';
      row.lastError = error;
    });
  }

  recoverStuck(now: number, olderThanMs: number): Promise<number> {
    let count = 0;
    for (const row of this.rows) {
      if (row.status === 'SENDING' && row.nextAttemptAt < now - olderThanMs) {
        row.status = 'FAILED';
        row.nextAttemptAt = now;
        row.lastError = 'sending was interrupted';
        count += 1;
      }
    }
    return Promise.resolve(count);
  }

  addSubscription(record: PushSubscriptionRecord): void {
    this.subscriptions.set(record.endpoint, { ...record, lastOkAt: null });
  }

  lastOk(endpoint: string): number | null {
    return this.subscriptions.get(endpoint)?.lastOkAt ?? null;
  }

  list(): Promise<PushSubscriptionRecord[]> {
    return Promise.resolve(
      [...this.subscriptions.values()].map(({ endpoint, p256dh, auth }) => ({
        endpoint,
        p256dh,
        auth,
      })),
    );
  }

  remove(endpoint: string): Promise<void> {
    this.subscriptions.delete(endpoint);
    return Promise.resolve();
  }

  touch(endpoint: string, at: number): Promise<void> {
    const found = this.subscriptions.get(endpoint);
    if (found !== undefined) found.lastOkAt = at;
    return Promise.resolve();
  }
}
