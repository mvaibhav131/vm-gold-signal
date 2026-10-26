import { describe, expect, it } from 'vitest';

import { notificationTestResponseSchema } from '@vmgs/contracts';
import { defaultSettings } from '@vmgs/config';
import type { Settings } from '@vmgs/contracts';

import { makeHarness, T0, type Clock } from '../testing/harness';
import { registerNotificationRoutes } from './routes';
import {
  PostgresNotificationStore,
  type NotificationStore,
  type PushStore,
  type PushSubscriptionInput,
  type TestOutboxRow,
} from './store';

const HOUR = 3_600_000;
const ENDPOINT = 'https://push.example.org/send/AbCdEfGhIjKlMnOpQrStUvWx-secret-endpoint-0001';
const KEYS = {
  p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
  auth: 'tBHItJI5svbpez7KI4CCXg',
};
const ID = '0b9c1f0e-5d1a-4b57-8a43-9f2a1c3d4e5f';

class FakeStores implements NotificationStore, PushStore {
  queued: { row: TestOutboxRow; now: number }[] = [];
  subscribed: PushSubscriptionInput[] = [];
  removed: string[] = [];
  subscribers = 0;
  failure: Error | null = null;

  queueTest(row: TestOutboxRow, now: number) {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (row.channel === 'webpush' && this.subscribers === 0)
      return Promise.resolve('NO_SUBSCRIPTION' as const);
    this.queued.push({ row, now });
    return Promise.resolve('QUEUED' as const);
  }
  subscribe(input: PushSubscriptionInput) {
    if (this.failure !== null) return Promise.reject(this.failure);
    this.subscribed.push(input);
    return Promise.resolve();
  }
  unsubscribe(endpoint: string) {
    if (this.failure !== null) return Promise.reject(this.failure);
    this.removed.push(endpoint);
    return Promise.resolve();
  }
}

async function harness(stores: FakeStores, settings: Settings = defaultSettings()) {
  let clock: Clock | null = null;
  let ids = 0;
  const h = await makeHarness({
    routes: (app, c) => {
      clock = c;
      registerNotificationRoutes(app, {
        notifications: stores,
        push: stores,
        settings: { read: () => Promise.resolve(settings) },
        now: () => c.now,
        newId: () => (ids++ === 0 ? ID : '11111111-2222-4333-8444-555555555555'),
      });
    },
  });
  return { h, cookie: await h.login(), clock: clock as unknown as Clock };
}

const TEST = '/api/v1/notifications/test';
const PUSH = '/api/v1/push/subscribe';

describe('POST /notifications/test', () => {
  it('queues a Telegram row with the key of the answer, the kind TEST and an hour to live', async () => {
    const stores = new FakeStores();
    const { h, cookie, clock } = await harness(stores);
    const reply = await h.send({ url: TEST, cookie, body: { channel: 'telegram' } });
    expect(reply.status).toBe(200);
    expect(notificationTestResponseSchema.parse(reply.json())).toEqual({ eventKey: `test:${ID}` });
    expect(stores.queued).toHaveLength(1);
    const { row, now } = stores.queued[0] ?? { row: null, now: 0 };
    expect(now).toBe(clock.now);
    expect(row).toMatchObject({
      eventKey: `test:${ID}`,
      channel: 'telegram',
      kind: 'TEST',
      expiresAt: T0 + HOUR,
    });
    expect(Object.keys(row?.payload ?? {}).sort()).toEqual(['dropped', 'level', 'text']);
    expect(row?.payload.text).toEqual(expect.stringContaining('TEST MESSAGE'));
  });

  it('queues the Web Push form for Web Push: title, body, url, ttl, urgency and a tag that is the key', async () => {
    const stores = new FakeStores();
    stores.subscribers = 1;
    const { h, cookie } = await harness(stores);
    const reply = await h.send({ url: TEST, cookie, body: { channel: 'webpush' } });
    expect(reply.status).toBe(200);
    expect(stores.queued[0]?.row.payload).toEqual({
      title: 'TEST',
      body: 'Delivery works. Nothing here is a signal.',
      url: '/',
      ttlSec: 3600,
      urgency: 'normal',
      tag: `test:${ID}`,
    });
    expect(stores.queued[0]?.row.channel).toBe('webpush');
  });

  it('writes the text in the language and the zone of the settings', async () => {
    const settings: Settings = {
      ...defaultSettings(),
      locale: 'hinglish',
      displayTz: 'Asia/Kolkata',
    };
    const stores = new FakeStores();
    const { h, cookie } = await harness(stores, settings);
    await h.send({ url: TEST, cookie, body: { channel: 'telegram' } });
    const text = String(stores.queued[0]?.row.payload.text);
    expect(text).toContain('Ye koi signal nahi hai');
    expect(text).toMatch(/11:30/); // 06:00 UTC is 11:30 in Kolkata
  });

  it('answers 409 no_push_subscription, and queues nothing, for Web Push without a device', async () => {
    const stores = new FakeStores();
    const { h, cookie } = await harness(stores);
    const reply = await h.send({ url: TEST, cookie, body: { channel: 'webpush' } });
    expect(reply.status).toBe(409);
    expect(reply.json()).toMatchObject({ code: 'no_push_subscription' });
    expect(stores.queued).toEqual([]);
  });

  it('gives each call a key of its own', async () => {
    const stores = new FakeStores();
    const { h, cookie } = await harness(stores);
    const first = notificationTestResponseSchema.parse(
      (await h.send({ url: TEST, cookie, body: { channel: 'telegram' } })).json(),
    );
    const second = notificationTestResponseSchema.parse(
      (await h.send({ url: TEST, cookie, body: { channel: 'telegram' } })).json(),
    );
    expect(first.eventKey).not.toBe(second.eventKey);
  });

  it('refuses another channel, extra fields and no body, and needs a session', async () => {
    const stores = new FakeStores();
    const { h, cookie } = await harness(stores);
    for (const body of [{ channel: 'sms' }, { channel: 'telegram', text: 'hi' }, {}, undefined]) {
      const reply = await h.send({ method: 'POST', url: TEST, cookie, body });
      expect(reply.status, JSON.stringify(body)).toBe(400);
    }
    expect((await h.send({ url: TEST, body: { channel: 'telegram' } })).status).toBe(401);
    expect(stores.queued).toEqual([]);
  });

  it('answers a failure of the store as a plain 500', async () => {
    const stores = new FakeStores();
    stores.failure = new Error('permission denied for table notification_outbox');
    const { h, cookie } = await harness(stores);
    const reply = await h.send({ url: TEST, cookie, body: { channel: 'telegram' } });
    expect(reply.status).toBe(500);
    expect(reply.res.body).not.toContain('notification_outbox');
  });
});

describe('POST and DELETE /push/subscribe', () => {
  it('pass the endpoint and the keys to the store and answer 204 with no body', async () => {
    const stores = new FakeStores();
    const { h, cookie } = await harness(stores);
    const reply = await h.send({
      url: PUSH,
      cookie,
      body: { endpoint: ENDPOINT, keys: KEYS, userAgent: 'Mozilla/5.0' },
    });
    expect(reply.status).toBe(204);
    expect(reply.res.body).toBe('');
    expect(stores.subscribed).toEqual([
      { endpoint: ENDPOINT, p256dh: KEYS.p256dh, auth: KEYS.auth, userAgent: 'Mozilla/5.0' },
    ]);
    await h.send({ url: PUSH, cookie, body: { endpoint: ENDPOINT, keys: KEYS } });
    expect(stores.subscribed[1]?.userAgent).toBeNull();
  });

  it('remove an endpoint with a 204, known or not', async () => {
    const stores = new FakeStores();
    const { h, cookie } = await harness(stores);
    const reply = await h.send({
      method: 'DELETE',
      url: PUSH,
      cookie,
      body: { endpoint: ENDPOINT },
    });
    expect(reply.status).toBe(204);
    expect(reply.res.body).toBe('');
    expect(stores.removed).toEqual([ENDPOINT]);
  });

  it('refuse a body that does not fit without repeating the endpoint or the keys', async () => {
    const stores = new FakeStores();
    const { h, cookie } = await harness(stores);
    const bad: unknown[] = [
      {},
      { endpoint: 'http://push.example.org/secret-endpoint', keys: KEYS },
      { endpoint: ENDPOINT, keys: { p256dh: 'x', auth: KEYS.auth } },
      { endpoint: ENDPOINT, keys: { ...KEYS, more: 1 } },
      { endpoint: ENDPOINT, keys: KEYS, userAgent: 'u'.repeat(301) },
    ];
    for (const body of bad) {
      const reply = await h.send({ method: 'POST', url: PUSH, cookie, body });
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(reply.res.body).not.toContain('secret-endpoint');
      expect(reply.res.body).not.toContain(KEYS.auth);
    }
    for (const body of [{}, { endpoint: 'http://push.example.org/secret-endpoint' }, undefined]) {
      const reply = await h.send({ method: 'DELETE', url: PUSH, cookie, body });
      expect(reply.status).toBe(400);
      expect(reply.res.body).not.toContain('secret-endpoint');
    }
    expect(stores.subscribed).toEqual([]);
    expect(stores.removed).toEqual([]);
  });

  it('need a session and the Origin of the site', async () => {
    const stores = new FakeStores();
    const { h, cookie } = await harness(stores);
    expect((await h.send({ url: PUSH, body: { endpoint: ENDPOINT, keys: KEYS } })).status).toBe(
      401,
    );
    expect(
      (await h.send({ method: 'DELETE', url: PUSH, body: { endpoint: ENDPOINT } })).status,
    ).toBe(401);
    const crossSite = await h.send({
      url: PUSH,
      cookie,
      body: { endpoint: ENDPOINT, keys: KEYS },
      sameSite: false,
    });
    expect(crossSite.status).toBe(403);
    expect(stores.subscribed).toEqual([]);
  });

  it('answer a failure of the store as a plain 500 that does not contain the endpoint', async () => {
    const stores = new FakeStores();
    stores.failure = new Error(
      `duplicate key value violates unique constraint (endpoint)=(${ENDPOINT})`,
    );
    const { h, cookie } = await harness(stores);
    const reply = await h.send({ url: PUSH, cookie, body: { endpoint: ENDPOINT, keys: KEYS } });
    expect(reply.status).toBe(500);
    expect(reply.res.body).not.toContain('secret-endpoint');
    expect(reply.res.body).not.toContain('duplicate');
  });
});

describe('PostgresNotificationStore', () => {
  /** A pool whose statements fail with a message that quotes the values, the way PostgreSQL does for a constraint. */
  const failing = (code: string) =>
    new PostgresNotificationStore({
      query: () =>
        Promise.reject(
          Object.assign(new Error(`value (${ENDPOINT}) violates a constraint; auth=${KEYS.auth}`), {
            code,
          }),
        ),
    } as never);

  it('rethrows a failed write with its SQLSTATE and without the values', async () => {
    const store = failing('23505');
    const input = { endpoint: ENDPOINT, p256dh: KEYS.p256dh, auth: KEYS.auth, userAgent: null };
    for (const attempt of [() => store.subscribe(input), () => store.unsubscribe(ENDPOINT)]) {
      const error = await attempt().then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      const { message, cause } = error as Error;
      expect(message).toMatch(/\(23505\)$/);
      expect(message).not.toContain('secret-endpoint');
      expect(message).not.toContain(KEYS.auth);
      expect(cause).toBeUndefined();
    }
  });
});
