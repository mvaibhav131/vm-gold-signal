import { testEventKey, type OutboxRow } from '@vmgs/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { query } from '../../../../packages/db/test/database';
import { telegramLink, telegramTest } from '../cli/telegram';
import { createPgWorld, type PgWorld } from '../lifecycle/pgHarness';
import { STRATEGY } from '../lifecycle/test-data';
import { FakeTelegram } from '../testing/fakeTelegram';
import { TelegramBot } from '../telegram/bot';
import { TelegramClient } from '../telegram/client';
import { formatLinkCode } from '../telegram/link';
import { PostgresBotStore } from '../telegram/postgresBotStore';
import { TelegramTransport } from '../telegram/transport';
import { PostgresOutboxStore } from './postgresOutboxStore';
import { OutboxSender } from './sender';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

const TOKEN = '777:int-token';
const OWNER = 7001;
const STRANGER = 7002;

let world: PgWorld;
let fake: FakeTelegram;

beforeAll(async () => {
  world = await createPgWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  await query(world.database.url, 'DELETE FROM notification_outbox');
  await query(
    world.database.url,
    "DELETE FROM app_settings WHERE key IN ('telegramChat', 'telegramLink', 'engine')",
  );
});

afterEach(async () => {
  await fake.stop();
});

interface Rig {
  readonly clock: { now: number };
  readonly outbox: PostgresOutboxStore;
  readonly store: PostgresBotStore;
  readonly client: TelegramClient;
  readonly sender: OutboxSender;
  readonly bot: TelegramBot;
}

async function build(options: { minGapMs?: number; fakeGapMs?: number } = {}): Promise<Rig> {
  fake = new FakeTelegram({
    token: TOKEN,
    pollScale: 0.01,
    ...(options.fakeGapMs === undefined ? {} : { minGapMs: options.fakeGapMs }),
  });
  await fake.start();
  const clock = { now: Date.now() };
  const client = new TelegramClient({ token: TOKEN, baseUrl: fake.baseUrl, timeoutMs: 3000 });
  const transport = new TelegramTransport({
    client,
    minGapMs: options.minGapMs ?? 0,
    now: () => clock.now,
  });
  const outbox = new PostgresOutboxStore(world.pool);
  const store = new PostgresBotStore(world.pool);
  const sender = new OutboxSender({
    store: outbox,
    telegram: { transport, chatId: () => store.linkedChat() },
    now: () => clock.now,
  });
  const bot = new TelegramBot({
    client,
    transport,
    store,
    outbox,
    settings: () => world.store.loadSettings(),
    now: () => clock.now,
    pollTimeoutS: 1,
  });
  return { clock, outbox, store, client, sender, bot };
}

async function linkOwner(rig: Rig): Promise<void> {
  const code = await telegramLink({
    store: rig.store,
    client: rig.client,
    now: rig.clock.now,
    print: () => undefined,
  });
  fake.pushMessage(OWNER, `/link ${formatLinkCode(code)}`);
  await rig.bot.poll();
  expect(await rig.store.linkedChat()).toBe(OWNER);
}

async function statusOf(eventKey: string): Promise<{ status: string; attempts: number } | null> {
  const [row] = await query<{ status: string; attempts: number }>(
    world.database.url,
    "SELECT status, attempts FROM notification_outbox WHERE event_key = $1 AND channel = 'telegram'",
    [eventKey],
  );
  return row ?? null;
}

const row = (key: string, text: string, expiresAt: number | null): OutboxRow => ({
  eventKey: key,
  channel: 'telegram',
  kind: 'TEST',
  signalId: null,
  payload: { text, level: 0, dropped: [] },
  expiresAt,
});

describe('alerts on PostgreSQL with a fake Telegram', () => {
  it('links the owner with the one-time code and then delivers the test message once', async () => {
    const rig = await build();
    await linkOwner(rig);
    expect(fake.textsTo(OWNER)[0]).toContain('Linked');

    const settings = await world.store.loadSettings();
    const base = { outbox: rig.outbox, settings, now: rig.clock.now, print: () => undefined };
    await telegramTest({ ...base, id: 'int-1' });
    await telegramTest({ ...base, id: 'int-1' });
    await rig.sender.runOnce();
    await rig.sender.runOnce();

    const texts = fake.textsTo(OWNER);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain('TEST');
    expect(fake.sent.every((message) => message.parseMode === 'HTML')).toBe(true);
    expect(await statusOf(testEventKey('int-1'))).toEqual({ status: 'SENT', attempts: 1 });
  });

  it('serves only the owner: another chat cannot pause, resume or even get an answer', async () => {
    const rig = await build();
    await linkOwner(rig);
    const before = fake.sent.length;
    for (const text of ['/pause', '/resume', '/status', '/help', '/link 12345678']) {
      fake.pushMessage(STRANGER, text);
      await rig.bot.poll();
    }
    expect(fake.sent.length).toBe(before);
    expect(await rig.store.engine()).toEqual({ status: 'RUNNING' });
    expect(await rig.store.linkedChat()).toBe(OWNER);
  });

  it('keeps the pause in the database for the owner and takes it back', async () => {
    const rig = await build();
    await linkOwner(rig);
    fake.pushMessage(OWNER, '/pause 30');
    await rig.bot.poll();
    expect(await rig.store.engine()).toEqual({
      status: 'PAUSED',
      since: rig.clock.now,
      until: rig.clock.now + 30 * 60_000,
    });
    fake.pushMessage(OWNER, '/resume');
    await rig.bot.poll();
    expect(await rig.store.engine()).toEqual({ status: 'RUNNING' });
    expect(fake.textsTo(OWNER).slice(-2)).toEqual([
      expect.stringContaining('ENGINE PAUSED'),
      expect.stringContaining('ENGINE RESUMED'),
    ]);
  });

  it('answers /status from the real tables', async () => {
    const rig = await build();
    await linkOwner(rig);
    await world.store.ensureStrategyVersion(STRATEGY);
    fake.pushMessage(OWNER, '/status');
    await rig.bot.poll();
    const text = fake.textsTo(OWNER).at(-1) ?? '';
    expect(text).toContain('STATUS');
    expect(text).toContain('Trend Pullback');
    expect(text).toContain('Open signals: 0');
  });

  it('holds a message while no chat is linked, and sends it once one is', async () => {
    const rig = await build();
    const settings = await world.store.loadSettings();
    await telegramTest({
      outbox: rig.outbox,
      settings,
      now: rig.clock.now,
      id: 'early',
      print: () => undefined,
    });
    await rig.sender.runOnce();
    expect(fake.sent).toHaveLength(0);
    expect(await statusOf(testEventKey('early'))).toMatchObject({ status: 'FAILED' });

    await linkOwner(rig);
    rig.clock.now += 3000;
    await rig.sender.runOnce();
    expect(fake.textsTo(OWNER).at(-1)).toContain('TEST');
    expect(await statusOf(testEventKey('early'))).toMatchObject({ status: 'SENT' });
  });

  it('retries after a server error with the backoff, and sends once', async () => {
    const rig = await build();
    await linkOwner(rig);
    await rig.outbox.enqueue(
      [row('retry-1', 'RETRY ME', rig.clock.now + 3_600_000)],
      rig.clock.now,
    );
    fake.next('sendMessage', { type: 'error', status: 500, description: 'Internal Server Error' });
    await rig.sender.runOnce();
    expect(await statusOf('retry-1')).toEqual({ status: 'FAILED', attempts: 1 });
    await rig.sender.runOnce();
    expect(fake.textsTo(OWNER)).not.toContain('RETRY ME');

    rig.clock.now += 2001;
    await rig.sender.runOnce();
    expect(fake.textsTo(OWNER).filter((text) => text === 'RETRY ME')).toHaveLength(1);
    expect(await statusOf('retry-1')).toEqual({ status: 'SENT', attempts: 2 });
  });

  it('never sends a message after it expired', async () => {
    const rig = await build();
    await linkOwner(rig);
    await rig.outbox.enqueue([row('late-1', 'TOO LATE', rig.clock.now + 1000)], rig.clock.now);
    rig.clock.now += 1001;
    await rig.sender.runOnce();
    expect(fake.textsTo(OWNER)).not.toContain('TOO LATE');
    expect(await statusOf('late-1')).toMatchObject({ status: 'EXPIRED' });
  });

  it('spaces messages so that Telegram never answers 429', async () => {
    const rig = await build({ minGapMs: 60, fakeGapMs: 50 });
    await linkOwner(rig);
    for (let i = 0; i < 5; i += 1) {
      await rig.outbox.enqueue(
        [row(`burst-${String(i)}`, `BURST ${String(i)}`, rig.clock.now + 3_600_000)],
        rig.clock.now - 10 + i,
      );
    }
    const startedAt = Date.now();
    while (fake.textsTo(OWNER).filter((text) => text.startsWith('BURST')).length < 5) {
      rig.clock.now = Date.now();
      await rig.sender.runOnce();
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (Date.now() - startedAt > 5000) throw new Error('the burst was not delivered');
    }
    const bursts = fake.sent.filter((message) => message.text.startsWith('BURST'));
    expect(bursts.map((message) => message.text)).toEqual([
      'BURST 0',
      'BURST 1',
      'BURST 2',
      'BURST 3',
      'BURST 4',
    ]);
    for (let i = 1; i < bursts.length; i += 1) {
      expect((bursts[i]?.at ?? 0) - (bursts[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(50);
    }
    expect(rig.sender.stats.retried).toBe(0);
  });
});
