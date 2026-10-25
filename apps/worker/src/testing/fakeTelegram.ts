import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { checkTelegramHtml } from '@vmgs/core';

/** What the fake does with the next call of a method. */
export type Behaviour =
  | {
      readonly type: 'error';
      readonly status: number;
      readonly description: string;
      readonly retryAfter?: number;
    }
  /** The connection is cut without an answer. */
  | { readonly type: 'drop' }
  /** No answer at all (the client's timeout ends it). */
  | { readonly type: 'hang' }
  /** The answer comes after this many milliseconds. */
  | { readonly type: 'delay'; readonly ms: number }
  /** An answer that is not JSON. */
  | { readonly type: 'garbage' };

export interface SentMessage {
  readonly chatId: number | string;
  readonly text: string;
  readonly parseMode: string | null;
  readonly linkPreviewDisabled: boolean;
  readonly at: number;
  readonly messageId: number;
}

export interface FakeTelegramOptions {
  readonly token: string;
  readonly username?: string;
  /** A second message to the same chat sooner than this many milliseconds after the first gets a 429, as the real service does. */
  readonly minGapMs?: number;
  /** Long polling waits `timeout` seconds times this, so a test does not wait whole seconds. */
  readonly pollScale?: number;
}

interface PendingPoll {
  readonly respond: (updates: unknown[]) => void;
}

/**
 * A Telegram Bot API on a local port, for the tests of the client, the sender and the bot: it
 * records what is sent, answers `getUpdates` with the updates a test pushes, checks the token,
 * can be told to fail the next call, and can enforce the 1 message per second rule of a chat.
 */
export class FakeTelegram {
  readonly sent: SentMessage[] = [];
  readonly commands: unknown[] = [];
  readonly calls: { method: string; at: number }[] = [];
  /** The `offset` of every `getUpdates` call. */
  readonly offsets: (number | null)[] = [];
  private readonly server: Server;
  private readonly behaviours = new Map<string, Behaviour[]>();
  private readonly queue: { update_id: number; message: unknown }[] = [];
  private readonly polls: PendingPoll[] = [];
  private readonly lastSendByChat = new Map<string, number>();
  private nextUpdateId = 1000;
  private nextMessageId = 1;
  private readonly open = new Set<ServerResponse>();
  /** Chats that have blocked the bot: `sendMessage` answers 403 for them. */
  readonly blocked = new Set<number>();
  private base = '';

  constructor(private readonly options: FakeTelegramOptions) {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  get baseUrl(): string {
    return this.base;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.base = `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
  }

  async stop(): Promise<void> {
    for (const poll of this.polls.splice(0)) poll.respond([]);
    for (const response of this.open) response.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  /** Makes the next call of `method` behave like this (calls queue up). */
  next(method: string, behaviour: Behaviour): void {
    this.behaviours.set(method, [...(this.behaviours.get(method) ?? []), behaviour]);
  }

  /** A text message from a chat arrives. Returns its `update_id`. */
  pushMessage(
    chatId: number,
    text: string,
    options: { chatType?: string; fromId?: number } = {},
  ): number {
    const updateId = this.nextUpdateId;
    this.nextUpdateId += 1;
    this.queue.push({
      update_id: updateId,
      message: {
        message_id: this.nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: options.chatType ?? 'private' },
        from: { id: options.fromId ?? chatId, is_bot: false },
        text,
      },
    });
    this.flushPolls();
    return updateId;
  }

  /** An update that is not a text message (a photo, an edited message). */
  pushOther(): number {
    const updateId = this.nextUpdateId;
    this.nextUpdateId += 1;
    this.queue.push({
      update_id: updateId,
      message: { message_id: 1, chat: { id: 1, type: 'private' }, photo: [] },
    });
    this.flushPolls();
    return updateId;
  }

  get pending(): number {
    return this.queue.length;
  }

  textsTo(chatId: number | string): string[] {
    return this.sent.filter((message) => message.chatId === chatId).map((message) => message.text);
  }

  private flushPolls(): void {
    if (this.queue.length === 0) return;
    for (const poll of this.polls.splice(0)) poll.respond([...this.queue]);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.open.add(response);
    response.on('close', () => {
      this.open.delete(response);
    });
    try {
      await this.route(request, response);
    } catch {
      if (!response.writableEnded) response.destroy();
    }
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(request.url ?? '');
    if (match === null) {
      this.fail(response, 404, 'Not Found');
      return;
    }
    const [, token, method = ''] = match;
    if (token !== this.options.token) {
      this.fail(response, 401, 'Unauthorized');
      return;
    }
    this.calls.push({ method, at: Date.now() });
    let body: Record<string, unknown>;
    try {
      body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
    } catch {
      this.fail(response, 400, 'Bad Request: invalid JSON');
      return;
    }

    const behaviour = this.behaviours.get(method)?.shift();
    if (behaviour !== undefined) {
      switch (behaviour.type) {
        case 'drop':
          response.destroy();
          return;
        case 'hang':
          return;
        case 'garbage':
          response.writeHead(502, { 'content-type': 'text/html' });
          response.end('<html>Bad Gateway</html>');
          return;
        case 'delay':
          await new Promise((resolve) => setTimeout(resolve, behaviour.ms));
          break;
        case 'error':
          this.fail(
            response,
            behaviour.status,
            behaviour.description,
            behaviour.retryAfter === undefined
              ? undefined
              : { parameters: { retry_after: behaviour.retryAfter } },
          );
          return;
      }
    }

    switch (method) {
      case 'getMe':
        this.reply(response, 200, {
          ok: true,
          result: { id: 777, is_bot: true, username: this.options.username ?? 'VmGoldBot' },
        });
        break;
      case 'setMyCommands':
        this.commands.push(body.commands);
        this.reply(response, 200, { ok: true, result: true });
        break;
      case 'sendMessage':
        this.sendMessage(response, body);
        break;
      case 'getUpdates':
        this.getUpdates(response, body);
        break;
      default:
        this.fail(response, 404, 'Not Found');
    }
  }

  private sendMessage(response: ServerResponse, body: Record<string, unknown>): void {
    const chatId = body.chat_id;
    const text = body.text;
    if (
      (typeof chatId !== 'number' && typeof chatId !== 'string') ||
      typeof text !== 'string' ||
      text === ''
    ) {
      this.fail(response, 400, 'Bad Request: message text is empty');
      return;
    }
    if (text.length > 4096) {
      this.fail(response, 400, 'Bad Request: message is too long');
      return;
    }
    // as the real service does: HTML that does not parse is refused with a 400, which is never retried
    const problem = body.parse_mode === 'HTML' ? checkTelegramHtml(text) : null;
    if (problem !== null) {
      this.fail(response, 400, `Bad Request: can't parse entities: ${problem}`);
      return;
    }
    if (typeof chatId === 'number' && this.blocked.has(chatId)) {
      this.fail(response, 403, 'Forbidden: bot was blocked by the user');
      return;
    }
    const now = Date.now();
    const key = String(chatId);
    const last = this.lastSendByChat.get(key);
    const gap = this.options.minGapMs ?? 0;
    if (last !== undefined && now - last < gap) {
      this.fail(response, 429, 'Too Many Requests: retry after 1', {
        parameters: { retry_after: 1 },
      });
      return;
    }
    this.lastSendByChat.set(key, now);
    const messageId = this.nextMessageId;
    this.nextMessageId += 1;
    const preview = body.link_preview_options;
    this.sent.push({
      chatId,
      text,
      parseMode: typeof body.parse_mode === 'string' ? body.parse_mode : null,
      linkPreviewDisabled:
        typeof preview === 'object' &&
        preview !== null &&
        (preview as Record<string, unknown>).is_disabled === true,
      at: now,
      messageId,
    });
    this.reply(response, 200, {
      ok: true,
      result: { message_id: messageId, chat: { id: chatId }, text },
    });
  }

  private getUpdates(response: ServerResponse, body: Record<string, unknown>): void {
    const offset = typeof body.offset === 'number' ? body.offset : null;
    this.offsets.push(offset);
    // what the client confirmed is forgotten
    if (offset !== null) {
      for (let i = this.queue.length - 1; i >= 0; i -= 1) {
        if ((this.queue[i]?.update_id ?? 0) < offset) this.queue.splice(i, 1);
      }
    }
    if (this.queue.length > 0) {
      this.reply(response, 200, { ok: true, result: [...this.queue] });
      return;
    }
    const waitS = typeof body.timeout === 'number' ? body.timeout : 0;
    if (waitS <= 0) {
      this.reply(response, 200, { ok: true, result: [] });
      return;
    }
    let done = false;
    const finish = (updates: unknown[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!response.writableEnded && !response.destroyed)
        this.reply(response, 200, { ok: true, result: updates });
    };
    const timer = setTimeout(
      () => {
        finish([]);
      },
      waitS * 1000 * (this.options.pollScale ?? 1),
    );
    this.polls.push({ respond: finish });
    response.on('close', () => {
      done = true;
      clearTimeout(timer);
    });
  }

  /** An error answer of the Bot API: `{ok: false, error_code, description}` and, for a 429, `parameters`. */
  private fail(
    response: ServerResponse,
    status: number,
    description: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.reply(response, status, { ok: false, error_code: status, description, ...extra });
  }

  private reply(response: ServerResponse, status: number, payload: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  }
}
