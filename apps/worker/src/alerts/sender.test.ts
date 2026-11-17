import { RETRY_CAP_MS, RETRY_DELAYS_MS, type NotificationKind } from '@vmgs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeTelegram } from '../testing/fakeTelegram';
import { MemoryOutboxStore } from '../testing/memoryOutboxStore';
import { TelegramApiError, TelegramClient } from '../telegram/client';
import { TelegramTransport } from '../telegram/transport';
import { outboxRow, T } from './outboxContract';
import { OutboxSender } from './sender';
import type { PushPayload, PushResult } from './webpush';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const CHAT = 4242;

interface Rig {
  readonly clock: { now: number };
  readonly store: MemoryOutboxStore;
  readonly sender: OutboxSender;
  readonly sent: { chatId: number | string; text: string; at: number }[];
  readonly script: (Error | 'ok')[];
  readonly chat: { id: number | string | null };
  readonly pushed: { endpoint: string; payload: PushPayload; ttlSec: number }[];
  readonly pushResults: Map<string, PushResult>;
  readonly logs: { level: string; message: string }[];
}

function rig(options: { telegram?: boolean; webpush?: boolean } = {}): Rig {
  const clock = { now: T };
  const store = new MemoryOutboxStore();
  const sent: Rig['sent'] = [];
  const script: Rig['script'] = [];
  const chat: Rig['chat'] = { id: CHAT };
  const pushed: Rig['pushed'] = [];
  const pushResults: Rig['pushResults'] = new Map();
  const logs: Rig['logs'] = [];
  const transport = new TelegramTransport({
    client: {
      sendMessage: (chatId, text) => {
        const step = script.shift() ?? 'ok';
        if (step !== 'ok') return Promise.reject(step);
        sent.push({ chatId, text, at: clock.now });
        return Promise.resolve({ messageId: 100 + sent.length });
      },
    },
    now: () => clock.now,
  });
  const sender = new OutboxSender({
    store,
    ...(options.telegram === false
      ? {}
      : { telegram: { transport, chatId: () => Promise.resolve(chat.id) } }),
    ...(options.webpush === false
      ? {}
      : {
          webpush: {
            subscriptions: store,
            sink: {
              send: (subscription, payload, ttlSec) => {
                pushed.push({ endpoint: subscription.endpoint, payload, ttlSec });
                return Promise.resolve(pushResults.get(subscription.endpoint) ?? { ok: true });
              },
            },
          },
        }),
    now: () => clock.now,
    log: (level, message) => logs.push({ level, message }),
  });
  return { clock, store, sender, sent, script, chat, pushed, pushResults, logs };
}

const tg = (kind: NotificationKind, text: string, expiresAt: number | null = T + HOUR) =>
  outboxRow(kind, { channel: 'telegram', payload: { text }, expiresAt });

const PUSH = {
  title: 'BUY XAUUSD',
  body: 'Entry 4100.00',
  url: '/signals/1',
  tag: 'signal-1',
  ttlSec: 3600,
  urgency: 'high',
} as const;

const push = (
  kind: NotificationKind,
  payload: Record<string, unknown> = PUSH,
  expiresAt: number | null = T + HOUR,
) => outboxRow(kind, { channel: 'webpush', payload, expiresAt });

const SUB = { endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a' };
const SUB2 = { endpoint: 'https://push.example/2', p256dh: 'k2', auth: 'a2' };

describe('sending to Telegram', () => {
  it('sends a due message to the linked chat and records it as sent', async () => {
    const r = rig();
    const row = tg('SIGNAL_NEW', 'BUY now');
    await r.store.enqueue([row], r.clock.now);
    expect(await r.sender.runOnce()).toBe(1);
    expect(r.sent).toEqual([{ chatId: CHAT, text: 'BUY now', at: T }]);
    expect(r.store.entry(row.eventKey, 'telegram')).toMatchObject({
      status: 'SENT',
      attempts: 1,
      sentAt: T,
      providerMessageId: '101',
    });
    expect(r.sender.stats).toMatchObject({ sent: 1, retried: 0, dead: 0, expired: 0 });
    // nothing to do on the next pass, and a sent row is never sent again
    r.clock.now += 5 * SECOND;
    expect(await r.sender.runOnce()).toBe(0);
    expect(r.sent).toHaveLength(1);
  });

  it('sends the most important message first, one a second', async () => {
    const r = rig();
    await r.store.enqueue(
      [
        tg('SYSTEM_DEGRADED', 'system'),
        tg('SIGNAL_CLOSED', 'closed'),
        tg('SIGNAL_NEW', 'new'),
        tg('SIGNAL_TP1', 'tp1'),
      ],
      r.clock.now,
    );
    for (let i = 0; i < 4; i += 1) {
      await r.sender.runOnce();
      r.clock.now += SECOND;
    }
    expect(r.sent.map((item) => item.text)).toEqual(['new', 'closed', 'tp1', 'system']);
    expect(r.sent.map((item) => item.at - T)).toEqual([0, SECOND, 2 * SECOND, 3 * SECOND]);
  });

  it('keeps to one message a second: a second pass at once sends nothing, one a second later sends', async () => {
    const r = rig();
    await r.store.enqueue([tg('SIGNAL_NEW', 'a'), tg('SIGNAL_NEW', 'b')], r.clock.now);
    expect(await r.sender.runOnce()).toBe(1);
    r.clock.now += 999;
    expect(await r.sender.runOnce()).toBe(0);
    r.clock.now += 1;
    expect(await r.sender.runOnce()).toBe(1);
    expect(r.sent).toHaveLength(2);
  });

  it('retries a transient failure after 2 s, 5 s, 15 s, 45 s, 2 min, then every 5 min', async () => {
    const r = rig();
    const row = tg('SYSTEM_DEGRADED', 'x', T + 40 * MINUTE);
    await r.store.enqueue([row], r.clock.now);
    const waits = [...RETRY_DELAYS_MS, RETRY_CAP_MS, RETRY_CAP_MS];
    for (const [index, wait] of waits.entries()) {
      r.script.push(new Error('network down'));
      await r.sender.runOnce();
      const entry = r.store.entry(row.eventKey, 'telegram');
      expect(entry).toMatchObject({
        status: 'FAILED',
        attempts: index + 1,
        lastError: 'network down',
      });
      expect(entry?.nextAttemptAt).toBe(r.clock.now + wait);
      // not before its time
      r.clock.now += wait - 1;
      expect(await r.sender.runOnce()).toBe(0);
      r.clock.now += 1;
    }
    expect(await r.sender.runOnce()).toBe(1);
    expect(r.store.entry(row.eventKey, 'telegram')).toMatchObject({
      status: 'SENT',
      attempts: waits.length + 1,
    });
    expect(r.sender.stats.retried).toBe(waits.length);
  });

  it('waits what Telegram asks for after a 429, and sends nothing to anyone meanwhile', async () => {
    const r = rig();
    const first = tg('SIGNAL_NEW', 'first');
    const second = tg('SYSTEM_DEGRADED', 'second');
    await r.store.enqueue([first, second], r.clock.now);
    r.script.push(new TelegramApiError('Too Many Requests', 'api', 429, 429, 30));
    await r.sender.runOnce();
    expect(r.store.entry(first.eventKey, 'telegram')).toMatchObject({
      status: 'FAILED',
      nextAttemptAt: T + 30 * SECOND,
    });
    r.clock.now += 29 * SECOND;
    expect(await r.sender.runOnce()).toBe(0);
    expect(r.sent).toHaveLength(0);
    r.clock.now += SECOND;
    await r.sender.runOnce();
    expect(r.sent.map((item) => item.text)).toEqual(['first']);
    r.clock.now += SECOND;
    await r.sender.runOnce();
    expect(r.sent.map((item) => item.text)).toEqual(['first', 'second']);
  });

  it('a 429 that asks for less than the backoff still waits the backoff', async () => {
    const r = rig();
    const row = tg('SIGNAL_NEW', 'a');
    await r.store.enqueue([row], r.clock.now);
    r.script.push(new TelegramApiError('Too Many Requests', 'api', 429, 429, 1));
    await r.sender.runOnce();
    expect(r.store.entry(row.eventKey, 'telegram')?.nextAttemptAt).toBe(T + 2 * SECOND);
  });

  it('a refused message (400) is dead at once and is never tried again', async () => {
    const r = rig();
    const row = tg('SIGNAL_NEW', 'a');
    await r.store.enqueue([row], r.clock.now);
    r.script.push(new TelegramApiError("Bad Request: can't parse entities", 'api', 400, 400, null));
    await r.sender.runOnce();
    expect(r.store.entry(row.eventKey, 'telegram')).toMatchObject({
      status: 'DEAD',
      lastError: "Bad Request: can't parse entities",
    });
    expect(r.sender.stats.dead).toBe(1);
    expect(r.logs.some((log) => log.level === 'error')).toBe(true);
    r.clock.now += HOUR;
    expect(await r.sender.runOnce()).toBe(0);
    expect(r.sent).toHaveLength(0);
  });

  it('a blocked bot (403) or a wrong token (401) is tried again until the message expires', async () => {
    const r = rig();
    const row = tg('SYSTEM_DEGRADED', 'a', T + 10 * MINUTE);
    await r.store.enqueue([row], r.clock.now);
    r.script.push(
      new TelegramApiError('Forbidden: bot was blocked by the user', 'api', 403, 403, null),
    );
    await r.sender.runOnce();
    expect(r.store.entry(row.eventKey, 'telegram')?.status).toBe('FAILED');
    r.clock.now += 2 * SECOND;
    r.script.push(new TelegramApiError('Unauthorized', 'api', 401, 401, null));
    await r.sender.runOnce();
    expect(r.store.entry(row.eventKey, 'telegram')?.status).toBe('FAILED');
  });

  it('waits while Telegram is not linked, and sends when it is', async () => {
    const r = rig();
    r.chat.id = null;
    const row = tg('SIGNAL_NEW', 'a');
    await r.store.enqueue([row], r.clock.now);
    await r.sender.runOnce();
    expect(r.store.entry(row.eventKey, 'telegram')).toMatchObject({
      status: 'FAILED',
      lastError: 'Telegram is not linked to a chat yet',
    });
    r.chat.id = CHAT;
    r.clock.now += 2 * SECOND;
    await r.sender.runOnce();
    expect(r.store.entry(row.eventKey, 'telegram')?.status).toBe('SENT');
    expect(r.sent).toHaveLength(1);
  });

  it('a chat that cannot be read is a transient failure, not a crash', async () => {
    const r = rig();
    const row = tg('SIGNAL_NEW', 'a');
    await r.store.enqueue([row], r.clock.now);
    const broken = new OutboxSender({
      store: r.store,
      telegram: {
        transport: new TelegramTransport({
          client: { sendMessage: () => Promise.resolve({ messageId: 1 }) },
        }),
        chatId: () => Promise.reject(new Error('db down')),
      },
      now: () => r.clock.now,
    });
    await broken.runOnce();
    expect(r.store.entry(row.eventKey, 'telegram')).toMatchObject({
      status: 'FAILED',
      lastError: 'the linked chat could not be read: db down',
    });
  });

  it('a message without text is dead, not sent empty', async () => {
    const r = rig();
    const bad = outboxRow('SIGNAL_NEW', { channel: 'telegram', payload: {} });
    const empty = outboxRow('SIGNAL_NEW', { channel: 'telegram', payload: { text: '' } });
    await r.store.enqueue([bad, empty], r.clock.now);
    await r.sender.runOnce();
    r.clock.now += SECOND;
    await r.sender.runOnce();
    expect(r.store.entry(bad.eventKey, 'telegram')?.status).toBe('DEAD');
    expect(r.store.entry(empty.eventKey, 'telegram')?.status).toBe('DEAD');
    expect(r.sent).toHaveLength(0);
  });

  it('an error text that is very long is cut', async () => {
    const r = rig();
    const row = tg('SIGNAL_NEW', 'a');
    await r.store.enqueue([row], r.clock.now);
    r.script.push(new Error('x'.repeat(2000)));
    await r.sender.runOnce();
    const text = r.store.entry(row.eventKey, 'telegram')?.lastError ?? '';
    expect(text).toHaveLength(503);
    expect(text.endsWith('...')).toBe(true);
  });
});

describe('expiry', () => {
  it('never sends a message that has expired, and marks it', async () => {
    const r = rig();
    const old = tg('SIGNAL_NEW', 'late', T - 1);
    const edge = tg('SIGNAL_NEW', 'edge', T);
    const fresh = tg('SIGNAL_NEW', 'fresh', T + 1);
    await r.store.enqueue([old, edge, fresh], r.clock.now);
    await r.sender.runOnce();
    expect(r.store.entry(old.eventKey, 'telegram')?.status).toBe('EXPIRED');
    expect(r.store.entry(edge.eventKey, 'telegram')?.status).toBe('EXPIRED');
    expect(r.sent.map((item) => item.text)).toEqual(['fresh']);
    expect(r.sender.stats.expired).toBe(2);
  });

  it('a message without an expiry lives an hour', async () => {
    const r = rig();
    const row = tg('SYSTEM_DEGRADED', 'a', null);
    await r.store.enqueue([row], r.clock.now);
    r.clock.now += HOUR;
    await r.sender.runOnce();
    expect(r.store.entry(row.eventKey, 'telegram')?.status).toBe('EXPIRED');
    expect(r.sent).toHaveLength(0);
  });

  it('a failed message whose next attempt would be after its expiry is dropped at once', async () => {
    const r = rig();
    const row = tg('SIGNAL_NEW', 'a', T + 2 * SECOND);
    await r.store.enqueue([row], r.clock.now);
    r.script.push(new Error('down'));
    await r.sender.runOnce();
    expect(r.store.entry(row.eventKey, 'telegram')).toMatchObject({ status: 'EXPIRED' });
    expect(r.store.entry(row.eventKey, 'telegram')?.lastError).toContain('down');
    expect(r.sender.stats).toMatchObject({ expired: 1, retried: 0 });
  });

  it('a failed message whose time is over before its next attempt is expired, not sent', async () => {
    const r = rig();
    const row = tg('SIGNAL_NEW', 'a', T + 10 * SECOND);
    await r.store.enqueue([row], r.clock.now);
    const claimed = await r.store.claimNext('telegram', r.clock.now);
    await r.store.markFailed(claimed?.id ?? '', T + 5 * SECOND, 'x');
    r.clock.now += 11 * SECOND;
    expect(await r.sender.runOnce()).toBe(0);
    expect(r.store.entry(row.eventKey, 'telegram')?.status).toBe('EXPIRED');
    expect(r.sent).toHaveLength(0);
  });
});

describe('crash and database failures', () => {
  it('takes back a message left sending by a process that died, after the timeout', async () => {
    const r = rig();
    const row = tg('SIGNAL_NEW', 'a');
    await r.store.enqueue([row], r.clock.now);
    await r.store.claimNext('telegram', r.clock.now);
    r.clock.now += 119 * SECOND;
    expect(await r.sender.runOnce()).toBe(0);
    expect(r.store.entry(row.eventKey, 'telegram')?.status).toBe('SENDING');
    expect(r.sender.stats.recovered).toBe(0);
    r.clock.now += 62 * SECOND;
    expect(await r.sender.runOnce()).toBe(1);
    expect(r.store.entry(row.eventKey, 'telegram')).toMatchObject({ status: 'SENT', attempts: 2 });
    expect(r.sender.stats.recovered).toBe(1);
  });

  it('looks for rows left sending only once a minute', async () => {
    const r = rig();
    const spy = vi.spyOn(r.store, 'recoverStuck');
    await r.sender.runOnce();
    r.clock.now += 59_999;
    await r.sender.runOnce();
    expect(spy).toHaveBeenCalledTimes(1);
    r.clock.now += 1;
    await r.sender.runOnce();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(r.clock.now, 120_000);
  });

  it('a database failure ends the pass with an error but loses nothing', async () => {
    const r = rig();
    const row = tg('SIGNAL_NEW', 'a');
    await r.store.enqueue([row], r.clock.now);
    r.store.failNextWrite = true;
    await expect(r.sender.runOnce()).rejects.toThrow('the database is not available');
    // it went out, the result could not be written: the row stays SENDING and comes back (a possible duplicate)
    expect(r.sent).toHaveLength(1);
    expect(r.store.entry(row.eventKey, 'telegram')?.status).toBe('SENDING');
    r.clock.now += 3 * MINUTE;
    await r.sender.runOnce();
    expect(r.sent).toHaveLength(2);
    expect(r.store.entry(row.eventKey, 'telegram')?.status).toBe('SENT');
  });
});

describe('sending to Web Push', () => {
  it('sends to every subscription, records it as sent and notes the time of each browser', async () => {
    const r = rig();
    r.store.addSubscription(SUB);
    r.store.addSubscription(SUB2);
    const row = push('SIGNAL_NEW');
    await r.store.enqueue([row], r.clock.now);
    await r.sender.runOnce();
    expect(r.pushed.map((item) => item.endpoint)).toEqual([SUB.endpoint, SUB2.endpoint]);
    expect(r.pushed[0]?.payload).toEqual(PUSH);
    expect(r.store.entry(row.eventKey, 'webpush')).toMatchObject({
      status: 'SENT',
      sentAt: T,
      providerMessageId: null,
    });
    expect(r.store.lastOk(SUB.endpoint)).toBe(T);
    expect(r.store.lastOk(SUB2.endpoint)).toBe(T);
    expect(r.sender.stats.sent).toBe(1);
  });

  it('is not slowed by the Telegram limit: several messages go in one pass', async () => {
    const r = rig();
    r.store.addSubscription(SUB);
    await r.store.enqueue(
      [push('SIGNAL_NEW'), push('SIGNAL_TP1'), push('SYSTEM_DEGRADED')],
      r.clock.now,
    );
    expect(await r.sender.runOnce()).toBe(3);
    expect(r.pushed).toHaveLength(3);
  });

  it('removes a subscription that is gone and still counts the others', async () => {
    const r = rig();
    r.store.addSubscription(SUB);
    r.store.addSubscription(SUB2);
    r.pushResults.set(SUB.endpoint, { ok: false, gone: true, permanent: false, message: 'gone' });
    const row = push('SIGNAL_NEW');
    await r.store.enqueue([row], r.clock.now);
    await r.sender.runOnce();
    expect((await r.store.list()).map((item) => item.endpoint)).toEqual([SUB2.endpoint]);
    expect(r.store.entry(row.eventKey, 'webpush')?.status).toBe('SENT');
  });

  it('when every subscription is gone nothing was delivered: the row waits, and then there is nobody', async () => {
    const r = rig();
    r.store.addSubscription(SUB);
    r.pushResults.set(SUB.endpoint, { ok: false, gone: true, permanent: false, message: 'gone' });
    const row = push('SIGNAL_NEW');
    await r.store.enqueue([row], r.clock.now);
    await r.sender.runOnce();
    expect(await r.store.list()).toEqual([]);
    expect(r.store.entry(row.eventKey, 'webpush')).toMatchObject({
      status: 'FAILED',
      lastError: 'every Web Push subscription was gone (1 removed)',
    });
  });

  it('waits while no browser is subscribed', async () => {
    const r = rig();
    const row = push('SIGNAL_NEW');
    await r.store.enqueue([row], r.clock.now);
    await r.sender.runOnce();
    expect(r.store.entry(row.eventKey, 'webpush')).toMatchObject({
      status: 'FAILED',
      lastError: 'no browser is subscribed to Web Push',
    });
    r.store.addSubscription(SUB);
    r.clock.now += 2 * SECOND;
    await r.sender.runOnce();
    expect(r.store.entry(row.eventKey, 'webpush')?.status).toBe('SENT');
  });

  it('a transient failure of the push service is retried; one browser that took it is enough', async () => {
    const r = rig();
    r.store.addSubscription(SUB);
    r.pushResults.set(SUB.endpoint, {
      ok: false,
      gone: false,
      permanent: false,
      message: 'push service 503',
    });
    const row = push('SIGNAL_NEW');
    await r.store.enqueue([row], r.clock.now);
    await r.sender.runOnce();
    expect(r.store.entry(row.eventKey, 'webpush')).toMatchObject({
      status: 'FAILED',
      lastError: 'push service 503',
    });
    r.store.addSubscription(SUB2);
    r.clock.now += 2 * SECOND;
    await r.sender.runOnce();
    expect(r.store.entry(row.eventKey, 'webpush')?.status).toBe('SENT');
  });

  it('is dead when every browser refuses the message itself', async () => {
    const r = rig();
    r.store.addSubscription(SUB);
    r.store.addSubscription(SUB2);
    r.pushResults.set(SUB.endpoint, {
      ok: false,
      gone: false,
      permanent: true,
      message: 'payload too large',
    });
    r.pushResults.set(SUB2.endpoint, {
      ok: false,
      gone: false,
      permanent: true,
      message: 'bad request',
    });
    const row = push('SIGNAL_NEW');
    await r.store.enqueue([row], r.clock.now);
    await r.sender.runOnce();
    expect(r.store.entry(row.eventKey, 'webpush')).toMatchObject({
      status: 'DEAD',
      lastError: 'payload too large',
    });
  });

  it('a transient failure of one browser beats a refusal of another: it is tried again', async () => {
    const r = rig();
    r.store.addSubscription(SUB);
    r.store.addSubscription(SUB2);
    r.pushResults.set(SUB.endpoint, {
      ok: false,
      gone: false,
      permanent: true,
      message: 'bad request',
    });
    r.pushResults.set(SUB2.endpoint, {
      ok: false,
      gone: false,
      permanent: false,
      message: 'timeout',
    });
    const row = push('SIGNAL_NEW');
    await r.store.enqueue([row], r.clock.now);
    await r.sender.runOnce();
    expect(r.store.entry(row.eventKey, 'webpush')).toMatchObject({
      status: 'FAILED',
      lastError: 'timeout',
    });
  });

  it('shortens the time to live to what is left before the message expires', async () => {
    const r = rig();
    r.store.addSubscription(SUB);
    await r.store.enqueue(
      [
        push('SIGNAL_NEW', { ...PUSH, ttlSec: 3600 }, T + 90_500),
        push('SIGNAL_TP1', { ...PUSH, ttlSec: 60 }, T + HOUR),
      ],
      r.clock.now,
    );
    await r.sender.runOnce();
    expect(r.pushed.map((item) => item.ttlSec)).toEqual([90, 60]);
  });

  it('drops a message that has less than a second left', async () => {
    const r = rig();
    r.store.addSubscription(SUB);
    const row = push('SIGNAL_NEW', PUSH, T + 999);
    await r.store.enqueue([row], r.clock.now);
    await r.sender.runOnce();
    expect(r.pushed).toHaveLength(0);
    expect(r.store.entry(row.eventKey, 'webpush')?.status).toBe('EXPIRED');
    expect(r.sender.stats.expired).toBe(1);
  });

  it('a row without an expiry gets its hour from the time it was written', async () => {
    const r = rig();
    r.store.addSubscription(SUB);
    await r.store.enqueue([push('SYSTEM_DEGRADED', { ...PUSH, ttlSec: 7200 }, null)], r.clock.now);
    r.clock.now += 10 * MINUTE;
    await r.sender.runOnce();
    expect(r.pushed[0]?.ttlSec).toBe(50 * 60);
  });

  it('a push message that is not complete is dead', async () => {
    const r = rig();
    r.store.addSubscription(SUB);
    const rows = [
      push('SIGNAL_NEW', { ...PUSH, title: undefined }),
      push('SIGNAL_NEW', { ...PUSH, body: 1 }),
      push('SIGNAL_NEW', { ...PUSH, url: null }),
      push('SIGNAL_NEW', { ...PUSH, tag: 5 }),
      push('SIGNAL_NEW', { ...PUSH, ttlSec: '60' }),
      push('SIGNAL_NEW', { ...PUSH, urgency: 'urgent' }),
    ];
    await r.store.enqueue(rows, r.clock.now);
    await r.sender.runOnce();
    for (const row of rows) {
      expect(r.store.entry(row.eventKey, 'webpush')).toMatchObject({
        status: 'DEAD',
        lastError: 'the push message is not complete',
      });
    }
    expect(r.pushed).toHaveLength(0);
  });

  it('accepts every urgency the push services know', async () => {
    const r = rig();
    r.store.addSubscription(SUB);
    const urgencies = ['very-low', 'low', 'normal', 'high'] as const;
    await r.store.enqueue(
      urgencies.map((urgency) => push('SYSTEM_DEGRADED', { ...PUSH, urgency })),
      r.clock.now,
    );
    await r.sender.runOnce();
    expect(r.pushed.map((item) => item.payload.urgency).sort()).toEqual([...urgencies].sort());
  });
});

describe('channels', () => {
  const rowsOf = async (r: Rig) => {
    const telegram = tg('SIGNAL_NEW', 'a');
    const web = push('SIGNAL_NEW');
    await r.store.enqueue([telegram, web], r.clock.now);
    return { telegram, web };
  };

  it('leaves Telegram rows alone when Telegram is not set up', async () => {
    const r = rig({ telegram: false });
    r.store.addSubscription(SUB);
    const rows = await rowsOf(r);
    await r.sender.runOnce();
    expect(r.store.entry(rows.telegram.eventKey, 'telegram')).toMatchObject({
      status: 'PENDING',
      attempts: 0,
    });
    expect(r.store.entry(rows.web.eventKey, 'webpush')?.status).toBe('SENT');
  });

  it('leaves Web Push rows alone when Web Push is not set up', async () => {
    const r = rig({ webpush: false });
    const rows = await rowsOf(r);
    await r.sender.runOnce();
    expect(r.store.entry(rows.web.eventKey, 'webpush')).toMatchObject({
      status: 'PENDING',
      attempts: 0,
    });
    expect(r.store.entry(rows.telegram.eventKey, 'telegram')?.status).toBe('SENT');
  });
});

describe('a signal bot and an alert bot', () => {
  interface Bots {
    readonly clock: { now: number };
    readonly store: MemoryOutboxStore;
    readonly sender: OutboxSender;
    readonly signalBot: { chatId: number | string; text: string; at: number }[];
    readonly alertBot: { chatId: number | string; text: string; at: number }[];
    /** Makes the alert bot refuse (Telegram's 429): the signal bot must not notice. */
    readonly alertScript: (Error | 'ok')[];
  }

  function bots(): Bots {
    const clock = { now: T };
    const store = new MemoryOutboxStore();
    const signalBot: Bots['signalBot'] = [];
    const alertBot: Bots['alertBot'] = [];
    const alertScript: Bots['alertScript'] = [];
    const transportOf = (sent: Bots['signalBot'], script: (Error | 'ok')[]) =>
      new TelegramTransport({
        client: {
          sendMessage: (chatId, text) => {
            const step = script.shift() ?? 'ok';
            if (step !== 'ok') return Promise.reject(step);
            sent.push({ chatId, text, at: clock.now });
            return Promise.resolve({ messageId: sent.length });
          },
        },
        now: () => clock.now,
      });
    const sender = new OutboxSender({
      store,
      telegram: { transport: transportOf(signalBot, []), chatId: () => Promise.resolve(CHAT) },
      alerts: {
        transport: transportOf(alertBot, alertScript),
        chatId: () => Promise.resolve(CHAT),
      },
      now: () => clock.now,
    });
    return { clock, store, sender, signalBot, alertBot, alertScript };
  }

  it('sends the signals and their reports from the signal bot and everything else from the alert bot', async () => {
    const b = bots();
    const kinds: NotificationKind[] = [
      'SIGNAL_NEW',
      'SIGNAL_TP1',
      'SIGNAL_CLOSED',
      'SIGNAL_CANCELLED',
      'SIGNAL_REVIEW_FINAL',
      'DAILY_DIGEST',
      'MONTHLY_REPORT',
      'MARKET_MOVE',
      'NEWS_HEADLINE',
      'NEWS_UPCOMING',
      'NEWS_RELEASED',
      'SYSTEM_DEGRADED',
      'SYSTEM_RECOVERED',
      'ENGINE_PAUSED',
      'STORAGE_WARNING',
      'TEST',
    ];
    await b.store.enqueue(
      kinds.map((kind) => tg(kind, kind)),
      b.clock.now,
    );
    for (const _kind of kinds) {
      await b.sender.runOnce();
      b.clock.now += SECOND;
    }
    expect(b.signalBot.map((item) => item.text).sort()).toEqual(
      [
        'SIGNAL_NEW',
        'SIGNAL_TP1',
        'SIGNAL_CLOSED',
        'SIGNAL_CANCELLED',
        'SIGNAL_REVIEW_FINAL',
        'DAILY_DIGEST',
        'MONTHLY_REPORT',
      ].sort(),
    );
    expect(b.alertBot.map((item) => item.text).sort()).toEqual(
      [
        'MARKET_MOVE',
        'NEWS_HEADLINE',
        'NEWS_UPCOMING',
        'NEWS_RELEASED',
        'SYSTEM_DEGRADED',
        'SYSTEM_RECOVERED',
        'ENGINE_PAUSED',
        'STORAGE_WARNING',
        'TEST',
      ].sort(),
    );
    // both bots write to the same chat
    expect(new Set([...b.signalBot, ...b.alertBot].map((item) => item.chatId))).toEqual(
      new Set([CHAT]),
    );
  });

  it('keeps two rate limits: an entry alert does not wait for the alert bot, nor the reverse', async () => {
    const b = bots();
    await b.store.enqueue(
      [tg('MARKET_MOVE', 'move'), tg('SIGNAL_NEW', 'new'), tg('NEWS_HEADLINE', 'headline')],
      b.clock.now,
    );
    // one pass at one instant: each bot sends one message (its own limit is one a second), neither waits for the other
    expect(await b.sender.runOnce()).toBe(2);
    expect(b.signalBot.map((item) => item.text)).toEqual(['new']);
    expect(b.alertBot.map((item) => item.text)).toEqual(['move']);
    b.clock.now += SECOND;
    expect(await b.sender.runOnce()).toBe(1);
    expect(b.alertBot.map((item) => item.text)).toEqual(['move', 'headline']);
  });

  it('a wait that Telegram asks of the alert bot does not hold back a signal', async () => {
    const b = bots();
    b.alertScript.push(new TelegramApiError('Too Many Requests', 'api', 429, 429, 120));
    await b.store.enqueue([tg('MARKET_MOVE', 'move')], b.clock.now);
    await b.sender.runOnce();
    expect(b.alertBot).toEqual([]);
    b.clock.now += SECOND;
    await b.store.enqueue([tg('SIGNAL_NEW', 'new')], b.clock.now);
    expect(await b.sender.runOnce()).toBe(1);
    expect(b.signalBot.map((item) => item.text)).toEqual(['new']);
  });

  it('without an alert bot one bot tells everything, as before', async () => {
    const r = rig();
    await r.store.enqueue([tg('MARKET_MOVE', 'move'), tg('SIGNAL_NEW', 'new')], r.clock.now);
    for (let i = 0; i < 2; i += 1) {
      await r.sender.runOnce();
      r.clock.now += SECOND;
    }
    expect(r.sent.map((item) => item.text)).toEqual(['new', 'move']);
  });
});

describe('the loop', () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
  });
  afterEach(async () => {
    await r.sender.stop();
  });

  const waitFor = async (check: () => boolean, ms = 3000): Promise<void> => {
    const until = Date.now() + ms;
    while (!check()) {
      if (Date.now() > until) throw new Error('the loop did not get there in time');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  it('sends by itself, wakes at once when told, and stops cleanly', async () => {
    const sender = new OutboxSender({
      store: r.store,
      telegram: {
        transport: new TelegramTransport({
          client: {
            sendMessage: (chatId, text) => {
              r.sent.push({ chatId, text, at: Date.now() });
              return Promise.resolve({ messageId: r.sent.length });
            },
          },
          minGapMs: 0,
        }),
        chatId: () => Promise.resolve(CHAT),
      },
      pollMs: 60_000,
      recoverEveryMs: 60_000,
    });
    sender.start();
    sender.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await r.store.enqueue([tg('SIGNAL_NEW', 'woken', Date.now() + HOUR)], Date.now());
    sender.wake();
    await waitFor(() => r.sent.length === 1);
    await sender.stop();
    // stopped: a wake does nothing and a new row waits
    await r.store.enqueue([tg('SIGNAL_NEW', 'later', Date.now() + HOUR)], Date.now());
    sender.wake();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.sent).toHaveLength(1);
  });

  it('a failing database is logged and the loop goes on', async () => {
    const logs: string[] = [];
    let fail = true;
    const store = new MemoryOutboxStore();
    const real = store.expireOverdue.bind(store);
    store.expireOverdue = (now) =>
      fail ? Promise.reject(new Error('connection lost')) : real(now);
    const sender = new OutboxSender({
      store,
      telegram: {
        transport: new TelegramTransport({
          client: {
            sendMessage: (chatId, text) => {
              r.sent.push({ chatId, text, at: Date.now() });
              return Promise.resolve({ messageId: 1 });
            },
          },
          minGapMs: 0,
        }),
        chatId: () => Promise.resolve(CHAT),
      },
      pollMs: 5,
      log: (level, message, details) => logs.push(`${level}: ${message} ${String(details?.error)}`),
    });
    await store.enqueue([tg('SIGNAL_NEW', 'a', Date.now() + HOUR)], Date.now());
    sender.start();
    await waitFor(() => sender.stats.errors >= 1);
    expect(logs[0]).toBe('error: the outbox sender could not finish a pass connection lost');
    expect(r.sent).toHaveLength(0);
    // after a failed pass the loop waits (2 s at least): it does not spin on a dead database
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sender.stats.errors).toBe(1);
    fail = false;
    sender.wake();
    await waitFor(() => r.sent.length === 1, 5000);
    await sender.stop();
  });
});

describe('the options', () => {
  it('refuses settings that are not positive whole numbers', () => {
    const store = new MemoryOutboxStore();
    for (const change of [
      { pollMs: 0 },
      { pollMs: 1.5 },
      { sendingTimeoutMs: -1 },
      { recoverEveryMs: 0 },
      { webpushBatch: 0 },
      { webpushBatch: 2.5 },
    ]) {
      expect(() => new OutboxSender({ store, ...change })).toThrow(RangeError);
    }
  });

  it('limits how many Web Push messages one pass sends', async () => {
    const store = new MemoryOutboxStore();
    store.addSubscription(SUB);
    let count = 0;
    const sender = new OutboxSender({
      store,
      webpush: {
        subscriptions: store,
        sink: {
          send: () => {
            count += 1;
            return Promise.resolve({ ok: true });
          },
        },
      },
      webpushBatch: 2,
      now: () => T,
    });
    await store.enqueue([push('SIGNAL_NEW'), push('SIGNAL_NEW'), push('SIGNAL_NEW')], T);
    expect(await sender.runOnce()).toBe(2);
    expect(count).toBe(2);
    expect(await sender.runOnce()).toBe(1);
  });
});

describe('against a Telegram on a real port', () => {
  const TOKEN = '123456:abcdefghijklmnopqrstuvwxyzABCDEFGHI';
  let server: FakeTelegram;

  beforeEach(async () => {
    server = new FakeTelegram({ token: TOKEN, minGapMs: 40, pollScale: 0.05 });
    await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  it('delivers in order, survives a 429 and a dropped connection, and never breaks the limit of its chat', async () => {
    const store = new MemoryOutboxStore();
    const client = new TelegramClient({ token: TOKEN, baseUrl: server.baseUrl, timeoutMs: 5000 });
    const sender = new OutboxSender({
      store,
      telegram: {
        transport: new TelegramTransport({ client, minGapMs: 50 }),
        chatId: () => Promise.resolve(CHAT),
      },
      pollMs: 5,
    });
    const now = Date.now();
    await store.enqueue(
      [
        tg('SYSTEM_DEGRADED', 'system', now + HOUR),
        tg('SIGNAL_CLOSED', 'closed', now + HOUR),
        tg('SIGNAL_NEW', 'new', now + HOUR),
      ],
      now,
    );
    server.next('sendMessage', { type: 'drop' });
    server.next('sendMessage', {
      type: 'error',
      status: 429,
      description: 'Too Many Requests',
      retryAfter: 1,
    });
    sender.start();
    const until = Date.now() + 8000;
    while (store.entries().some((row) => row.status !== 'SENT') && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await sender.stop();
    expect(store.entries().map((row) => row.status)).toEqual(['SENT', 'SENT', 'SENT']);
    expect(server.textsTo(CHAT).sort()).toEqual(['closed', 'new', 'system']);
    expect(sender.stats.retried).toBe(2);
    // the 429 closed the transport for a second, and the limit of the chat was never broken
    // (the fake answers 429 when two messages come less than 40 ms apart, and there were only the two planned failures)
    const times = server.sent.map((message) => message.at).sort((a, b) => a - b);
    const gaps = times.slice(1).map((time, index) => time - (times[index] ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(40);
  }, 15_000);
});
