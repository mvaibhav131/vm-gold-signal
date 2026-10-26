import type { FastifyInstance, FastifyRequest } from 'fastify';

import { SSE_HEARTBEAT_SECONDS } from '@vmgs/contracts';

import { SESSION_COOKIE } from '../auth/guard';
import { API_BASE } from '../health/routes';
import { ProblemError } from '../http/problem';
import { HEARTBEAT_FRAME, frameOf, type EventHub, type Stamped } from './hub';

export interface StreamDeps {
  readonly hub: EventHub;
  /** The owner has a phone, a laptop and a tab or two: more than this is a client that does not close its streams. */
  readonly maxConnections?: number;
  readonly heartbeatMs?: number;
  /** How often an open stream asks whether its session still stands. */
  readonly revalidateMs?: number;
  /** A client that does not read: at this many bytes waiting the connection is dropped (it reconnects and is caught up). */
  readonly maxBufferedBytes?: number;
}

/** `Last-Event-ID` of a reconnecting browser (the standard header; nothing else carries it). */
function lastEventIdOf(request: FastifyRequest): string | undefined {
  const value = request.headers['last-event-id'];
  return typeof value === 'string' && value !== '' ? value.slice(0, 128) : undefined;
}

/**
 * `GET /stream` (04 section 3). A session is needed like for every route; it is looked at again every minute, so that a
 * logout or a revocation ends a stream that has been open for hours. The first thing a client gets is what it missed
 * (or `resync`), then everything that happens, and a comment line every 15 seconds so that no proxy closes a quiet stream.
 */
export function registerStreamRoutes(app: FastifyInstance, deps: StreamDeps): void {
  const maxConnections = deps.maxConnections ?? 8;
  const heartbeatMs = deps.heartbeatMs ?? SSE_HEARTBEAT_SECONDS * 1000;
  const revalidateMs = deps.revalidateMs ?? 60_000;
  const maxBuffered = deps.maxBufferedBytes ?? 512 * 1024;
  const ends = new Set<() => void>();

  // a stream never ends by itself: a server that is stopping has to end them, or it would wait for them for ever
  // (preClose runs before the server stops accepting and waits for its connections)
  app.addHook('preClose', () => {
    for (const end of [...ends]) end();
  });

  app.route({
    method: 'GET',
    url: `${API_BASE}/stream`,
    config: { public: false },
    handler: (request, reply) => {
      if (ends.size >= maxConnections) {
        throw new ProblemError(429, 'too_many_streams', 'Too many streams are open.', {
          'Retry-After': '10',
        });
      }
      const token = request.cookies[SESSION_COOKIE];
      const raw = reply.raw;
      reply.hijack();
      // the headers of every answer (security headers, set by the hook) stay; these are the ones of an event stream
      raw.writeHead(200, {
        ...reply.getHeaders(),
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
      } as Record<string, string>);
      // how long a browser waits before it connects again
      raw.write('retry: 3000\n\n');

      let timers: NodeJS.Timeout[] = [];
      let unsubscribe: () => void = () => undefined;
      let finished = false;
      const end = (): void => {
        if (finished) return;
        finished = true;
        ends.delete(end);
        unsubscribe();
        for (const timer of timers) clearInterval(timer);
        timers = [];
        if (!raw.writableEnded) raw.end();
      };
      ends.add(end);

      const send = (frame: string): void => {
        if (finished) return;
        // a client that does not read is dropped: it will come back with its last id and be caught up
        if (raw.writableLength > maxBuffered) {
          raw.destroy();
          end();
          return;
        }
        raw.write(frame);
      };

      const subscription = deps.hub.subscribe((stamped: Stamped) => {
        send(frameOf(stamped));
      }, lastEventIdOf(request));
      unsubscribe = () => {
        subscription.unsubscribe();
      };
      if (subscription.resync !== null) send(frameOf(subscription.resync));
      for (const stamped of subscription.backlog) send(frameOf(stamped));

      timers.push(
        setInterval(() => {
          send(HEARTBEAT_FRAME);
        }, heartbeatMs),
      );
      timers.push(
        setInterval(() => {
          void app
            .sessionStillValid(token)
            .then((valid) => {
              if (!valid) end();
            })
            .catch(() => {
              // the database could not say: the stream stays, and asks again in a minute
            });
        }, revalidateMs),
      );
      for (const timer of timers) timer.unref();

      request.raw.on('close', end);
      raw.on('close', end);
      raw.on('error', end);
    },
  });
}
