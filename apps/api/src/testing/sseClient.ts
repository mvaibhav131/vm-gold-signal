import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';

import { SESSION_COOKIE } from '../auth/guard';

export interface ParsedFrame {
  readonly id: string | null;
  readonly event: string | null;
  readonly data: string | null;
  readonly retry: number | null;
  /** A comment line (`: hb`), without the colon. */
  readonly comment: string | null;
}

export interface SseConnection {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  /** Every frame received so far, in order (comments included). */
  readonly frames: ParsedFrame[];
  /** The events (frames that have an event name), parsed, in order. */
  events(): { id: string | null; event: string; data: unknown }[];
  /** The next frame after the ones already taken that satisfies `match`; rejects after `timeoutMs`. */
  next(match?: (frame: ParsedFrame) => boolean, timeoutMs?: number): Promise<ParsedFrame>;
  /** Ends when the server or the test closes the connection. */
  readonly closed: Promise<void>;
  close(): void;
}

function parseFrame(text: string): ParsedFrame {
  let id: string | null = null;
  let event: string | null = null;
  let retry: number | null = null;
  let comment: string | null = null;
  const data: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith(':')) comment = line.slice(1).trim();
    else if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('retry:')) retry = Number(line.slice(6).trim());
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  return { id, event, data: data.length === 0 ? null : data.join('\n'), retry, comment };
}

/** Listens on a free port of the loopback address and returns it (the server of a test app). */
export async function listenOnFreePort(app: FastifyInstance): Promise<number> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  return (app.server.address() as AddressInfo).port;
}

/** An `EventSource` that a test can read frame by frame. Resolves once the response head has arrived. */
export function openStream(
  port: number,
  options: { cookie?: string; lastEventId?: string; path?: string } = {},
): Promise<SseConnection> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (options.cookie !== undefined) headers.cookie = `${SESSION_COOKIE}=${options.cookie}`;
    if (options.lastEventId !== undefined) headers['last-event-id'] = options.lastEventId;
    const request = http.request(
      { host: '127.0.0.1', port, path: options.path ?? '/api/v1/stream', headers },
      (response) => {
        const frames: ParsedFrame[] = [];
        const waiting: (() => void)[] = [];
        let taken = 0;
        let buffer = '';
        let ended = false;
        response.setEncoding('utf8');
        const closed = new Promise<void>((done) => {
          const finish = (): void => {
            ended = true;
            for (const wake of waiting.splice(0)) wake();
            done();
          };
          response.on('end', finish);
          response.on('close', finish);
          response.on('error', finish);
        });
        response.on('data', (chunk: string) => {
          buffer += chunk;
          let at = buffer.indexOf('\n\n');
          while (at !== -1) {
            frames.push(parseFrame(buffer.slice(0, at)));
            buffer = buffer.slice(at + 2);
            at = buffer.indexOf('\n\n');
          }
          for (const wake of waiting.splice(0)) wake();
        });
        const connection: SseConnection = {
          status: response.statusCode ?? 0,
          headers: response.headers,
          frames,
          events: () =>
            frames
              .filter((frame) => frame.event !== null)
              .map((frame) => ({
                id: frame.id,
                event: frame.event ?? '',
                data: frame.data === null ? null : (JSON.parse(frame.data) as unknown),
              })),
          async next(match = () => true, timeoutMs = 3000) {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
              while (taken < frames.length) {
                const frame = frames[taken];
                if (frame === undefined) break;
                taken += 1;
                if (match(frame)) return frame;
              }
              if (ended) throw new Error('the stream ended while waiting for a frame');
              const left = deadline - Date.now();
              if (left <= 0) {
                throw new Error(
                  `no matching frame within ${String(timeoutMs)} ms; got ${JSON.stringify(frames.slice(taken - 0))}`,
                );
              }
              await new Promise<void>((wake) => {
                const timer = setTimeout(wake, left);
                waiting.push(() => {
                  clearTimeout(timer);
                  wake();
                });
              });
            }
          },
          closed,
          close() {
            request.destroy();
          },
        };
        resolve(connection);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/** The frames that are events of this name. */
export const isEvent =
  (name: string) =>
  (frame: ParsedFrame): boolean =>
    frame.event === name;
