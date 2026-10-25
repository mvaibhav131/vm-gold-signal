import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeTelegram } from '../testing/fakeTelegram';
import { TelegramApiError, TelegramClient, classifyTelegramError, parseUpdate } from './client';

const TOKEN = '123456789:AAHsecretsecretsecretsecretsecret_0';
const CHAT = 4242;

let server: FakeTelegram;
let client: TelegramClient;

beforeAll(async () => {
  server = new FakeTelegram({ token: TOKEN, username: 'VmGoldBot', pollScale: 0.05 });
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

beforeEach(() => {
  server.sent.length = 0;
  server.calls.length = 0;
  server.offsets.length = 0;
  server.blocked.clear();
  client = new TelegramClient({ token: TOKEN, baseUrl: server.baseUrl, timeoutMs: 500 });
});

async function failure(promise: Promise<unknown>): Promise<TelegramApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TelegramApiError) return error;
    throw error;
  }
  throw new Error('it did not fail');
}

describe('sendMessage', () => {
  it('sends the text in HTML mode without a link preview, and gives the id of the message', async () => {
    const result = await client.sendMessage(CHAT, 'FORWARD-TEST (paper)\nBUY &amp; hold');
    expect(result.messageId).toBeGreaterThan(0);
    expect(server.sent).toHaveLength(1);
    expect(server.sent[0]).toMatchObject({
      chatId: CHAT,
      text: 'FORWARD-TEST (paper)\nBUY &amp; hold',
      parseMode: 'HTML',
      linkPreviewDisabled: true,
      messageId: result.messageId,
    });
  });

  it('a 429 carries the wait that Telegram asked for', async () => {
    server.next('sendMessage', {
      type: 'error',
      status: 429,
      description: 'Too Many Requests: retry after 7',
      retryAfter: 7,
    });
    const error = await failure(client.sendMessage(CHAT, 'x'));
    expect(error).toMatchObject({ kind: 'api', status: 429, errorCode: 429, retryAfterSec: 7 });
    expect(classifyTelegramError(error)).toEqual({
      type: 'rate_limited',
      message: error.message,
      retryAfterMs: 7000,
    });
    expect(error.message).toBe('sendMessage failed: 429 Too Many Requests: retry after 7');
  });

  it('a 429 without a wait is asked to wait one second', () => {
    const plain = new TelegramApiError('x', 'api', 429, 429, null);
    expect(classifyTelegramError(plain)).toMatchObject({
      type: 'rate_limited',
      retryAfterMs: 1000,
    });
  });

  it('goes by the error code of the Bot API, and by the HTTP status when there is none', () => {
    expect(classifyTelegramError(new TelegramApiError('x', 'api', 500, 400, null)).type).toBe(
      'permanent',
    );
    expect(classifyTelegramError(new TelegramApiError('x', 'api', 200, 429, null)).type).toBe(
      'rate_limited',
    );
    expect(classifyTelegramError(new TelegramApiError('x', 'http', 400, null, null)).type).toBe(
      'permanent',
    );
  });

  it('a 400 means the message is refused for good; other answers are tried again', async () => {
    server.next('sendMessage', {
      type: 'error',
      status: 400,
      description: 'Bad Request: message is too long',
    });
    expect(classifyTelegramError(await failure(client.sendMessage(CHAT, 'x')))).toMatchObject({
      type: 'permanent',
      message: 'sendMessage failed: 400 Bad Request: message is too long',
    });
    for (const status of [401, 403, 404, 409, 500, 502]) {
      server.next('sendMessage', { type: 'error', status, description: 'trouble' });
      expect(
        classifyTelegramError(await failure(client.sendMessage(CHAT, 'x'))).type,
        String(status),
      ).toBe('transient');
    }
    server.blocked.add(CHAT);
    expect(classifyTelegramError(await failure(client.sendMessage(CHAT, 'x')))).toMatchObject({
      type: 'transient',
      message: 'sendMessage failed: 403 Forbidden: bot was blocked by the user',
    });
  });

  it('a lost connection, a silent server and an answer that is not JSON are all transient', async () => {
    server.next('sendMessage', { type: 'drop' });
    const dropped = await failure(client.sendMessage(CHAT, 'x'));
    expect(dropped.kind).toBe('network');
    expect(classifyTelegramError(dropped).type).toBe('transient');

    server.next('sendMessage', { type: 'hang' });
    const slow = new TelegramClient({ token: TOKEN, baseUrl: server.baseUrl, timeoutMs: 80 });
    const timeout = await failure(slow.sendMessage(CHAT, 'x'));
    expect(timeout).toMatchObject({
      kind: 'timeout',
      message: 'sendMessage timed out after 80 ms',
    });
    expect(classifyTelegramError(timeout).type).toBe('transient');

    server.next('sendMessage', { type: 'garbage' });
    const garbage = await failure(client.sendMessage(CHAT, 'x'));
    expect(garbage).toMatchObject({ kind: 'http', status: 502, errorCode: null });
    expect(classifyTelegramError(garbage).type).toBe('transient');
  });

  it('nobody is reached when the server is gone, and that is a network error too', async () => {
    const gone = new TelegramClient({
      token: TOKEN,
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 500,
    });
    const error = await failure(gone.sendMessage(CHAT, 'x'));
    expect(error.kind).toBe('network');
    expect(error.message).toMatch(/^sendMessage failed: /);
  });

  it('never puts the token in an error, whatever the server says', async () => {
    server.next('sendMessage', { type: 'error', status: 500, description: `oops ${TOKEN} oops` });
    const error = await failure(client.sendMessage(CHAT, 'x'));
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('<token>');
    const wrong = new TelegramClient({
      token: '999999:wrongwrongwrongwrongwrongwrongwrong',
      baseUrl: server.baseUrl,
    });
    const unauthorized = await failure(wrong.sendMessage(CHAT, 'x'));
    expect(unauthorized).toMatchObject({ status: 401, errorCode: 401 });
    expect(unauthorized.message).not.toContain('wrongwrong');
  });

  it('is refused by the server for an empty or an over-long text, as a 400', async () => {
    expect(classifyTelegramError(await failure(client.sendMessage(CHAT, ''))).type).toBe(
      'permanent',
    );
    expect(
      classifyTelegramError(await failure(client.sendMessage(CHAT, 'x'.repeat(4097)))).type,
    ).toBe('permanent');
  });

  it('is refused for HTML that does not parse, as a 400 that is refused for good, and sends nothing', async () => {
    for (const html of ['<b>never closed', '<b><code>x</code></b>', '<div>x</div>', 'a < b']) {
      const error = await failure(client.sendMessage(CHAT, html));
      expect(error).toMatchObject({ status: 400, errorCode: 400 });
      expect(error.message).toContain("can't parse entities");
      expect(classifyTelegramError(error).type, html).toBe('permanent');
    }
    expect(server.sent).toHaveLength(0);
  });

  it('takes the tags that the formatters write', async () => {
    const text =
      '<b>BUY</b> <code>4017.370</code> <i>quiet</i>\n<blockquote expandable><b>WHY</b>\nline</blockquote>';
    await client.sendMessage(CHAT, text);
    expect(server.sent.at(-1)?.text).toBe(text);
  });
});

describe('getMe and setMyCommands', () => {
  it('tell who the bot is, and set the menu', async () => {
    expect(await client.getMe()).toEqual({ id: 777, username: 'VmGoldBot' });
    await client.setMyCommands([{ command: 'status', description: 'Feed and engine' }]);
    expect(server.commands.at(-1)).toEqual([{ command: 'status', description: 'Feed and engine' }]);
  });

  it('a wrong token is a 401 already at getMe', async () => {
    const wrong = new TelegramClient({
      token: '999999:wrongwrongwrongwrongwrongwrongwrong',
      baseUrl: server.baseUrl,
    });
    expect(await failure(wrong.getMe())).toMatchObject({ status: 401 });
  });
});

describe('getUpdates: long polling', () => {
  it('returns what is waiting at once, as text messages with the chat and the sender', async () => {
    const id = server.pushMessage(CHAT, '/status');
    server.pushOther();
    const updates = await client.getUpdates({ offset: null, timeoutS: 1 });
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      updateId: id,
      message: { chatId: CHAT, chatType: 'private', fromId: CHAT, text: '/status' },
    });
    expect(updates[1]).toEqual({ updateId: id + 1, message: null });
    // confirming them with the offset empties the queue
    expect(await client.getUpdates({ offset: id + 2, timeoutS: 1 })).toEqual([]);
    expect(server.offsets.slice(-2)).toEqual([null, id + 2]);
    expect(server.pending).toBe(0);
  });

  it('waits for a message and returns as soon as it comes, or nothing after the time asked for', async () => {
    const waiting = client.getUpdates({ offset: null, timeoutS: 20 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    server.pushMessage(CHAT, '/open');
    const updates = await waiting;
    expect(updates.map((update) => update.message?.text)).toEqual(['/open']);
    const last = updates.at(-1)?.updateId ?? 0;
    const started = Date.now();
    expect(await client.getUpdates({ offset: last + 1, timeoutS: 2 })).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });

  it('can be cancelled, which is how the bot stops', async () => {
    const controller = new AbortController();
    const waiting = failure(
      client.getUpdates({ offset: null, timeoutS: 100, signal: controller.signal }),
    );
    setTimeout(() => {
      controller.abort();
    }, 30);
    const error = await waiting;
    expect(error.message).toBe('getUpdates was cancelled');
    expect(error.kind).toBe('network');
  });

  it('a long poll has its own timeout: the wait asked for plus the usual', async () => {
    server.next('getUpdates', { type: 'hang' });
    const short = new TelegramClient({ token: TOKEN, baseUrl: server.baseUrl, timeoutMs: 50 });
    const started = Date.now();
    const error = await failure(short.getUpdates({ offset: null, timeoutS: 0 }));
    expect(error.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a long poll may last longer than the usual timeout, up to the wait asked for plus it', async () => {
    server.next('getUpdates', { type: 'delay', ms: 1300 });
    const slow = new TelegramClient({ token: TOKEN, baseUrl: server.baseUrl, timeoutMs: 2000 });
    await expect(slow.getUpdates({ offset: null, timeoutS: 1 })).resolves.toEqual([]);
  });
});

describe('parseUpdate', () => {
  it('reads a text message and skips what is not one', () => {
    const base = {
      update_id: 5,
      message: { message_id: 9, chat: { id: -100, type: 'group' }, from: { id: 3 }, text: 'hi' },
    };
    expect(parseUpdate(base)).toEqual({
      updateId: 5,
      message: { messageId: 9, chatId: -100, chatType: 'group', fromId: 3, text: 'hi' },
    });
    expect(parseUpdate({ update_id: 6 })).toEqual({ updateId: 6, message: null });
    expect(parseUpdate({ update_id: 7, edited_message: {} })).toEqual({
      updateId: 7,
      message: null,
    });
    for (const message of [
      { message_id: 9, chat: { id: 1 } },
      { message_id: 9, chat: { type: 'private' }, text: 'x' },
      { chat: { id: 1 }, text: 'x' },
      'text',
      [],
    ]) {
      expect(parseUpdate({ update_id: 8, message }), JSON.stringify(message)).toEqual({
        updateId: 8,
        message: null,
      });
    }
    expect(
      parseUpdate({ update_id: 9, message: { message_id: 1, chat: { id: 1 }, text: 'x' } }),
    ).toMatchObject({
      message: { chatType: 'unknown', fromId: null },
    });
  });

  it('is null without an update_id, or for something that is not an object', () => {
    for (const raw of [null, undefined, 5, 'x', [], {}, { update_id: '5' }]) {
      expect(parseUpdate(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe('the client itself', () => {
  it('needs a token, and works with a trailing slash in the address', async () => {
    expect(() => new TelegramClient({ token: '' })).toThrow(RangeError);
    const slash = new TelegramClient({ token: TOKEN, baseUrl: `${server.baseUrl}///` });
    expect((await slash.getMe()).username).toBe('VmGoldBot');
  });

  it('an error that is not from Telegram is transient', () => {
    expect(classifyTelegramError(new Error('boom'))).toEqual({
      type: 'transient',
      message: 'boom',
    });
    expect(classifyTelegramError('weird')).toEqual({ type: 'transient', message: 'weird' });
  });

  it('can use another fetch', async () => {
    const seen: string[] = [];
    const fake = new TelegramClient({
      token: TOKEN,
      fetch: (input) => {
        seen.push(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, result: { id: 1, username: null } }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });
    expect(await fake.getMe()).toEqual({ id: 1, username: null });
    expect(seen).toEqual([`https://api.telegram.org/bot${TOKEN}/getMe`]);
  });
});
