export interface BackoffOptions {
  /** The first wait, in milliseconds. */
  readonly initialMs?: number;
  /** Each further wait is this many times longer. */
  readonly factor?: number;
  /** No wait is longer than this, jitter included. */
  readonly capMs?: number;
  /** A fraction: each wait varies by up to this much either way, so that many clients do not retry together. */
  readonly jitter?: number;
  /** A number in [0, 1); injected so that tests are exact. */
  readonly random?: () => number;
}

export const DEFAULT_BACKOFF = { initialMs: 1_000, factor: 2, capMs: 60_000, jitter: 0.2 } as const;

/**
 * Reconnect waits: exponential with jitter and a cap (01_HLD section 6). `next()` gives the wait
 * before the next attempt and counts it; `reset()` is called once a connection has proved itself.
 */
export class Backoff {
  private readonly initialMs: number;
  private readonly factor: number;
  private readonly capMs: number;
  private readonly jitter: number;
  private readonly random: () => number;
  private count = 0;

  constructor(options: BackoffOptions = {}) {
    this.initialMs = options.initialMs ?? DEFAULT_BACKOFF.initialMs;
    this.factor = options.factor ?? DEFAULT_BACKOFF.factor;
    this.capMs = options.capMs ?? DEFAULT_BACKOFF.capMs;
    this.jitter = options.jitter ?? DEFAULT_BACKOFF.jitter;
    this.random = options.random ?? Math.random;
    if (!(this.initialMs > 0)) throw new RangeError('initialMs must be above 0');
    if (!(this.factor >= 1)) throw new RangeError('factor must be at least 1');
    if (!(this.capMs >= this.initialMs)) throw new RangeError('capMs must not be below initialMs');
    if (!(this.jitter >= 0 && this.jitter < 1)) throw new RangeError('jitter must be in [0, 1)');
  }

  /** How many waits were handed out since the last reset. */
  get attempts(): number {
    return this.count;
  }

  next(): number {
    const base = Math.min(this.capMs, this.initialMs * this.factor ** this.count);
    this.count += 1;
    const spread = 1 - this.jitter + 2 * this.jitter * this.random();
    return Math.min(this.capMs, Math.round(base * spread));
  }

  reset(): void {
    this.count = 0;
  }
}
