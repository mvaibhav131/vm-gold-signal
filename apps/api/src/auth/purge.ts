import type { AuthStore, PurgeCounts } from './store';
import { DEFAULT_PURGE_POLICY, type PurgePolicy } from './policy';

type Log = (level: 'info' | 'error', message: string, details?: Record<string, unknown>) => void;

export interface AuthPurgeOptions {
  readonly store: AuthStore;
  readonly policy?: PurgePolicy;
  readonly now?: () => number;
  readonly everyMs?: number;
  readonly log?: Log;
}

/**
 * The purge that belongs to the API process (01 section 7): expired sessions, old login attempts and the old
 * security audit. The worker has no rights on these tables. It runs once at the start and then every six hours.
 */
export class AuthPurge {
  private readonly options: AuthPurgeOptions;
  private readonly now: () => number;
  private readonly log: Log;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: AuthPurgeOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  /** One purge. A failure is logged and returned as null: it must never stop the API. */
  async runOnce(): Promise<PurgeCounts | null> {
    try {
      const counts = await this.options.store.purge(
        this.now(),
        this.options.policy ?? DEFAULT_PURGE_POLICY,
      );
      this.log('info', 'the authentication tables were purged', { ...counts });
      return counts;
    } catch (error) {
      this.log('error', 'the purge of the authentication tables failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  start(): void {
    if (this.timer !== null) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.options.everyMs ?? 6 * 3_600_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
