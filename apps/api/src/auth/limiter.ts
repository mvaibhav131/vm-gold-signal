/** Thrown when too many password checks are waiting: the caller answers 429 instead of using up the memory of the VM. */
export class BusyError extends Error {
  constructor() {
    super('too many requests are waiting');
    this.name = 'BusyError';
  }
}

/**
 * At most `concurrency` tasks run at a time and at most `maxQueue` wait; one more is refused at once. An Argon2 hash
 * needs tens of megabytes: without this, a burst of logins could use up the memory of the VM before the throttle
 * (which counts attempts) has seen the first of them.
 */
export class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly concurrency: number;
  private readonly maxQueue: number;

  constructor(concurrency: number, maxQueue: number) {
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.concurrency) {
      this.active += 1;
    } else if (this.waiting.length < this.maxQueue) {
      // the slot is handed over by the task that ends: `active` stays as it is
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    } else {
      throw new BusyError();
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next === undefined) this.active -= 1;
      else next();
    }
  }
}
