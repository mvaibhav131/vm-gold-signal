type Log = (level: 'info' | 'error', message: string, details?: Record<string, unknown>) => void;

export interface HealthPingerOptions {
  /** The ping URL of the check at Healthchecks.io. It is a secret: it is never logged, only its host. */
  readonly url: string;
  /** Whether the worker is working: its own heartbeat in the database is fresh. */
  readonly alive: () => Promise<boolean>;
  readonly fetch?: typeof fetch;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly log?: Log;
}

export type PingResult = 'OK' | 'FAIL' | 'UNREACHABLE';

/**
 * The heartbeat for the external check (06 section 4). Every minute it tells Healthchecks.io that the worker is
 * working, or, when the worker's own heartbeat in the database is stale, that it is not (`/fail`, which alerts at
 * once). When the pings stop altogether (the VM, the container or the worker is gone) Healthchecks.io alerts after its
 * grace time. A ping that cannot be delivered is logged once, and again when pings are delivered once more; it never
 * throws and it never delays anything, because it has its own loop and its own timeout.
 */
export class HealthPinger {
  private readonly options: HealthPingerOptions;
  private readonly send: typeof fetch;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly log: Log;
  private readonly host: string;
  private delivering = true;
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(options: HealthPingerOptions) {
    this.options = options;
    this.send = options.fetch ?? fetch;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.log = options.log ?? (() => undefined);
    this.host = new URL(options.url).host;
  }

  /** One ping. Returns what was sent (or `UNREACHABLE` when nothing could be delivered). */
  async pingOnce(): Promise<PingResult> {
    const alive = await Promise.resolve()
      .then(() => this.options.alive())
      .catch(() => false);
    const target = alive ? this.options.url : `${this.options.url.replace(/\/+$/, '')}/fail`;
    try {
      const response = await this.send(target, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    } catch (error) {
      if (this.delivering) {
        this.delivering = false;
        this.log('error', 'the heartbeat could not be delivered to the external check', {
          host: this.host,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return 'UNREACHABLE';
    }
    if (!this.delivering) {
      this.delivering = true;
      this.log('info', 'the heartbeat is delivered to the external check again', {
        host: this.host,
      });
    }
    return alive ? 'OK' : 'FAIL';
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = null;
  }

  private async run(): Promise<void> {
    while (this.running) {
      await this.pingOnce();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.intervalMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }
}
