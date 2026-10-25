import type { SendFailure } from '@vmgs/core';

/** One message of the chat, as far as the bot reads it. */
export interface TelegramMessageIn {
  readonly messageId: number;
  readonly chatId: number;
  readonly chatType: string;
  readonly fromId: number | null;
  readonly text: string;
}

export interface TelegramUpdate {
  readonly updateId: number;
  /** Null for an update that is not a text message (an edit, a photo, a channel post): the bot skips it. */
  readonly message: TelegramMessageIn | null;
}

export type TelegramErrorKind = 'api' | 'http' | 'network' | 'timeout';

/** An error of the Bot API or of the connection. Its text never contains the bot token. */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly kind: TelegramErrorKind,
    /** The HTTP status, when there was a response. */
    readonly status: number | null,
    /** `error_code` of the Bot API, when it sent one. */
    readonly errorCode: number | null,
    /** Seconds from `parameters.retry_after` of a 429. */
    readonly retryAfterSec: number | null,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

/**
 * How an error of a send is treated (04_API_and_Notifications section 4, "Delivery rules"): a 429 asks
 * for a wait (`retry_after`), a 400 means the message itself is refused and is never retried, and
 * everything else (a server error, a lost connection, a wrong token or a blocked bot that the owner
 * can fix) is tried again until the message expires.
 */
export function classifyTelegramError(error: unknown): SendFailure {
  if (!(error instanceof TelegramApiError)) {
    return { type: 'transient', message: error instanceof Error ? error.message : String(error) };
  }
  const code = error.errorCode ?? error.status;
  if (code === 429) {
    return {
      type: 'rate_limited',
      message: error.message,
      retryAfterMs: (error.retryAfterSec ?? 1) * 1000,
    };
  }
  if (code === 400) return { type: 'permanent', message: error.message };
  return { type: 'transient', message: error.message };
}

export interface TelegramClientOptions {
  readonly token: string;
  /** `https://api.telegram.org`; a test points it at a fake server. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** For every call except `getUpdates`, which waits as long as it asks for plus this. */
  readonly timeoutMs?: number;
}

export interface BotCommandInfo {
  readonly command: string;
  readonly description: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads one update of `getUpdates`; null when it has no `update_id`. */
export function parseUpdate(raw: unknown): TelegramUpdate | null {
  if (!isRecord(raw) || typeof raw.update_id !== 'number') return null;
  const updateId = raw.update_id;
  const message = raw.message;
  if (!isRecord(message)) return { updateId, message: null };
  const chat = message.chat;
  const from = message.from;
  if (
    !isRecord(chat) ||
    typeof chat.id !== 'number' ||
    typeof message.text !== 'string' ||
    typeof message.message_id !== 'number'
  ) {
    return { updateId, message: null };
  }
  return {
    updateId,
    message: {
      messageId: message.message_id,
      chatId: chat.id,
      chatType: typeof chat.type === 'string' ? chat.type : 'unknown',
      fromId: isRecord(from) && typeof from.id === 'number' ? from.id : null,
      text: message.text,
    },
  };
}

/**
 * A thin client of the Telegram Bot API on the native `fetch` (01_HLD section 11: `grammy` was
 * rejected because it pulls a legacy `node-fetch`). It has the four calls the system needs:
 * `sendMessage`, `getUpdates` (long polling, so no inbound port is needed), `getMe` and
 * `setMyCommands`. The token is only in the URL path, never in an error or a log line.
 */
export class TelegramClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: TelegramClientOptions) {
    if (options.token === '') throw new RangeError('a Telegram bot token is needed');
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.doFetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** The bot itself: who it is, and a check that the token works. */
  async getMe(): Promise<{ id: number; username: string | null }> {
    const result = await this.call('getMe', {}, this.timeoutMs);
    if (!isRecord(result) || typeof result.id !== 'number') {
      throw this.error('getMe returned something unexpected', 'api', null, null, null);
    }
    return {
      id: result.id,
      username: typeof result.username === 'string' ? result.username : null,
    };
  }

  /** Sends text in HTML parse mode (the text is escaped as a whole by the formatters), without a link preview. */
  async sendMessage(chatId: number | string, text: string): Promise<{ messageId: number }> {
    const result = await this.call(
      'sendMessage',
      { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
      this.timeoutMs,
    );
    if (!isRecord(result) || typeof result.message_id !== 'number') {
      throw this.error('sendMessage returned something unexpected', 'api', null, null, null);
    }
    return { messageId: result.message_id };
  }

  /**
   * Long polling: waits up to `timeoutS` seconds for an update. `offset` is the id after the last one
   * that was handled; Telegram forgets everything before it. `signal` ends the wait (shutdown).
   */
  async getUpdates(options: {
    offset: number | null;
    timeoutS: number;
    signal?: AbortSignal;
  }): Promise<TelegramUpdate[]> {
    const body: Record<string, unknown> = {
      timeout: options.timeoutS,
      allowed_updates: ['message'],
    };
    if (options.offset !== null) body.offset = options.offset;
    const result = await this.call(
      'getUpdates',
      body,
      options.timeoutS * 1000 + this.timeoutMs,
      options.signal,
    );
    if (!Array.isArray(result)) {
      throw this.error('getUpdates returned something unexpected', 'api', null, null, null);
    }
    return result.flatMap((raw: unknown) => {
      const update = parseUpdate(raw);
      return update === null ? [] : [update];
    });
  }

  /** The command menu of the bot. */
  async setMyCommands(commands: readonly BotCommandInfo[]): Promise<void> {
    await this.call('setMyCommands', { commands }, this.timeoutMs);
  }

  private redact(text: string): string {
    return text.split(this.token).join('<token>');
  }

  private error(
    message: string,
    kind: TelegramErrorKind,
    status: number | null,
    errorCode: number | null,
    retryAfterSec: number | null,
  ): TelegramApiError {
    return new TelegramApiError(this.redact(message), kind, status, errorCode, retryAfterSec);
  }

  private async call(
    method: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    stop?: AbortSignal,
  ): Promise<unknown> {
    const signals = [AbortSignal.timeout(timeoutMs), ...(stop === undefined ? [] : [stop])];
    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (stop?.aborted === true)
        throw this.error(`${method} was cancelled`, 'network', null, null, null);
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw this.error(
          `${method} timed out after ${String(timeoutMs)} ms`,
          'timeout',
          null,
          null,
          null,
        );
      }
      const cause = error instanceof Error && isRecord(error.cause) ? error.cause.code : undefined;
      throw this.error(
        `${method} failed: ${typeof cause === 'string' ? cause : error instanceof Error ? error.message : 'network error'}`,
        'network',
        null,
        null,
        null,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw this.error(
        `${method} answered HTTP ${String(response.status)} without JSON`,
        'http',
        response.status,
        null,
        null,
      );
    }
    if (isRecord(payload) && payload.ok === true) return payload.result;

    const description =
      isRecord(payload) && typeof payload.description === 'string'
        ? payload.description
        : 'no description';
    const errorCode =
      isRecord(payload) && typeof payload.error_code === 'number' ? payload.error_code : null;
    const parameters = isRecord(payload) ? payload.parameters : undefined;
    const retryAfter =
      isRecord(parameters) && typeof parameters.retry_after === 'number'
        ? parameters.retry_after
        : null;
    throw this.error(
      `${method} failed: ${String(errorCode ?? response.status)} ${description}`,
      isRecord(payload) ? 'api' : 'http',
      response.status,
      errorCode,
      retryAfter,
    );
  }
}
