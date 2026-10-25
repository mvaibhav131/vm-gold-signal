import {
  NOTIFICATION_KINDS,
  expiryOf,
  priorityOf,
  type OutboxChannel,
  type OutboxRow,
} from '@vmgs/core';
import type { Pool } from 'pg';

import type {
  OutboxEntry,
  OutboxStatus,
  OutboxStore,
  PushSubscriptionRecord,
  PushSubscriptionStore,
} from './store';

interface EntryRow {
  readonly id: string;
  readonly event_key: string;
  readonly channel: OutboxChannel;
  readonly kind: OutboxEntry['kind'];
  readonly signal_id: string | null;
  readonly payload: Record<string, unknown>;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly next_attempt_at: Date;
  readonly expires_at: Date | null;
  readonly created_at: Date;
  readonly sent_at: Date | null;
  readonly provider_message_id: string | null;
  readonly last_error: string | null;
}

const COLUMNS =
  'id, event_key, channel, kind, signal_id, payload, status, attempts, next_attempt_at, expires_at, created_at, sent_at, provider_message_id, last_error';

const time = (value: Date | null): number | null => (value === null ? null : value.getTime());

function entryOf(row: EntryRow): OutboxEntry {
  return {
    id: row.id,
    eventKey: row.event_key,
    channel: row.channel,
    kind: row.kind,
    signalId: row.signal_id,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at.getTime(),
    expiresAt: time(row.expires_at),
    createdAt: row.created_at.getTime(),
    sentAt: time(row.sent_at),
    providerMessageId: row.provider_message_id,
    lastError: row.last_error,
  };
}

/** The same order as `priorityOf` of the core, written as SQL from that function so the two cannot drift. */
const PRIORITY_SQL = `CASE kind ${NOTIFICATION_KINDS.map(
  (kind) => `WHEN '${kind}' THEN ${String(priorityOf(kind))}`,
).join(' ')} END`;

/** The expiry of a row, in SQL: its own, or an hour after it was written (`expiryOf` of the core). */
const EXPIRY_SQL = `COALESCE(expires_at, created_at + interval '${String(expiryOf(null, 0) / 1000)} seconds')`;

/**
 * The outbox in PostgreSQL. Claiming is one statement with `FOR UPDATE SKIP LOCKED`, so two senders
 * never take the same row and a crash cannot leave a row half-claimed. Times come from the caller,
 * not from the database clock, so the sender and its tests see one clock.
 */
export class PostgresOutboxStore implements OutboxStore, PushSubscriptionStore {
  constructor(private readonly pool: Pool) {}

  async enqueue(rows: readonly OutboxRow[], now: number): Promise<number> {
    let inserted = 0;
    for (const row of rows) {
      const result = await this.pool.query(
        `INSERT INTO notification_outbox (event_key, channel, kind, signal_id, payload, next_attempt_at, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $6)
         ON CONFLICT (event_key, channel) DO NOTHING`,
        [
          row.eventKey,
          row.channel,
          row.kind,
          row.signalId,
          JSON.stringify(row.payload),
          new Date(now),
          row.expiresAt === null ? null : new Date(row.expiresAt),
        ],
      );
      inserted += result.rowCount ?? 0;
    }
    return inserted;
  }

  async expireOverdue(now: number): Promise<number> {
    const result = await this.pool.query(
      `UPDATE notification_outbox
          SET status = 'EXPIRED', last_error = COALESCE(last_error, 'expired before it could be sent')
        WHERE status IN ('PENDING', 'FAILED') AND ${EXPIRY_SQL} <= $1`,
      [new Date(now)],
    );
    return result.rowCount ?? 0;
  }

  async claimNext(channel: OutboxChannel, now: number): Promise<OutboxEntry | null> {
    const { rows } = await this.pool.query<EntryRow>(
      `WITH next AS (
         SELECT id FROM notification_outbox
          WHERE channel = $1 AND status IN ('PENDING', 'FAILED')
            AND next_attempt_at <= $2 AND ${EXPIRY_SQL} > $2
          ORDER BY ${PRIORITY_SQL}, next_attempt_at, created_at, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED)
       UPDATE notification_outbox o
          SET status = 'SENDING', attempts = o.attempts + 1, next_attempt_at = $2
         FROM next
        WHERE o.id = next.id
       RETURNING ${COLUMNS.split(', ')
         .map((column) => `o.${column}`)
         .join(', ')}`,
      [channel, new Date(now)],
    );
    const row = rows[0];
    return row === undefined ? null : entryOf(row);
  }

  async markSent(id: string, at: number, providerMessageId: string | null): Promise<void> {
    await this.pool.query(
      "UPDATE notification_outbox SET status = 'SENT', sent_at = $2, provider_message_id = $3 WHERE id = $1",
      [id, new Date(at), providerMessageId],
    );
  }

  async markFailed(id: string, nextAttemptAt: number, error: string): Promise<void> {
    await this.pool.query(
      "UPDATE notification_outbox SET status = 'FAILED', next_attempt_at = $2, last_error = $3 WHERE id = $1",
      [id, new Date(nextAttemptAt), error],
    );
  }

  async markDead(id: string, error: string): Promise<void> {
    await this.pool.query(
      "UPDATE notification_outbox SET status = 'DEAD', last_error = $2 WHERE id = $1",
      [id, error],
    );
  }

  async markExpired(id: string, error: string): Promise<void> {
    await this.pool.query(
      "UPDATE notification_outbox SET status = 'EXPIRED', last_error = $2 WHERE id = $1",
      [id, error],
    );
  }

  async recoverStuck(now: number, olderThanMs: number): Promise<number> {
    const result = await this.pool.query(
      `UPDATE notification_outbox
          SET status = 'FAILED', next_attempt_at = $1, last_error = 'sending was interrupted'
        WHERE status = 'SENDING' AND next_attempt_at < $2`,
      [new Date(now), new Date(now - olderThanMs)],
    );
    return result.rowCount ?? 0;
  }

  async list(): Promise<PushSubscriptionRecord[]> {
    const { rows } = await this.pool.query<PushSubscriptionRecord>(
      'SELECT endpoint, p256dh, auth FROM push_subscriptions ORDER BY created_at',
    );
    return rows;
  }

  async remove(endpoint: string): Promise<void> {
    await this.pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
  }

  async touch(endpoint: string, at: number): Promise<void> {
    await this.pool.query('UPDATE push_subscriptions SET last_ok_at = $2 WHERE endpoint = $1', [
      endpoint,
      new Date(at),
    ]);
  }
}
