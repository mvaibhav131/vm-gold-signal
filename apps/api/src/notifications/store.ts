import type { Pool } from 'pg';

import type { OutboxChannel } from '@vmgs/core';

/** What goes into `notification_outbox` for a test message; the worker's sender delivers `payload` as it is. */
export interface TestOutboxRow {
  readonly eventKey: string;
  readonly channel: OutboxChannel;
  readonly kind: 'TEST';
  readonly payload: Readonly<Record<string, unknown>>;
  readonly expiresAt: number;
}

export interface NotificationStore {
  /**
   * Queues the row. `NO_SUBSCRIPTION` when it is for Web Push and no device has subscribed: the sender would only keep
   * such a row until it expires, and the owner would wait for a message that cannot come.
   */
  queueTest(row: TestOutboxRow, now: number): Promise<'QUEUED' | 'NO_SUBSCRIPTION'>;
}

export interface PushSubscriptionInput {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly userAgent: string | null;
}

export interface PushStore {
  /** One row for each endpoint: the same endpoint again updates its keys. */
  subscribe(input: PushSubscriptionInput): Promise<void>;
  /** An endpoint that is not there is not an error. */
  unsubscribe(endpoint: string): Promise<void>;
}

/** The SQLSTATE of a failed statement and nothing else: the message of a database error may quote the values (the endpoint). */
function withoutValues(error: unknown, what: string): Error {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'unknown';
  return new Error(`${what} (${code})`);
}

export class PostgresNotificationStore implements NotificationStore, PushStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async queueTest(row: TestOutboxRow, now: number): Promise<'QUEUED' | 'NO_SUBSCRIPTION'> {
    // For Web Push the insert itself looks for a subscription, so the check and the write are one statement.
    const { rowCount } = await this.pool.query(
      `INSERT INTO notification_outbox (event_key, channel, kind, signal_id, payload, next_attempt_at, expires_at, created_at)
       SELECT $1::text, $2::text, $3::text, NULL::uuid, $4::jsonb, $5::timestamptz, $6::timestamptz, $5::timestamptz
        WHERE $2::text <> 'webpush' OR EXISTS (SELECT 1 FROM push_subscriptions)`,
      [
        row.eventKey,
        row.channel,
        row.kind,
        JSON.stringify(row.payload),
        new Date(now),
        new Date(row.expiresAt),
      ],
    );
    return (rowCount ?? 0) === 1 ? 'QUEUED' : 'NO_SUBSCRIPTION';
  }

  async subscribe(input: PushSubscriptionInput): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint) DO UPDATE
           SET p256dh = EXCLUDED.p256dh,
               auth = EXCLUDED.auth,
               user_agent = COALESCE(EXCLUDED.user_agent, push_subscriptions.user_agent)`,
        [input.endpoint, input.p256dh, input.auth, input.userAgent],
      );
    } catch (error) {
      throw withoutValues(error, 'the push subscription could not be saved');
    }
  }

  async unsubscribe(endpoint: string): Promise<void> {
    try {
      await this.pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
    } catch (error) {
      throw withoutValues(error, 'the push subscription could not be removed');
    }
  }
}
