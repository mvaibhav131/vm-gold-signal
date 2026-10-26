import { SSE_REPLAY_BUFFER, sseEventSchema, type SseEvent } from '@vmgs/contracts';

/** An event with the id it was given (`<bootId>:<n>`); a quote has none, because it is never replayed. */
export interface Stamped {
  readonly id: string | null;
  readonly event: SseEvent;
}

type QuoteEvent = Extract<SseEvent, { event: 'quote' }>;
type StateEvent = Exclude<SseEvent, { event: 'quote' }>;

export interface Subscription {
  /** What the client has missed, to be sent first (empty for a new client). */
  readonly backlog: readonly Stamped[];
  /** Set instead of a backlog when the client cannot be caught up: it reloads its state over REST. */
  readonly resync: Stamped | null;
  unsubscribe(): void;
}

const ID_SHAPE = /^([A-Za-z0-9-]{1,64}):(\d+)$/;

/** The events that say how things are now: of these only the newest matters to a client that comes back. */
function supersedeKey(event: SseEvent): string | null {
  switch (event.event) {
    case 'signal_update':
      return `signal_update:${event.data.id}`;
    case 'engine':
    case 'health':
      return event.event;
    case 'news':
      // a headline is something that happened; the state of the window is only how it is
      return event.data.headline === undefined ? 'news' : null;
    case 'quote':
    case 'resync':
    case 'signal':
      return null;
  }
}

/**
 * The events of the stream (04 section 3): ids `<bootId>:<n>`, the last `bufferSize` events that are not quotes kept for
 * a client that reconnects with `Last-Event-ID`, and a `resync` for one that cannot be caught up (an id of another boot
 * of the API, or older than what is kept). Everything here is synchronous: a client is given its backlog and starts to
 * listen in one step, so it can neither miss an event nor see one twice.
 */
export class EventHub {
  private readonly buffer: { n: number; stamped: Stamped }[] = [];
  private readonly listeners = new Set<(stamped: Stamped) => void>();
  private counter = 0;

  constructor(
    readonly bootId: string,
    private readonly bufferSize: number = SSE_REPLAY_BUFFER,
  ) {}

  get subscribers(): number {
    return this.listeners.size;
  }

  /** The id of the newest event that was made (`<bootId>:0` before any). */
  get lastId(): string {
    return `${this.bootId}:${String(this.counter)}`;
  }

  /** Makes an event that is kept for the replay and sent to everybody who listens. A malformed one is refused. */
  publish(event: StateEvent): Stamped {
    const checked = sseEventSchema.parse(event);
    this.counter += 1;
    const stamped: Stamped = { id: `${this.bootId}:${String(this.counter)}`, event: checked };
    this.buffer.push({ n: this.counter, stamped });
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    this.fanOut(stamped);
    return stamped;
  }

  /** A quote goes to everybody who listens now, and is kept nowhere. */
  quote(event: QuoteEvent): void {
    this.fanOut({ id: null, event: sseEventSchema.parse(event) });
  }

  subscribe(listener: (stamped: Stamped) => void, lastEventId?: string): Subscription {
    let backlog: Stamped[] = [];
    let resync: Stamped | null = null;
    if (lastEventId !== undefined) {
      const caught = this.missedSince(lastEventId);
      if (caught === null) {
        resync = { id: this.lastId, event: { event: 'resync', data: {} } };
      } else {
        backlog = caught;
      }
    }
    this.listeners.add(listener);
    return {
      backlog,
      resync,
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** Tells everybody to reload: something may have been missed (the listener of the database was lost). */
  resyncAll(): void {
    this.fanOut({ id: this.lastId, event: { event: 'resync', data: {} } });
  }

  /** The events after `lastEventId` that are still current, or null when they cannot be given. */
  private missedSince(lastEventId: string): Stamped[] | null {
    const match = ID_SHAPE.exec(lastEventId);
    if (match?.[1] !== this.bootId) return null;
    const seen = Number(match[2]);
    if (!Number.isSafeInteger(seen) || seen > this.counter) return null;
    const first = this.buffer[0]?.n ?? this.counter + 1;
    // the event right after the one the client saw is gone: there is a hole
    if (seen + 1 < first) return null;
    const missed = this.buffer.filter((entry) => entry.n > seen);
    const newest = new Map<string, number>();
    for (const { n, stamped } of missed) {
      const key = supersedeKey(stamped.event);
      if (key !== null) newest.set(key, n);
    }
    return missed
      .filter(({ n, stamped }) => {
        const key = supersedeKey(stamped.event);
        return key === null || newest.get(key) === n;
      })
      .map((entry) => entry.stamped);
  }

  private fanOut(stamped: Stamped): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(stamped);
      } catch {
        // a listener that fails is a connection that is gone: it must not stop the others
        this.listeners.delete(listener);
      }
    }
  }
}

/** One event as it goes over the wire (the `id:` line is left out for a quote). */
export function frameOf(stamped: Stamped): string {
  const lines: string[] = [];
  if (stamped.id !== null) lines.push(`id: ${stamped.id}`);
  lines.push(`event: ${stamped.event.event}`, `data: ${JSON.stringify(stamped.event.data)}`);
  return `${lines.join('\n')}\n\n`;
}

/** The comment that keeps a quiet connection open (every 15 s, 04 section 3). */
export const HEARTBEAT_FRAME = ': hb\n\n';
