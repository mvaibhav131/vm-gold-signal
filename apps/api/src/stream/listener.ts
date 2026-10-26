import type { Pool, PoolClient } from 'pg';

import { SIGNAL_NOTIFY_CHANNEL } from '@vmgs/contracts';

type Log = (level: 'info' | 'error', message: string, details?: Record<string, unknown>) => void;

export interface ListenerOptions {
  readonly pool: Pool;
  /** One notification of the channel (its payload text). */
  readonly onNotification: (payload: string) => void;
  /**
   * Called each time the connection is up (also the first time): a stream that was opened while the listener was down
   * (at start, or while it retried) may have missed what was announced, so the screens reload their state. With nobody
   * connected it does nothing.
   */
  readonly onConnected: () => void;
  readonly log?: Log;
  readonly retryMs?: { readonly first: number; readonly max: number };
  /** How often an idle connection is asked whether it is there (a router that dropped it says nothing). */
  readonly keepAliveMs?: number;
}

/**
 * `LISTEN vmgs_signals` on a connection of its own. The worker announces a signal that was written or changed inside
 * its transaction, so a notification arrives only after the commit. A connection that is lost is made again with a
 * growing wait, and every time it is up `onConnected` is called: whatever was announced while it was down is lost, and
 * the stream tells its clients to reload.
 */
export class SignalListener {
  private client: PoolClient | null = null;
  private keepAlive: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopped = true;
  private failures = 0;

  constructor(private readonly options: ListenerOptions) {}

  get connected(): boolean {
    return this.client !== null;
  }

  /** `stop()` may run while an await is pending: the flag is read again through this, not from a narrowed type. */
  private get halted(): boolean {
    return this.stopped;
  }

  private log(level: 'info' | 'error', message: string, error?: unknown): void {
    this.options.log?.(
      level,
      message,
      error === undefined ? {} : { error: error instanceof Error ? error.message : 'not an Error' },
    );
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let client: PoolClient | null = null;
    try {
      client = await this.options.pool.connect();
      const held = client;
      held.on('notification', (message) => {
        if (message.channel === SIGNAL_NOTIFY_CHANNEL && message.payload !== undefined) {
          this.options.onNotification(message.payload);
        }
      });
      held.on('error', (error) => {
        this.lost(held, error);
      });
      await held.query(`LISTEN ${SIGNAL_NOTIFY_CHANNEL}`);
      if (this.halted) {
        held.release(true);
        return;
      }
      this.client = held;
      this.failures = 0;
      this.log('info', 'listening for signal changes');
      this.options.onConnected();
      this.keepAlive = setInterval(() => {
        void held.query('SELECT 1').catch((error: unknown) => {
          this.lost(held, error);
        });
      }, this.options.keepAliveMs ?? 30_000);
      this.keepAlive.unref();
    } catch (error) {
      client?.release(true);
      this.failures += 1;
      this.log('error', 'the connection that listens for signal changes could not be made', error);
      this.schedule();
    }
  }

  private lost(client: PoolClient, error: unknown): void {
    if (this.client !== client) return;
    this.client = null;
    if (this.keepAlive !== null) clearInterval(this.keepAlive);
    this.keepAlive = null;
    client.removeAllListeners('notification');
    client.release(true);
    this.log('error', 'the connection that listens for signal changes was lost', error);
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || this.retry !== null) return;
    const { first, max } = this.options.retryMs ?? { first: 1000, max: 30_000 };
    const wait = Math.min(max, first * 2 ** Math.max(0, this.failures - 1));
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, wait);
    this.retry.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    if (this.keepAlive !== null) clearInterval(this.keepAlive);
    this.keepAlive = null;
    const client = this.client;
    this.client = null;
    if (client !== null) {
      client.removeAllListeners('notification');
      client.release(true);
    }
  }
}
