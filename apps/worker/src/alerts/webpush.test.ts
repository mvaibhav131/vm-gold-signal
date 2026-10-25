import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';

import webpush from 'web-push';
import { describe, expect, it } from 'vitest';

import { LibWebPushSink, pushBodyOf, pushOptionsFor, topicOf, type PushPayload } from './webpush';

const PAYLOAD: PushPayload = {
  title: 'BUY XAUUSD #S-0042 (Strong 78)',
  body: 'Entry 4017.370, stop 4010.900, TP1 4023.840, TP2 4030.310',
  url: '/signals/0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e10',
  tag: 'signal:0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e10:confirmed',
  ttlSec: 180,
  urgency: 'high',
};

/** A browser's side of a subscription: a P-256 key and a 16-byte auth secret. */
function subscriptionKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    record: {
      endpoint: 'https://push.example/send/abc',
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: auth.toString('base64url'),
    },
  };
}

/** Decrypts an aes128gcm Web Push body as the browser does (RFC 8188 and RFC 8291). */
function decrypt(body: Buffer, browser: ReturnType<typeof subscriptionKeys>): string {
  const salt = body.subarray(0, 16);
  const idLength = body[20] ?? 0;
  const serverPublic = body.subarray(21, 21 + idLength);
  const encrypted = body.subarray(21 + idLength);
  const secret = browser.ecdh.computeSecret(serverPublic);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    browser.ecdh.getPublicKey(),
    serverPublic,
  ]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, browser.auth, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  );
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
  const plain = Buffer.concat([
    decipher.update(encrypted.subarray(0, encrypted.length - 16)),
    decipher.final(),
  ]);
  // the last record ends with the delimiter 0x02 and padding zeros
  const end = plain.lastIndexOf(0x02);
  return plain.subarray(0, end).toString('utf8');
}

describe('the options of a delivery', () => {
  it('has the TTL in whole seconds, never negative, the urgency and a topic of at most 32 safe characters', () => {
    expect(pushOptionsFor(PAYLOAD, 180)).toEqual({
      TTL: 180,
      urgency: 'high',
      topic: topicOf(PAYLOAD.tag),
    });
    expect(pushOptionsFor(PAYLOAD, 12.9).TTL).toBe(12);
    expect(pushOptionsFor(PAYLOAD, -5).TTL).toBe(0);
    const topic = topicOf(PAYLOAD.tag);
    expect(topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(topicOf(PAYLOAD.tag)).toBe(topic);
    expect(topicOf(`${PAYLOAD.tag}x`)).not.toBe(topic);
  });

  it('the text for the browser has the title, the body, the link and the tag', () => {
    expect(JSON.parse(pushBodyOf(PAYLOAD))).toEqual({
      title: PAYLOAD.title,
      body: PAYLOAD.body,
      url: PAYLOAD.url,
      tag: PAYLOAD.tag,
    });
  });
});

describe('what the library really sends', () => {
  it('has the VAPID header, the TTL, the urgency and the topic, and a body only the subscriber can read', () => {
    const vapid = webpush.generateVAPIDKeys();
    const browser = subscriptionKeys();
    const details = webpush.generateRequestDetails(
      {
        endpoint: browser.record.endpoint,
        keys: { p256dh: browser.record.p256dh, auth: browser.record.auth },
      },
      pushBodyOf(PAYLOAD),
      {
        ...pushOptionsFor(PAYLOAD, 180),
        vapidDetails: { subject: 'mailto:owner@example.com', ...vapid },
      },
    ) as { method: string; endpoint: string; headers: Record<string, string>; body: Buffer };

    expect(details.method).toBe('POST');
    expect(details.endpoint).toBe(browser.record.endpoint);
    expect(Number(details.headers.TTL)).toBe(180);
    expect(details.headers.Urgency).toBe('high');
    expect(details.headers.Topic).toBe(topicOf(PAYLOAD.tag));
    expect(details.headers['Content-Encoding']).toBe('aes128gcm');
    expect(details.headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(details.headers.Authorization).toContain(`k=${vapid.publicKey}`);

    // the body is encrypted, and decrypts to the message with the subscriber's keys only
    expect(details.body.toString('utf8')).not.toContain('XAUUSD');
    expect(JSON.parse(decrypt(details.body, browser))).toEqual(JSON.parse(pushBodyOf(PAYLOAD)));
    expect(() => decrypt(details.body, subscriptionKeys())).toThrow();
  });

  it('the decryption used here is the one of the RFC: it reads what an independent encryption writes', () => {
    // RFC 8188 record layout with a known plaintext, written here independently of the library
    const browser = subscriptionKeys();
    const server = createECDH('prime256v1');
    server.generateKeys();
    const salt = randomBytes(16);
    const secret = server.computeSecret(browser.ecdh.getPublicKey());
    const keyInfo = Buffer.concat([
      Buffer.from('WebPush: info\0'),
      browser.ecdh.getPublicKey(),
      server.getPublicKey(),
    ]);
    const ikm = Buffer.from(hkdfSync('sha256', secret, browser.auth, keyInfo, 32));
    const cek = Buffer.from(
      hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
    );
    const nonce = Buffer.from(
      hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
    );
    const cipher = createCipheriv('aes-128-gcm', cek, nonce);
    const encrypted = Buffer.concat([
      cipher.update(Buffer.concat([Buffer.from('hello'), Buffer.from([2])])),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const header = Buffer.concat([
      salt,
      Buffer.from([0, 0, 16, 0]),
      Buffer.from([65]),
      server.getPublicKey(),
    ]);
    expect(decrypt(Buffer.concat([header, encrypted]), browser)).toBe('hello');
  });
});

describe('LibWebPushSink', () => {
  const vapid = { subject: 'mailto:owner@example.com', publicKey: 'pub', privateKey: 'priv' };
  const subscription = { endpoint: 'https://push.example/x', p256dh: 'p', auth: 'a' };

  it('hands the library the subscription, the text, the options and the VAPID details', async () => {
    const calls: { subscription: unknown; payload: string; options: webpush.RequestOptions }[] = [];
    const sink = new LibWebPushSink(vapid, (sub, payload, options) => {
      calls.push({ subscription: sub, payload, options });
      return Promise.resolve({ statusCode: 201 });
    });
    expect(await sink.send(subscription, PAYLOAD, 90)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subscription).toEqual({
      endpoint: subscription.endpoint,
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(calls[0]?.payload).toBe(pushBodyOf(PAYLOAD));
    expect(calls[0]?.options).toMatchObject({
      TTL: 90,
      urgency: 'high',
      topic: topicOf(PAYLOAD.tag),
      vapidDetails: vapid,
      timeout: 15_000,
    });
  });

  it('tells a subscription that is gone, a message that is refused, and a failure to try again', async () => {
    const fail = (statusCode: number | null) =>
      new LibWebPushSink(vapid, () =>
        Promise.reject(
          Object.assign(new Error('push failed'), statusCode === null ? {} : { statusCode }),
        ),
      ).send(subscription, PAYLOAD, 60);
    expect(await fail(410)).toEqual({
      ok: false,
      gone: true,
      permanent: false,
      message: 'HTTP 410: push failed',
    });
    expect(await fail(404)).toMatchObject({ gone: true, permanent: false });
    expect(await fail(400)).toMatchObject({ gone: false, permanent: true });
    expect(await fail(413)).toMatchObject({ gone: false, permanent: true });
    for (const status of [401, 403, 429, 500, 503]) {
      expect(await fail(status), String(status)).toMatchObject({ gone: false, permanent: false });
    }
    expect(await fail(null)).toEqual({
      ok: false,
      gone: false,
      permanent: false,
      message: 'push failed',
    });
  });

  it('a thing that is not an error is still a failure to try again', async () => {
    // a rejection that is not an Error, as a library may do
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const sink = new LibWebPushSink(vapid, () => Promise.reject('weird'));
    expect(await sink.send(subscription, PAYLOAD, 60)).toEqual({
      ok: false,
      gone: false,
      permanent: false,
      message: 'push failed',
    });
  });
});
