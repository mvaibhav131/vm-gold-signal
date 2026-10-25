import { defaultSettings } from '@vmgs/config';
import { testEventKey, type AlertSettings } from '@vmgs/core';
import { afterEach, describe, expect, it } from 'vitest';

import { FakeTelegram } from '../testing/fakeTelegram';
import { MemoryBotStore } from '../testing/memoryBotStore';
import { MemoryOutboxStore } from '../testing/memoryOutboxStore';
import { TelegramClient } from '../telegram/client';
import { checkLink, LINK_TTL_MS } from '../telegram/link';
import { telegramLink, telegramTest } from './telegram';

const NOW = Date.parse('2026-10-23T10:00:00Z');
let fake: FakeTelegram | null = null;

afterEach(async () => {
  await fake?.stop();
  fake = null;
});

async function client(username = 'VmGoldBot'): Promise<TelegramClient> {
  fake = new FakeTelegram({ token: 'tok:en', username });
  await fake.start();
  return new TelegramClient({ token: 'tok:en', baseUrl: fake.baseUrl, timeoutMs: 2000 });
}

describe('telegram:link', () => {
  it('keeps a hash of the code and prints the code with the link to the bot', async () => {
    const store = new MemoryBotStore();
    const lines: string[] = [];
    const code = await telegramLink({
      store,
      client: await client(),
      now: NOW,
      print: (line) => lines.push(line),
      code: '01234567',
    });
    expect(code).toBe('01234567');
    expect(lines[0]).toBe('One-time code: 0123-4567');
    expect(lines.join('\n')).toContain('https://t.me/VmGoldBot and send: /link 0123-4567');
    expect(lines.join('\n')).toContain('10 minutes');
    expect(JSON.stringify(store.pending)).not.toContain('01234567');
    expect(store.pending?.expiresAt).toBe(NOW + LINK_TTL_MS);
    expect(store.pending && checkLink(store.pending, '01234567', NOW).ok).toBe(true);
  });

  it('makes a new random code each time when none is given', async () => {
    const store = new MemoryBotStore();
    const web = await client();
    const print = () => undefined;
    const first = await telegramLink({ store, client: web, now: NOW, print });
    const second = await telegramLink({ store, client: web, now: NOW, print });
    expect(first).toMatch(/^\d{8}$/);
    expect(second).not.toBe(first);
    expect(store.pending && checkLink(store.pending, second, NOW).ok).toBe(true);
    expect(store.pending && checkLink(store.pending, first, NOW).ok).toBe(false);
  });

  it('refuses before it makes a code when Telegram does not accept the token', async () => {
    const store = new MemoryBotStore();
    const lines: string[] = [];
    const web = await client();
    fake?.next('getMe', { type: 'error', status: 401, description: 'Unauthorized' });
    await expect(
      telegramLink({ store, client: web, now: NOW, print: (line) => lines.push(line) }),
    ).rejects.toThrow(/Unauthorized/);
    expect(store.pending).toBeNull();
    expect(lines).toEqual([]);
  });
});

describe('telegram:test', () => {
  const settings = defaultSettings() as AlertSettings;

  it('queues the TEST message for Telegram', async () => {
    const outbox = new MemoryOutboxStore();
    const lines: string[] = [];
    const channels = await telegramTest({
      outbox,
      settings,
      now: NOW,
      id: 'abc',
      print: (line) => lines.push(line),
    });
    expect(channels).toBe(1);
    const [row] = outbox.entries();
    expect(row).toMatchObject({
      channel: 'telegram',
      kind: 'TEST',
      eventKey: testEventKey('abc'),
      signalId: null,
      status: 'PENDING',
      expiresAt: NOW + 3_600_000,
    });
    expect(String(row?.payload.text)).toContain('TEST');
    expect(lines[0]).toContain('telegram');
  });

  it('queues it once for one id, and again for a new one', async () => {
    const outbox = new MemoryOutboxStore();
    const base = { outbox, settings, now: NOW, print: () => undefined };
    await telegramTest({ ...base, id: 'one' });
    await telegramTest({ ...base, id: 'one' });
    expect(outbox.entries()).toHaveLength(1);
    await telegramTest({ ...base, id: 'two' });
    expect(outbox.entries()).toHaveLength(2);
  });

  it('queues it for Web Push too when that is on', async () => {
    const outbox = new MemoryOutboxStore();
    const channels = await telegramTest({
      outbox,
      settings: {
        ...settings,
        alerts: { ...settings.alerts, webpush: { enabled: true, minGrade: 'Moderate' } },
      },
      now: NOW,
      id: 'abc',
      print: () => undefined,
    });
    expect(channels).toBe(2);
    expect(outbox.entries().map((row) => row.channel)).toEqual(['telegram', 'webpush']);
  });

  it('says so when no channel is on', async () => {
    const outbox = new MemoryOutboxStore();
    const lines: string[] = [];
    const channels = await telegramTest({
      outbox,
      settings: {
        ...settings,
        alerts: { ...settings.alerts, telegram: { ...settings.alerts.telegram, enabled: false } },
      },
      now: NOW,
      id: 'abc',
      print: (line) => lines.push(line),
    });
    expect(channels).toBe(0);
    expect(outbox.entries()).toHaveLength(0);
    expect(lines[0]).toContain('No channel is switched on');
  });
});
