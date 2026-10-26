import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  notificationTestResponseSchema,
  pushStatusResponseSchema,
  pushSubscribeRequestSchema,
} from '@vmgs/contracts';
import { defaultSettings } from '@vmgs/config';

import { startPgApi, type PgApi } from '../testing/pgApi';
import { T0 } from '../testing/harness';

const HOUR = 3_600_000;
let api: PgApi;

const VAPID_PUBLIC =
  'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';

beforeAll(async () => {
  api = await startPgApi({ vapidPublicKey: VAPID_PUBLIC });
});

afterAll(async () => {
  await api.close();
});

beforeEach(async () => {
  api.clock.now = T0;
  await api.admin.query('DELETE FROM notification_outbox');
  await api.admin.query('DELETE FROM push_subscriptions');
  await api.admin.query('DELETE FROM app_settings');
});

const ENDPOINT = 'https://push.example.org/send/AbCdEfGhIjKlMnOpQrStUvWx-secret-endpoint-0001';
const KEYS = {
  p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
  auth: 'tBHItJI5svbpez7KI4CCXg',
};
const subscribe = (body: unknown) =>
  api.send({ method: 'POST', url: '/api/v1/push/subscribe', body });
const unsubscribe = (body: unknown) =>
  api.send({ method: 'DELETE', url: '/api/v1/push/subscribe', body });
const test = (channel: unknown) =>
  api.send({ method: 'POST', url: '/api/v1/notifications/test', body: { channel } });

interface OutboxRow {
  event_key: string;
  channel: string;
  kind: string;
  signal_id: string | null;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  expires_at: Date | null;
  created_at: Date;
}

const outboxRows = async () =>
  (await api.admin.query<OutboxRow>('SELECT * FROM notification_outbox ORDER BY created_at, id'))
    .rows;
const subscriptions = async () =>
  (
    await api.admin.query<{
      endpoint: string;
      p256dh: string;
      auth: string;
      user_agent: string | null;
      created_at: Date;
    }>('SELECT * FROM push_subscriptions ORDER BY endpoint')
  ).rows;

describe('POST /notifications/test on Postgres', () => {
  it('queues one Telegram row the worker can send, labelled as a test, and answers its event key', async () => {
    const reply = await test('telegram');
    expect(reply.status, reply.body).toBe(200);
    const { eventKey } = notificationTestResponseSchema.parse(reply.json());

    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      event_key: eventKey,
      channel: 'telegram',
      kind: 'TEST',
      signal_id: null,
      status: 'PENDING',
      attempts: 0,
    });
    expect(row?.created_at.getTime()).toBe(T0);
    expect(row?.next_attempt_at.getTime()).toBe(T0); // due at once
    expect(row?.expires_at?.getTime()).toBe(T0 + HOUR);
    // the sender delivers `text` as it is (04 section 4): the message says it is a test and that nothing is a signal
    expect(Object.keys(row?.payload ?? {}).sort()).toEqual(['dropped', 'level', 'text']);
    expect(row?.payload.text).toEqual(expect.stringContaining('TEST MESSAGE'));
    expect(row?.payload.text).toEqual(expect.stringContaining('Nothing here is a signal'));
    expect(row?.payload.dropped).toEqual([]);
  });

  it('gives every message a key of its own', async () => {
    const first = notificationTestResponseSchema.parse((await test('telegram')).json());
    const second = notificationTestResponseSchema.parse((await test('telegram')).json());
    expect(first.eventKey).not.toBe(second.eventKey);
    expect(await outboxRows()).toHaveLength(2);
  });

  it('writes the message in the language and the time zone of the settings', async () => {
    await api.admin.query(
      `INSERT INTO app_settings (key, value) VALUES ('locale', '"hinglish"'::jsonb)`,
    );
    await api.admin.query(
      `INSERT INTO app_settings (key, value) VALUES ('displayTz', '"America/New_York"'::jsonb)`,
    );
    expect((await test('telegram')).status).toBe(200);
    const text = (await outboxRows())[0]?.payload.text as string;
    expect(text).toContain('Ye koi signal nahi hai');
    // 06:00 UTC on 26 October 2026 is 02:00 in New York (daylight time until 1 November)
    expect(text).toMatch(/02:00/);
  });

  it('is sent whatever the alert switches say: the owner tests the channel, not the rules for signals', async () => {
    const settings = defaultSettings();
    settings.alerts.telegram.enabled = false;
    await api.admin.query(`INSERT INTO app_settings (key, value) VALUES ('alerts', $1::jsonb)`, [
      JSON.stringify(settings.alerts),
    ]);
    expect((await test('telegram')).status).toBe(200);
    expect(await outboxRows()).toHaveLength(1);
  });

  it('answers 409 no_push_subscription for Web Push while no device has subscribed, and queues nothing', async () => {
    const reply = await test('webpush');
    expect(reply.status).toBe(409);
    expect(reply.json()).toMatchObject({ code: 'no_push_subscription' });
    expect(await outboxRows()).toHaveLength(0);
  });

  it('queues the Web Push row in the form of the sender once a device has subscribed', async () => {
    expect((await subscribe({ endpoint: ENDPOINT, keys: KEYS })).status).toBe(204);
    const reply = await test('webpush');
    expect(reply.status, reply.body).toBe(200);
    const { eventKey } = notificationTestResponseSchema.parse(reply.json());
    const row = (await outboxRows())[0];
    expect(row).toMatchObject({
      event_key: eventKey,
      channel: 'webpush',
      kind: 'TEST',
      status: 'PENDING',
    });
    expect(row?.expires_at?.getTime()).toBe(T0 + HOUR);
    // the fields `pushPayloadOf` of the sender needs, with the types it checks
    expect(row?.payload).toEqual({
      title: 'TEST',
      body: 'Delivery works. Nothing here is a signal.',
      url: '/',
      ttlSec: 3600,
      urgency: 'normal',
      tag: eventKey,
    });
    expect(JSON.stringify(row)).not.toContain('secret-endpoint');
  });

  it('refuses a channel that does not exist, and a body that says more', async () => {
    expect((await test('sms')).status).toBe(400);
    const extra = await api.send({
      method: 'POST',
      url: '/api/v1/notifications/test',
      body: { channel: 'telegram', text: 'hello' },
    });
    expect(extra.status).toBe(400);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('is refused without a session', async () => {
    const reply = await api.app.inject({
      method: 'POST',
      url: '/api/v1/notifications/test',
      remoteAddress: '203.0.113.8',
      headers: { origin: 'https://vmgs.example.org', 'x-vmgs-csrf': '1' },
      payload: { channel: 'telegram' },
    });
    expect(reply.statusCode).toBe(401);
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('GET /push/status on Postgres', () => {
  const status = () => api.send({ url: '/api/v1/push/status' });

  it('counts the subscribed devices as they come and go, and gives the key of the server', async () => {
    const none = await status();
    expect(none.status, none.body).toBe(200);
    expect(pushStatusResponseSchema.parse(none.json())).toEqual({
      publicKey: VAPID_PUBLIC,
      devices: 0,
    });

    await subscribe({ endpoint: ENDPOINT, keys: KEYS });
    await subscribe({ endpoint: 'https://push.example.org/send/second-device-0002', keys: KEYS });
    expect((await status()).json()).toEqual({ publicKey: VAPID_PUBLIC, devices: 2 });
    // the same device again is one device
    await subscribe({ endpoint: ENDPOINT, keys: KEYS });
    expect(pushStatusResponseSchema.parse((await status()).json()).devices).toBe(2);

    await unsubscribe({ endpoint: ENDPOINT });
    expect(pushStatusResponseSchema.parse((await status()).json()).devices).toBe(1);
  });

  it('is refused without a session, and says nothing of the key', async () => {
    const reply = await api.anonymous('/api/v1/push/status');
    expect(reply.status).toBe(401);
    expect(reply.body).not.toContain(VAPID_PUBLIC);
  });
});

describe('POST and DELETE /push/subscribe on Postgres', () => {
  it('stores a subscription and answers 204', async () => {
    const reply = await subscribe({
      endpoint: ENDPOINT,
      keys: KEYS,
      userAgent: 'Mozilla/5.0 (iPhone)',
    });
    expect(reply.status).toBe(204);
    expect(reply.body).toBe('');
    const rows = await subscriptions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      endpoint: ENDPOINT,
      p256dh: KEYS.p256dh,
      auth: KEYS.auth,
      user_agent: 'Mozilla/5.0 (iPhone)',
    });
  });

  it('updates the keys of an endpoint that subscribes again, and never duplicates it', async () => {
    await subscribe({ endpoint: ENDPOINT, keys: KEYS, userAgent: 'first' });
    const created = (await subscriptions())[0]?.created_at;
    const next = {
      p256dh: `${KEYS.p256dh.slice(0, 20)}ZZZZZZZZZZZZZZZZZZZZZZ`,
      auth: 'cccccccccccccccccccccc',
    };
    expect((await subscribe({ endpoint: ENDPOINT, keys: next })).status).toBe(204);
    const rows = await subscriptions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ p256dh: next.p256dh, auth: next.auth, user_agent: 'first' });
    expect(rows[0]?.created_at).toEqual(created);
    // a new user agent replaces the old one
    await subscribe({ endpoint: ENDPOINT, keys: next, userAgent: 'second' });
    expect((await subscriptions())[0]?.user_agent).toBe('second');
  });

  it('keeps one row when the same endpoint subscribes in parallel', async () => {
    const replies = await Promise.all(
      Array.from({ length: 8 }, () => subscribe({ endpoint: ENDPOINT, keys: KEYS })),
    );
    expect(replies.map((reply) => reply.status)).toEqual(Array.from({ length: 8 }, () => 204));
    expect(await subscriptions()).toHaveLength(1);
  });

  it('removes the endpoint that is named and no other; an unknown endpoint is a 204 that does nothing', async () => {
    const other = 'https://push.example.org/send/another-device-endpoint-0002';
    await subscribe({ endpoint: ENDPOINT, keys: KEYS });
    await subscribe({ endpoint: other, keys: KEYS });
    expect((await unsubscribe({ endpoint: ENDPOINT })).status).toBe(204);
    expect((await subscriptions()).map((row) => row.endpoint)).toEqual([other]);
    const again = await unsubscribe({ endpoint: ENDPOINT });
    expect(again.status).toBe(204);
    expect(again.body).toBe('');
    expect((await subscriptions()).map((row) => row.endpoint)).toEqual([other]);
  });

  it('does not change the switch of Web Push in the settings', async () => {
    const settings = defaultSettings();
    await api.admin.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('alerts', $1::jsonb, '2020-01-01')`,
      [JSON.stringify(settings.alerts)],
    );
    await subscribe({ endpoint: ENDPOINT, keys: KEYS });
    await unsubscribe({ endpoint: ENDPOINT });
    const { rows } = await api.admin.query<{ value: unknown; updated_at: Date }>(
      `SELECT value, updated_at FROM app_settings WHERE key = 'alerts'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toEqual(settings.alerts);
    expect(rows[0]?.updated_at.getTime()).toBe(Date.UTC(2020, 0, 1));
    expect((await api.admin.query('SELECT 1 FROM app_settings')).rowCount).toBe(1);
  });

  it('refuses what does not fit the contract and never repeats the endpoint or the keys', async () => {
    const bad: unknown[] = [
      {},
      { endpoint: ENDPOINT },
      { endpoint: 'http://push.example.org/plain', keys: KEYS },
      { endpoint: 'not a url secret-endpoint', keys: KEYS },
      { endpoint: ENDPOINT, keys: { p256dh: 'short', auth: KEYS.auth } },
      { endpoint: ENDPOINT, keys: { p256dh: `${KEYS.p256dh}!!`, auth: KEYS.auth } },
      { endpoint: ENDPOINT, keys: { ...KEYS, extra: 'x' } },
      { endpoint: ENDPOINT, keys: KEYS, userAgent: 'u'.repeat(301) },
      { endpoint: ENDPOINT, keys: KEYS, expirationTime: 5 },
    ];
    for (const body of bad) {
      const reply = await subscribe(body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(reply.body).not.toContain('secret-endpoint');
      expect(reply.body).not.toContain(KEYS.auth);
      expect(reply.body).not.toContain(KEYS.p256dh);
    }
    expect((await unsubscribe({})).status).toBe(400);
    expect((await unsubscribe({ endpoint: 'http://x.example/y' })).status).toBe(400);
    expect(await subscriptions()).toHaveLength(0);
  });

  it('is refused without a session', async () => {
    const reply = await api.app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      remoteAddress: '203.0.113.8',
      headers: { origin: 'https://vmgs.example.org', 'x-vmgs-csrf': '1' },
      payload: { endpoint: ENDPOINT, keys: KEYS },
    });
    expect(reply.statusCode).toBe(401);
    expect(await subscriptions()).toHaveLength(0);
  });

  it('accepts exactly what the contract accepts', () => {
    expect(pushSubscribeRequestSchema.safeParse({ endpoint: ENDPOINT, keys: KEYS }).success).toBe(
      true,
    );
  });
});
