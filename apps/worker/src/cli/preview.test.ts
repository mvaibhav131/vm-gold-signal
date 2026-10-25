import { afterEach, describe, expect, it } from 'vitest';

import { checkTelegramHtml } from '@vmgs/core';

import { plain } from '../../../../packages/core/src/messages/test-html';
import { FakeTelegram } from '../testing/fakeTelegram';
import { TelegramClient } from '../telegram/client';
import { PREVIEW_INTRO, sampleMessages, telegramPreview } from './preview';

const TOKEN = '555:preview-token';
const EN = { locale: 'en', displayTz: 'Asia/Kolkata' } as const;
const HINGLISH = { locale: 'hinglish', displayTz: 'Asia/Kolkata' } as const;
/** The samples, and the messages the command sends: the intro and one for each sample. */
const SAMPLES = 11;
let fake: FakeTelegram | null = null;

afterEach(async () => {
  await fake?.stop();
  fake = null;
});

async function build(): Promise<{ fake: FakeTelegram; client: TelegramClient; lines: string[] }> {
  fake = new FakeTelegram({ token: TOKEN, username: 'VmGoldBot', pollScale: 0.01 });
  await fake.start();
  const client = new TelegramClient({ token: TOKEN, baseUrl: fake.baseUrl, timeoutMs: 2000 });
  return { fake, client, lines: [] };
}

describe('sampleMessages', () => {
  it('has one example of every message, each short enough for Telegram', () => {
    for (const options of [EN, HINGLISH]) {
      const samples = sampleMessages(options);
      expect(samples.map((sample) => sample.name)).toEqual([
        'SIGNAL_NEW',
        'SIGNAL_NEW, a SELL',
        'SIGNAL_TP1',
        'SIGNAL_CLOSED, a win',
        'SIGNAL_CLOSED, a loss with its review',
        'SIGNAL_CANCELLED',
        'SIGNAL_REVIEW_FINAL',
        'SYSTEM_DEGRADED',
        'SYSTEM_RECOVERED',
        'ENGINE_PAUSED',
        'TEST',
      ]);
      expect(samples).toHaveLength(SAMPLES);
      for (const sample of samples) {
        expect(sample.text.length, sample.name).toBeGreaterThan(20);
        expect(sample.text.length, sample.name).toBeLessThan(3900);
      }
    }
  });

  it('are Telegram HTML that Telegram accepts, with their tags (not the plain fallback)', () => {
    for (const options of [EN, HINGLISH]) {
      for (const sample of sampleMessages(options)) {
        expect(checkTelegramHtml(sample.text), sample.name).toBeNull();
        expect(sample.text, sample.name).toContain('<b>');
      }
    }
  });

  it('show both colours: a BUY is green and a SELL is red', () => {
    const [buy, sell] = sampleMessages(EN);
    expect(buy?.text).toContain('🟢 <b>BUY XAUUSD</b>');
    expect(sell?.text).toContain('🔴 <b>SELL XAUUSD</b>');
  });

  it('are made by the real formatters, with the paper-test label and the S-0042 example', () => {
    const samples = sampleMessages(EN);
    const [entry, , tp1, win, , cancelled] = samples.map((sample) => plain(sample.text));
    expect(entry).toContain('FORWARD-TEST (paper)');
    expect(entry).toContain('#S-0042');
    expect(entry).toContain('BUY');
    expect(tp1).toContain('TP1 HIT #S-0042');
    expect(tp1).toContain('Price 4023.840 at 11:41 IST');
    expect(win).toContain('WIN #S-0042  +1.47R net');
    expect(cancelled).toContain('went stale for 18 s');
  });

  it('follow the language', () => {
    const last = SAMPLES - 1;
    expect(sampleMessages(EN)[last]?.text).not.toBe(sampleMessages(HINGLISH)[last]?.text);
  });
});

describe('telegramPreview: the defaults', () => {
  /** A client on a clock the test moves: every poll takes 10 s and brings nothing. */
  function clocked(updates: (calls: number) => unknown[] = () => []) {
    const clock = { t: 1_000_000 };
    const polls: number[] = [];
    const sends: number[] = [];
    const client = {
      getMe: () => Promise.resolve({ id: 1, username: 'VmGoldBot' }),
      getUpdates: () => {
        polls.push(clock.t);
        clock.t += 10_000;
        return Promise.resolve(
          updates(polls.length).map((message) => ({ updateId: polls.length, message }) as never),
        );
      },
      sendMessage: () => {
        sends.push(clock.t);
        return Promise.resolve({ messageId: sends.length });
      },
    };
    return { clock, polls, sends, client };
  }

  it('waits two minutes for START', async () => {
    const { client, clock, polls } = clocked();
    await expect(
      telegramPreview({ client, options: EN, print: () => undefined, now: () => clock.t }),
    ).rejects.toThrow('no /start came in time');
    expect(polls).toHaveLength(12);
  });

  it('leaves a second between two messages', async () => {
    const { client, clock, sends } = clocked((calls) =>
      calls === 1
        ? [{ messageId: 1, chatId: 5, chatType: 'private', fromId: 5, text: '/start' }]
        : [],
    );
    await telegramPreview({
      client,
      options: EN,
      print: () => undefined,
      now: () => clock.t,
      sleep: (ms) => {
        clock.t += ms;
        return Promise.resolve();
      },
    });
    expect(sends).toHaveLength(SAMPLES + 1);
    for (let i = 1; i < sends.length; i += 1) {
      expect((sends[i] ?? 0) - (sends[i - 1] ?? 0)).toBe(1000);
    }
  });
});

describe('telegramPreview', () => {
  it('waits for /start, then sends the intro and every sample to that chat, labelled', async () => {
    const { fake: server, client, lines } = await build();
    server.pushMessage(77, '/start');
    const sent = await telegramPreview({
      client,
      options: EN,
      print: (line) => lines.push(line),
      pollS: 1,
      gapMs: 0,
    });
    const samples = sampleMessages(EN);
    expect(sent).toBe(samples.length + 1);
    const texts = server.textsTo(77);
    expect(texts).toHaveLength(samples.length + 1);
    expect(texts[0]).toBe(PREVIEW_INTRO);
    expect(texts[1]).toBe(
      `[SAMPLE 1/${String(SAMPLES)}: SIGNAL_NEW, not a real signal]\n\n${samples[0]?.text ?? ''}`,
    );
    expect(texts.at(-1)).toContain(
      `[SAMPLE ${String(SAMPLES)}/${String(SAMPLES)}: TEST, not a real signal]`,
    );
    expect(server.sent.every((message) => message.parseMode === 'HTML')).toBe(true);
    expect(server.sent.every((message) => message.linkPreviewDisabled)).toBe(true);
    expect(lines[0]).toBe(
      'Open https://t.me/VmGoldBot in Telegram and press START (or send /start). I wait for it.',
    );
    expect(lines.at(-1)).toBe(`Sent ${String(sent)} messages. Check them in Telegram.`);
  });

  it('sends the samples in the language asked for', async () => {
    const { fake: server, client } = await build();
    server.pushMessage(77, '/start');
    await telegramPreview({
      client,
      options: HINGLISH,
      print: () => undefined,
      pollS: 1,
      gapMs: 0,
    });
    expect(server.textsTo(77)[1]).toContain(sampleMessages(HINGLISH)[0]?.text ?? 'missing');
  });

  it('answers the newest /start, and ignores groups, other commands and plain text', async () => {
    const { fake: server, client } = await build();
    server.pushMessage(11, '/start');
    server.pushMessage(12, '/start', { chatType: 'group' });
    server.pushMessage(13, 'hello');
    server.pushMessage(14, '/help');
    server.pushMessage(22, '/start@VmGoldBot');
    server.pushMessage(33, '/status');
    server.pushMessage(44, '/start', { chatType: 'supergroup' });
    await telegramPreview({ client, options: EN, print: () => undefined, pollS: 1, gapMs: 0 });
    expect(server.textsTo(22)).toHaveLength(SAMPLES + 1);
    for (const other of [11, 12, 13, 14, 33, 44]) expect(server.textsTo(other)).toHaveLength(0);
  });

  it('confirms the updates it read, so that nothing is read twice', async () => {
    const { fake: server, client } = await build();
    const last = server.pushMessage(77, '/start');
    await telegramPreview({ client, options: EN, print: () => undefined, pollS: 1, gapMs: 0 });
    expect(server.offsets.at(-1)).toBe(last + 1);
    expect(server.pending).toBe(0);
  });

  it('keeps waiting through empty polls and starts when /start comes', async () => {
    const { fake: server, client } = await build();
    const running = telegramPreview({
      client,
      options: EN,
      print: () => undefined,
      pollS: 1,
      gapMs: 0,
    });
    await expect.poll(() => server.offsets.length).toBeGreaterThan(1);
    expect(server.sent).toHaveLength(0);
    server.pushMessage(77, '/start');
    await expect(running).resolves.toBe(SAMPLES + 1);
  });

  it('gives up with a clear error when nobody presses START, and sends nothing', async () => {
    const { fake: server, client } = await build();
    await expect(
      telegramPreview({
        client,
        options: EN,
        print: () => undefined,
        pollS: 1,
        waitMs: 150,
        gapMs: 0,
      }),
    ).rejects.toThrow('no /start came in time: run the command again');
    expect(server.sent).toHaveLength(0);
  });

  it('stops at a wrong token, before it waits for anything', async () => {
    const { fake: server } = await build();
    const wrong = new TelegramClient({
      token: '1:wrong',
      baseUrl: server.baseUrl,
      timeoutMs: 2000,
    });
    await expect(
      telegramPreview({ client: wrong, options: EN, print: () => undefined, pollS: 1, gapMs: 0 }),
    ).rejects.toThrow(/401/);
    expect(server.offsets).toHaveLength(0);
  });

  it('spaces the messages: at least the gap between two', async () => {
    const { fake: server, client } = await build();
    server.pushMessage(77, '/start');
    await telegramPreview({ client, options: EN, print: () => undefined, pollS: 1, gapMs: 20 });
    const times = server.sent.map((message) => message.at);
    for (let i = 1; i < times.length; i += 1) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(15);
    }
  });
});
