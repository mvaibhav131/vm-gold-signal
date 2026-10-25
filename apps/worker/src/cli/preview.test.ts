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
const SAMPLES = 21;
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
        'NEWS_UPCOMING',
        'NEWS_RELEASED',
        'NEWS_HEADLINE',
        'MARKET_MOVE, with possible causes',
        'MARKET_MOVE, no matching headline',
        'SYSTEM_DEGRADED, the headline feeds',
        'SYSTEM_RECOVERED, the headline feeds',
        'STORAGE_WARNING',
        'DAILY_DIGEST',
        'MONTHLY_REPORT',
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

  it('show the headline, the sudden move with and without possible causes, and the headline feeds going down and back', () => {
    const texts = Object.fromEntries(
      sampleMessages(EN).map((sample) => [sample.name, plain(sample.text)]),
    );
    const headline = texts.NEWS_HEADLINE;
    expect(headline).toContain('📰 HEADLINE (HIGH) | Fed and rates');
    expect(headline).toContain('Seen in: CNBC, BBC News. Published 11:33 IST, detected 11:35 IST');
    expect(headline).toContain('Gold since publication: +2.400 USD (0.8 x ATR 5m), spread 0.120.');
    expect(headline).toContain('(n=64, normal 18%)');
    expect(headline).toContain('This is context, not a signal.');
    const caused = texts['MARKET_MOVE, with possible causes'];
    expect(caused).toContain('📈 GOLD SPIKE UP +10.000 USD in 4 min (3.3 x ATR 5m)');
    expect(caused).toContain('1. HIGH  "Fed officials signal rates may stay higher for longer"');
    expect(caused).toContain('2. (unclassified, timing only) "Local bakery wins a prize"');
    expect(caused).toContain('Open signals: 🟢 #S-0046 BUY (+1.40R).');
    expect(texts['MARKET_MOVE, no matching headline']).toContain(
      'No matching headline found in the free feeds.',
    );
    expect(texts['SYSTEM_DEGRADED, the headline feeds']).toContain(
      '🔴 HEADLINE FEEDS DOWN since 11:35 IST (no feed answered for 11 min)',
    );
    expect(texts['SYSTEM_RECOVERED, the headline feeds']).toContain(
      '🟢 HEADLINE FEEDS BACK 11:48 IST after 13 min.',
    );
  });

  it('show the calendar messages on the CPI of the example: 30 minutes ahead, and the release', () => {
    const [upcoming, released] = sampleMessages(EN)
      .filter((sample) => ['NEWS_UPCOMING', 'NEWS_RELEASED'].includes(sample.name))
      .map((sample) => plain(sample.text));
    expect(upcoming).toContain('HIGH-IMPACT USD EVENT in 30 min: CPI m/m (16:00 IST)');
    expect(upcoming).toContain('from 15:15 IST');
    expect(released).toContain('CPI m/m released 16:00 IST');
    expect(released).toContain('(surprise +2.1 sigma)');
    expect(released).toContain('Gold 15 s after: -3.100 USD, spread 0.900.');
  });

  it('show the storage warning, the day summary of the example day and the report of its month', () => {
    const texts = Object.fromEntries(
      sampleMessages(EN).map((sample) => [sample.name, plain(sample.text)]),
    );
    expect(texts.STORAGE_WARNING).toContain('STORAGE 82% of the 10 GB budget.');
    expect(texts.DAILY_DIGEST).toContain(
      'DAY SUMMARY 23 Oct: 3 signals, 2 valid results: 1 win +1.47R, 1 loss -1.04R. 1 still open.',
    );
    expect(texts.DAILY_DIGEST).toContain('Top weak group today: Trigger and momentum.');
    const report = texts.MONTHLY_REPORT;
    expect(report).toContain('MONTHLY REPORT October 2026 (FORWARD-TEST)');
    expect(report).toContain('Signals generated: 24');
    expect(report).toContain('Data: feed uptime 99.2%, 3 incidents. Storage: DB 1.1 GB.');
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
    // each gap is checked through the whole span: a single late timer on the server side cannot fail it
    const first = times[0] ?? 0;
    const last = times[times.length - 1] ?? 0;
    expect(times.length).toBeGreaterThan(SAMPLES);
    expect(last - first).toBeGreaterThanOrEqual(15 * (times.length - 1));
  });
});
