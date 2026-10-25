import { defaultSettings } from '@vmgs/config';
import { engineEventKey, pauseIdOf, type AlertSettings, type PeriodRow } from '@vmgs/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeTelegram } from '../testing/fakeTelegram';
import { MemoryBotStore } from '../testing/memoryBotStore';
import { MemoryOutboxStore } from '../testing/memoryOutboxStore';
import { TelegramBot } from './bot';
import type { OpenSignalRow } from './botStore';
import { TelegramClient } from './client';
import { issueLink, LINK_MAX_ATTEMPTS, LINK_TTL_MS } from './link';
import { TelegramTransport } from './transport';

const TOKEN = '123456:bot-token';
const OWNER = 5001;
const STRANGER = 9009;
// 2026-10-23 10:00 UTC = 15:30 in Kolkata
const NOW = Date.parse('2026-10-23T10:00:00Z');

interface Rig {
  readonly fake: FakeTelegram;
  readonly store: MemoryBotStore;
  readonly outbox: MemoryOutboxStore;
  readonly bot: TelegramBot;
  readonly clock: { now: number };
  readonly settings: { value: AlertSettings };
  readonly queued: { count: number };
  readonly logs: { level: string; message: string }[];
}

let fake: FakeTelegram;

async function build(
  options: { feed?: boolean; retryMs?: number; username?: string } = {},
): Promise<Rig> {
  fake = new FakeTelegram({
    token: TOKEN,
    username: options.username ?? 'VmGoldBot',
    pollScale: 0.01,
  });
  await fake.start();
  const client = new TelegramClient({ token: TOKEN, baseUrl: fake.baseUrl, timeoutMs: 2000 });
  const clock = { now: NOW };
  const store = new MemoryBotStore();
  const outbox = new MemoryOutboxStore();
  const settings = { value: defaultSettings() as AlertSettings };
  const queued = { count: 0 };
  const logs: Rig['logs'] = [];
  const bot = new TelegramBot({
    client,
    transport: new TelegramTransport({ client, minGapMs: 0 }),
    store,
    outbox,
    settings: () => Promise.resolve(settings.value),
    ...(options.feed === true
      ? { feed: () => ({ state: 'LIVE' as const, tickAgeMs: 1500, spread: 0.3 }) }
      : {}),
    onQueued: () => {
      queued.count += 1;
    },
    now: () => clock.now,
    pollTimeoutS: 1,
    retryMs: options.retryMs ?? 5,
    log: (level, message) => logs.push({ level, message }),
  });
  return { fake, store, outbox, bot, clock, settings, queued, logs };
}

/** Pushes a message into the fake and lets the bot read it. */
async function say(rig: Rig, chatId: number, text: string, chatType = 'private'): Promise<void> {
  rig.fake.pushMessage(chatId, text, { chatType });
  await rig.bot.poll();
}

afterEach(async () => {
  await fake.stop();
});

describe('owner only', () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await build();
    rig.store.chat = OWNER;
  });

  it('answers the linked chat', async () => {
    await say(rig, OWNER, '/help');
    expect(rig.fake.textsTo(OWNER)).toHaveLength(1);
    expect(rig.fake.textsTo(OWNER)[0]).toContain('/status');
  });

  it('does not answer another chat, whatever it asks', async () => {
    for (const text of [
      '/help',
      '/status',
      '/open',
      '/pause',
      '/resume',
      '/start',
      '/foo',
      '/last',
    ]) {
      await say(rig, STRANGER, text);
    }
    expect(rig.fake.sent).toHaveLength(0);
    expect(rig.store.state).toEqual({ status: 'RUNNING' });
  });

  it('does not let another chat pause the engine', async () => {
    await say(rig, STRANGER, '/pause 30');
    expect(rig.store.state).toEqual({ status: 'RUNNING' });
    expect(rig.outbox.entries()).toHaveLength(0);
  });

  it('serves nobody while no chat is linked', async () => {
    rig.store.chat = null;
    await say(rig, OWNER, '/help');
    await say(rig, OWNER, '/start');
    expect(rig.fake.sent).toHaveLength(0);
  });

  it('ignores a group, even one with the same id as the owner', async () => {
    await say(rig, OWNER, '/help', 'group');
    await say(rig, OWNER, '/help', 'supergroup');
    expect(rig.fake.sent).toHaveLength(0);
  });

  it('does not talk back to ordinary text or to updates that are not text', async () => {
    await say(rig, OWNER, 'hello there');
    rig.fake.pushOther();
    await rig.bot.poll();
    expect(rig.fake.sent).toHaveLength(0);
    expect(rig.bot.stats.ignored).toBe(2);
  });

  it('takes a command for this bot and not one for another bot', async () => {
    await say(rig, OWNER, '/help@OtherBot');
    expect(rig.fake.sent).toHaveLength(0);
    await say(rig, OWNER, '/help@VmGoldBot');
    expect(rig.fake.sent).toHaveLength(1);
  });

  it('says it does not know a command', async () => {
    await say(rig, OWNER, '/nope');
    expect(rig.fake.textsTo(OWNER)[0]).toContain('/nope');
  });

  it('answers in the language of the settings', async () => {
    rig.settings.value = { ...rig.settings.value, locale: 'hinglish' };
    await say(rig, OWNER, '/start');
    expect(rig.fake.textsTo(OWNER)[0]).toContain('Is chat par alerts aayenge');
  });
});

describe('/link', () => {
  let rig: Rig;
  const CODE = '12345678';
  beforeEach(async () => {
    rig = await build();
  });

  it('is silent when no code was asked for', async () => {
    await say(rig, STRANGER, `/link ${CODE}`);
    expect(rig.fake.sent).toHaveLength(0);
    expect(rig.store.chat).toBeNull();
  });

  it('links the chat that sends the right code, once', async () => {
    rig.store.pending = issueLink(CODE, NOW);
    await say(rig, OWNER, '/link 1234-5678');
    expect(rig.store.chat).toBe(OWNER);
    expect(rig.store.pending).toBeNull();
    expect(rig.fake.textsTo(OWNER)[0]).toContain('Linked');
    await say(rig, STRANGER, `/link ${CODE}`);
    expect(rig.store.chat).toBe(OWNER);
    expect(rig.fake.textsTo(STRANGER)).toHaveLength(0);
  });

  it('serves the owner right after linking', async () => {
    rig.store.pending = issueLink(CODE, NOW);
    await say(rig, OWNER, `/link ${CODE}`);
    await say(rig, OWNER, '/help');
    expect(rig.fake.textsTo(OWNER)).toHaveLength(2);
  });

  it('refuses a wrong code and counts it', async () => {
    rig.store.pending = issueLink(CODE, NOW);
    await say(rig, STRANGER, '/link 00000000');
    expect(rig.store.chat).toBeNull();
    expect(rig.store.pending).toMatchObject({ attempts: 1 });
    expect(rig.fake.textsTo(STRANGER)[0]).toContain('not valid');
  });

  it('burns the code after too many wrong guesses, even for the right code after that', async () => {
    rig.store.pending = issueLink(CODE, NOW);
    for (let i = 0; i < LINK_MAX_ATTEMPTS; i += 1) await say(rig, STRANGER, '/link 00000000');
    expect(rig.store.pending).toBeNull();
    await say(rig, OWNER, `/link ${CODE}`);
    expect(rig.store.chat).toBeNull();
  });

  it('refuses an expired code and forgets it', async () => {
    rig.store.pending = issueLink(CODE, NOW);
    rig.clock.now = NOW + LINK_TTL_MS;
    await say(rig, OWNER, `/link ${CODE}`);
    expect(rig.store.chat).toBeNull();
    expect(rig.store.pending).toBeNull();
    expect(rig.fake.textsTo(OWNER)[0]).toContain('not valid');
  });

  it('answers a malformed code without counting it as a guess', async () => {
    rig.store.pending = issueLink(CODE, NOW);
    await say(rig, OWNER, '/link abc');
    await say(rig, OWNER, '/link');
    expect(rig.store.pending).toMatchObject({ attempts: 0 });
    expect(rig.fake.textsTo(OWNER)).toHaveLength(2);
  });

  it('moves the link to a new chat with a new code', async () => {
    rig.store.chat = OWNER;
    rig.store.pending = issueLink(CODE, NOW);
    await say(rig, STRANGER, `/link ${CODE}`);
    expect(rig.store.chat).toBe(STRANGER);
    await say(rig, OWNER, '/help');
    expect(rig.fake.textsTo(OWNER)).toHaveLength(0);
  });
});

describe('/pause and /resume', () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await build();
    rig.store.chat = OWNER;
  });

  it('pauses until resume and tells the owner once', async () => {
    await say(rig, OWNER, '/pause');
    expect(rig.store.state).toEqual({ status: 'PAUSED', since: NOW, until: null });
    const texts = rig.fake.textsTo(OWNER);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('ENGINE PAUSED');
    expect(rig.outbox.entries()).toHaveLength(0);
  });

  it('pauses for the minutes given', async () => {
    await say(rig, OWNER, '/pause 30');
    expect(rig.store.state).toEqual({ status: 'PAUSED', since: NOW, until: NOW + 30 * 60_000 });
    expect(rig.fake.textsTo(OWNER)[0]).toContain('16:00 IST');
  });

  it.each(['/pause 0', '/pause abc', '/pause 10081', '/pause 5 6', '/pause -3'])(
    'explains %s and changes nothing',
    async (text) => {
      await say(rig, OWNER, text);
      expect(rig.store.state).toEqual({ status: 'RUNNING' });
      expect(rig.fake.textsTo(OWNER)).toHaveLength(1);
      expect(rig.fake.textsTo(OWNER)[0]).toContain('/pause');
    },
  );

  it('says it is already paused and keeps the first pause', async () => {
    await say(rig, OWNER, '/pause');
    rig.clock.now = NOW + 60_000;
    await say(rig, OWNER, '/pause 5');
    expect(rig.store.state).toEqual({ status: 'PAUSED', since: NOW, until: null });
    expect(rig.fake.textsTo(OWNER)[1]).toContain('already paused');
  });

  it('pauses again when a timed pause has run out', async () => {
    await say(rig, OWNER, '/pause 1');
    rig.clock.now = NOW + 61_000;
    await say(rig, OWNER, '/pause');
    expect(rig.store.state).toEqual({ status: 'PAUSED', since: NOW + 61_000, until: null });
  });

  it('resumes', async () => {
    await say(rig, OWNER, '/pause');
    await say(rig, OWNER, '/resume');
    expect(rig.store.state).toEqual({ status: 'RUNNING' });
    expect(rig.fake.textsTo(OWNER)[1]).toContain('ENGINE RESUMED');
  });

  it('says so when there is nothing to resume, also after a timed pause ended', async () => {
    await say(rig, OWNER, '/resume');
    expect(rig.fake.textsTo(OWNER)[0]).toContain('not paused');
    await say(rig, OWNER, '/pause 1');
    rig.clock.now = NOW + 61_000;
    await say(rig, OWNER, '/resume');
    expect(rig.fake.textsTo(OWNER)[2]).toContain('not paused');
  });

  it('queues the pause for Web Push under one event key, and wakes the sender', async () => {
    rig.settings.value = {
      ...rig.settings.value,
      alerts: { ...rig.settings.value.alerts, webpush: { enabled: true, minGrade: 'Moderate' } },
    };
    await say(rig, OWNER, '/pause 30');
    const rows = rig.outbox.entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'webpush',
      kind: 'ENGINE_PAUSED',
      eventKey: engineEventKey(pauseIdOf(NOW)),
      signalId: null,
      expiresAt: NOW + 3_600_000,
    });
    expect(rig.queued.count).toBe(1);
    expect(rig.fake.textsTo(OWNER)).toHaveLength(1);
  });

  it('does not queue anything while Web Push is off', async () => {
    await say(rig, OWNER, '/pause');
    expect(rig.outbox.entries()).toHaveLength(0);
    expect(rig.queued.count).toBe(0);
  });
});

describe('/status', () => {
  it('shows the feed, the engine, the strategies and the open risk', async () => {
    const rig = await build({ feed: true });
    rig.store.chat = OWNER;
    rig.store.facts = {
      nextHigh: { name: 'US CPI', at: NOW + 3_600_000 },
      calendarAvailable: true,
      openStatuses: ['ACTIVE', 'TP1_HIT'],
      strategies: [{ key: 'trend_pullback', version: '1.0.0', status: 'FORWARD_TESTING' }],
    };
    await say(rig, OWNER, '/status');
    const text = rig.fake.textsTo(OWNER)[0] ?? '';
    expect(text).toContain('LIVE');
    expect(text).toContain('US CPI');
    expect(text).toContain('Trend');
    expect(text).toContain('1.0.0');
    expect(text).toContain('Open signals: 2, open risk 1.00R');
  });

  it('says the feed state is not available without a feed, and shows a pause', async () => {
    const rig = await build();
    rig.store.chat = OWNER;
    rig.store.state = { status: 'PAUSED', since: NOW - 600_000, until: null };
    await say(rig, OWNER, '/status');
    const text = rig.fake.textsTo(OWNER)[0] ?? '';
    expect(text).toContain('PAUSED since 15:20 IST');
  });

  it('shows a timed pause that has run out as running', async () => {
    const rig = await build();
    rig.store.chat = OWNER;
    rig.store.state = { status: 'PAUSED', since: NOW - 600_000, until: NOW - 1 };
    await say(rig, OWNER, '/status');
    expect(rig.fake.textsTo(OWNER)[0]).not.toContain('paused since');
  });

  it('marks a strategy whose alerts are off', async () => {
    const rig = await build();
    rig.store.chat = OWNER;
    rig.store.facts = {
      nextHigh: null,
      calendarAvailable: true,
      openStatuses: [],
      strategies: [
        { key: 'trend_pullback', version: '1.0.0', status: 'FORWARD_TESTING' },
        { key: 'pattern_breakout', version: '1.0.0', status: 'FORWARD_TESTING' },
      ],
    };
    await say(rig, OWNER, '/status');
    const text = rig.fake.textsTo(OWNER)[0] ?? '';
    expect(text).toContain('Trend Pullback v1.0.0: FORWARD TESTING, alerts on');
    expect(text).toContain('Chart Pattern Breakout v1.0.0: FORWARD TESTING, alerts off (shadow)');
  });

  it('says the next event is unknown, not "none known", when the calendar feed is down', async () => {
    const rig = await build();
    rig.store.chat = OWNER;
    rig.store.facts = {
      nextHigh: null,
      calendarAvailable: false,
      openStatuses: [],
      strategies: [],
    };
    await say(rig, OWNER, '/status');
    const text = rig.fake.textsTo(OWNER)[0] ?? '';
    expect(text).toContain('Next HIGH-impact event: unknown (the calendar feed is unavailable)');
    expect(text).not.toContain('none known');
  });
});

describe('/open', () => {
  const buy: OpenSignalRow = {
    seq: 42,
    side: 'BUY',
    strategyKey: 'trend_pullback',
    exitProfile: 'EP1_PARTIAL',
    status: 'ACTIVE',
    entry: 4000,
    stop: 3995,
    tp1: 4010,
    tp2: 4020,
    riskDistance: 5,
    timeStopAt: NOW + 3_600_000,
  };

  it('says there is no open signal', async () => {
    const rig = await build();
    rig.store.chat = OWNER;
    await say(rig, OWNER, '/open');
    expect(rig.fake.textsTo(OWNER)[0]).toMatch(/no open/i);
  });

  it('shows the live R of a BUY at the bid and of a SELL at the ask', async () => {
    const rig = await build();
    rig.store.chat = OWNER;
    rig.store.openRows = [
      buy,
      { ...buy, seq: 43, side: 'SELL', entry: 4000, stop: 4005, tp1: 3990, tp2: 3980 },
    ];
    rig.store.latestQuote = { bid: 4005, ask: 4006 };
    await say(rig, OWNER, '/open');
    const text = rig.fake.textsTo(OWNER)[0] ?? '';
    expect(text).toContain('S-0042');
    expect(text).toContain('S-0043');
    expect(text).toContain('+1.00R');
    expect(text).toContain('-1.20R');
    expect(rig.store.quoteAges).toEqual([120_000]);
  });

  it('does not make up a result without a price', async () => {
    const rig = await build();
    rig.store.chat = OWNER;
    rig.store.openRows = [buy];
    rig.store.latestQuote = null;
    await say(rig, OWNER, '/open');
    const text = rig.fake.textsTo(OWNER)[0] ?? '';
    expect(text).toContain('S-0042');
    expect(text).not.toMatch(/[+-]\d\.\dR/);
  });
});

describe('/last, /today and /month', () => {
  const row = (seq: number, result: PeriodRow['result'], net: number | null): PeriodRow => ({
    seq,
    side: 'BUY',
    strategyKey: 'trend_pullback',
    generatedAt: NOW - 3_600_000,
    result,
    countsInStats: result !== null,
    realizedRNet: net,
    durationS: 900,
    tp1Hit: result === 'WIN',
    tp2Hit: result === 'WIN',
    closedAt: NOW - 1_800_000,
    primaryCause: null,
  });

  it('sends the messages of the last closed signal, one after the other', async () => {
    const rig = await build();
    rig.store.chat = OWNER;
    rig.store.closedTexts = ['CLOSED #S-0040', 'REVIEW #S-0040'];
    await say(rig, OWNER, '/last');
    expect(rig.fake.textsTo(OWNER)).toEqual(['CLOSED #S-0040', 'REVIEW #S-0040']);
  });

  it('says no signal has closed yet', async () => {
    const rig = await build();
    rig.store.chat = OWNER;
    await say(rig, OWNER, '/last');
    expect(rig.fake.textsTo(OWNER)[0]).toContain('No signal has closed yet');
  });

  it('shows today in the display time zone', async () => {
    const rig = await build();
    rig.store.chat = OWNER;
    rig.store.rows = [row(1, 'WIN', 1.8), row(2, 'LOSS', -1.1), row(3, null, null)];
    await say(rig, OWNER, '/today');
    expect(rig.store.windows).toEqual([
      { from: Date.parse('2026-10-22T18:30:00Z'), until: Date.parse('2026-10-23T18:30:00Z') },
    ]);
    const text = rig.fake.textsTo(OWNER)[0] ?? '';
    expect(text).toContain('23 Oct');
    expect(text).toContain('S-0001');
    expect(text).toContain('Net +0.70R');
  });

  it('says there is no signal today', async () => {
    const rig = await build();
    rig.store.chat = OWNER;
    await say(rig, OWNER, '/today');
    expect(rig.fake.textsTo(OWNER)[0]).toMatch(/no signal/i);
  });

  it('shows the month and asks for the month of the display time zone', async () => {
    const rig = await build();
    rig.store.chat = OWNER;
    rig.store.rows = [row(1, 'WIN', 1.8), row(2, 'LOSS', -1.1)];
    await say(rig, OWNER, '/month');
    expect(rig.store.windows).toEqual([
      { from: Date.parse('2026-09-30T18:30:00Z'), until: Date.parse('2026-10-31T18:30:00Z') },
    ]);
    expect(rig.fake.textsTo(OWNER)[0]).toContain('October 2026');
  });
});

describe('the loop', () => {
  it('sets the command menu once and reads from the offset after the last update', async () => {
    const rig = await build();
    rig.store.chat = OWNER;
    rig.bot.start();
    rig.fake.pushMessage(OWNER, '/help');
    await expect.poll(() => rig.fake.sent.length).toBe(1);
    const second = rig.fake.pushMessage(OWNER, '/help');
    await expect.poll(() => rig.fake.sent.length).toBe(2);
    await rig.bot.stop();
    expect(rig.fake.commands).toHaveLength(1);
    const menu = rig.fake.commands[0] as { command: string }[];
    expect(menu.map((entry) => entry.command)).toEqual([
      'help',
      'status',
      'open',
      'last',
      'today',
      'month',
      'pause',
      'resume',
    ]);
    expect(rig.fake.offsets.at(-1)).toBeGreaterThanOrEqual(second);
    expect(new Set(rig.fake.offsets.filter((offset) => offset !== null)).size).toBeGreaterThan(1);
  });

  it('stops quickly, also in the middle of a long poll', async () => {
    const rig = await build();
    rig.bot.start();
    await expect.poll(() => rig.fake.offsets.length).toBeGreaterThan(0);
    const started = Date.now();
    await rig.bot.stop();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('waits and goes on when Telegram does not answer', async () => {
    const rig = await build();
    rig.store.chat = OWNER;
    rig.fake.next('getMe', { type: 'error', status: 502, description: 'Bad Gateway' });
    rig.fake.next('getUpdates', { type: 'drop' });
    rig.bot.start();
    rig.fake.pushMessage(OWNER, '/help');
    await expect.poll(() => rig.fake.sent.length).toBe(1);
    await rig.bot.stop();
    expect(rig.logs.some((entry) => entry.level === 'error')).toBe(true);
    expect(rig.bot.stats.errors).toBeGreaterThan(0);
  });

  it('tries an update again when the database fails for a moment', async () => {
    const rig = await build();
    rig.store.chat = OWNER;
    rig.store.failLinkedChat = 1;
    rig.bot.start();
    rig.fake.pushMessage(OWNER, '/help');
    await expect.poll(() => rig.fake.sent.length).toBe(1);
    await rig.bot.stop();
    expect(rig.bot.stats.skipped).toBe(0);
  });

  it('skips an update that fails every time, and goes on with the next', async () => {
    const rig = await build();
    rig.store.chat = OWNER;
    rig.store.failLinkedChat = 3;
    rig.bot.start();
    rig.fake.pushMessage(OWNER, '/help');
    await expect.poll(() => rig.bot.stats.skipped).toBe(1);
    rig.fake.pushMessage(OWNER, '/help');
    await expect.poll(() => rig.fake.sent.length).toBe(1);
    await rig.bot.stop();
  });

  it('does not start a second loop', async () => {
    const rig = await build();
    rig.bot.start();
    rig.bot.start();
    await rig.bot.stop();
    expect(rig.fake.commands).toHaveLength(1);
  });
});
