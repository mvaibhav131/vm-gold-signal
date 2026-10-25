import { TelegramApiError, type TelegramClient } from './client';

export interface TelegramTransportOptions {
  readonly client: Pick<TelegramClient, 'sendMessage'>;
  /** The least time between two messages (Telegram allows about 1 per second to one chat). */
  readonly minGapMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Every message to Telegram goes through here, so that the outbox sender and the replies of the bot
 * share one rate limit (04_API_and_Notifications section 4: 1 message per second) and one memory of
 * a 429: when Telegram says "retry after N", nothing is sent for N seconds, whoever asks.
 */
export class TelegramTransport {
  private readonly client: Pick<TelegramClient, 'sendMessage'>;
  private readonly minGapMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextAllowedAt = Number.NEGATIVE_INFINITY;

  constructor(options: TelegramTransportOptions) {
    this.client = options.client;
    this.minGapMs = options.minGapMs ?? 1000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    if (!(this.minGapMs >= 0) || !Number.isFinite(this.minGapMs)) {
      throw new RangeError('minGapMs must be zero or more');
    }
  }

  /** How many milliseconds until a message may be sent; 0 means now. */
  waitMs(): number {
    return Math.max(0, this.nextAllowedAt - this.now());
  }

  /**
   * Sends now. The slot is taken before the call goes out, so a second caller sees the gap at once;
   * a 429 closes the transport for the time Telegram asked for. The error is rethrown.
   */
  async send(chatId: number | string, text: string): Promise<{ messageId: number }> {
    const start = this.now();
    this.nextAllowedAt = Math.max(this.nextAllowedAt, start + this.minGapMs);
    try {
      return await this.client.sendMessage(chatId, text);
    } catch (error) {
      if (error instanceof TelegramApiError && error.errorCode === 429) {
        const wait = (error.retryAfterSec ?? 1) * 1000;
        this.nextAllowedAt = Math.max(this.nextAllowedAt, this.now() + wait);
      }
      throw error;
    }
  }

  /** Waits for its turn, then sends: for the replies of the bot, which may wait a moment. */
  async sendWhenReady(chatId: number | string, text: string): Promise<{ messageId: number }> {
    for (;;) {
      const wait = this.waitMs();
      if (wait <= 0) return this.send(chatId, text);
      await this.sleep(wait);
    }
  }
}
