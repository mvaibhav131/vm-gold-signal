import { createPool } from '@vmgs/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { query, type TestDatabase } from '../../../../packages/db/test/database';
import { migratedDatabase } from '../../../../packages/db/test/setup';
import { outboxStoreContract, type OutboxHarness, outboxRow, T } from './outboxContract';
import { PostgresOutboxStore } from './postgresOutboxStore';
import type { OutboxEntry, OutboxStatus } from './store';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

let database: TestDatabase;
let pool: ReturnType<typeof createPool>;
let store: PostgresOutboxStore;

beforeAll(async () => {
  database = await migratedDatabase();
  await query(database.url, "ALTER ROLE vmgs_worker LOGIN PASSWORD 'worker-pass'");
  pool = createPool(database.urlFor('vmgs_worker', 'worker-pass'), { max: 6 });
  store = new PostgresOutboxStore(pool);
});

afterAll(async () => {
  await pool.end();
  await database.drop();
});

interface Row {
  id: string;
  event_key: string;
  channel: 'telegram' | 'webpush';
  kind: OutboxEntry['kind'];
  signal_id: string | null;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: Date;
  expires_at: Date | null;
  created_at: Date;
  sent_at: Date | null;
  provider_message_id: string | null;
  last_error: string | null;
}

const harness: OutboxHarness = {
  store: undefined as never,
  async entry(eventKey, channel) {
    const [row] = await query<Row>(
      database.url,
      'SELECT * FROM notification_outbox WHERE event_key = $1 AND channel = $2',
      [eventKey, channel],
    );
    if (row === undefined) return undefined;
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
      expiresAt: row.expires_at === null ? null : row.expires_at.getTime(),
      createdAt: row.created_at.getTime(),
      sentAt: row.sent_at === null ? null : row.sent_at.getTime(),
      providerMessageId: row.provider_message_id,
      lastError: row.last_error,
    };
  },
  async addSubscription(record) {
    await query(
      database.url,
      'INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES ($1, $2, $3)',
      [record.endpoint, record.p256dh, record.auth],
    );
  },
  async lastOk(endpoint) {
    const [row] = await query<{ last_ok_at: Date | null }>(
      database.url,
      'SELECT last_ok_at FROM push_subscriptions WHERE endpoint = $1',
      [endpoint],
    );
    return row?.last_ok_at == null ? null : row.last_ok_at.getTime();
  },
};

outboxStoreContract('PostgreSQL', async () => {
  // every test starts from an empty outbox, as the in-memory store does
  await query(database.url, 'DELETE FROM notification_outbox');
  return {
    harness: { ...harness, store },
    done: () => Promise.resolve(),
  };
});

describe('PostgreSQL specifics', () => {
  it('the worker role can do everything the sender does', async () => {
    await query(database.url, 'DELETE FROM notification_outbox');
    const message = outboxRow('TEST');
    expect(await store.enqueue([message], T)).toBe(1);
    const claimed = await store.claimNext('telegram', T);
    expect(claimed?.eventKey).toBe(message.eventKey);
    await store.markSent(claimed?.id ?? '', T, '1');
    expect((await harness.entry(message.eventKey, 'telegram'))?.status).toBe('SENT');
  });

  it('uses the clock it is given, not the database clock, for the time a message was written', async () => {
    await query(database.url, 'DELETE FROM notification_outbox');
    const message = outboxRow('TEST');
    await store.enqueue([message], T);
    expect((await harness.entry(message.eventKey, 'telegram'))?.createdAt).toBe(T);
  });

  it('the order of the claim in SQL is the order of priorityOf for every kind', async () => {
    await query(database.url, 'DELETE FROM notification_outbox');
    const { NOTIFICATION_KINDS, priorityOf } = await import('@vmgs/core');
    const rows = NOTIFICATION_KINDS.map((kind) => outboxRow(kind));
    await store.enqueue(rows, T);
    const claimed: OutboxEntry['kind'][] = [];
    for (;;) {
      const next = await store.claimNext('telegram', T);
      if (next === null) break;
      claimed.push(next.kind);
    }
    expect(claimed).toHaveLength(NOTIFICATION_KINDS.length);
    const priorities = claimed.map(priorityOf);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect(claimed[0]).toBe('SIGNAL_NEW');
  });
});
