import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** What the fake does with the next call. */
export type CalendarBehaviour =
  | { readonly type: 'status'; readonly status: number }
  /** The connection is cut without an answer. */
  | { readonly type: 'drop' }
  /** No answer at all (the client's timeout ends it). */
  | { readonly type: 'hang' }
  /** A page that is not JSON. */
  | { readonly type: 'garbage' }
  /** JSON that is not a list. */
  | { readonly type: 'object' };

export interface CalendarRequest {
  readonly path: string;
  readonly query: URLSearchParams;
  readonly at: number;
}

/**
 * The calendar of Biquote (`/api/Calendar`, `/api/Calendar/{eventId}/history`) on a local port, for
 * the tests of the client, the poller and the alerts. It serves the rows a test puts in, as JSON
 * rows of the real service, filters them by `from`, `to`, `countries` and `limit`, and can be told
 * to fail the next calls.
 */
export class FakeCalendar {
  /** The rows of the calendar, in the JSON shape of the service. */
  rows: Record<string, unknown>[] = [];
  /** The history of a series (`eventId`). */
  readonly history = new Map<string, Record<string, unknown>[]>();
  readonly requests: CalendarRequest[] = [];
  private readonly server: Server;
  private readonly behaviours: CalendarBehaviour[] = [];
  private readonly open = new Set<ServerResponse>();
  private base = '';

  constructor() {
    this.server = createServer((request, response) => {
      this.handle(request, response);
    });
  }

  get baseUrl(): string {
    return this.base;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.base = `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
  }

  async stop(): Promise<void> {
    for (const response of this.open) response.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  /** The next call behaves like this (calls queue up). */
  next(behaviour: CalendarBehaviour): void {
    this.behaviours.push(behaviour);
  }

  /** Calls of `/api/Calendar` (not the history). */
  get readings(): CalendarRequest[] {
    return this.requests.filter((request) => request.path === '/api/Calendar');
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    this.open.add(response);
    response.on('close', () => {
      this.open.delete(response);
    });
    const url = new URL(request.url ?? '/', 'http://fake');
    this.requests.push({ path: url.pathname, query: url.searchParams, at: Date.now() });

    const behaviour = this.behaviours.shift();
    if (behaviour !== undefined) {
      switch (behaviour.type) {
        case 'drop':
          response.destroy();
          return;
        case 'hang':
          return;
        case 'garbage':
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<html>maintenance</html>');
          return;
        case 'object':
          this.json(response, 200, { error: 'not a list' });
          return;
        case 'status':
          this.json(response, behaviour.status, { error: 'failed' });
          return;
      }
    }

    if (url.pathname === '/api/Calendar') {
      this.json(response, 200, this.range(url.searchParams));
      return;
    }
    const match = /^\/api\/Calendar\/(.+)\/history$/.exec(url.pathname);
    if (match !== null) {
      const rows = this.history.get(decodeURIComponent(match[1] ?? ''));
      if (rows === undefined) this.json(response, 404, { error: 'unknown event' });
      else this.json(response, 200, rows);
      return;
    }
    this.json(response, 404, { error: 'not found' });
  }

  private range(query: URLSearchParams): Record<string, unknown>[] {
    const from = Date.parse(query.get('from') ?? '');
    const to = Date.parse(query.get('to') ?? '');
    const countries = query.get('countries')?.split(',') ?? null;
    const limit = Number(query.get('limit') ?? '200');
    return this.rows
      .filter((row) => {
        const time = Date.parse(String(row.time));
        return (
          (Number.isNaN(from) || time >= from) &&
          (Number.isNaN(to) || time <= to) &&
          (countries === null || countries.includes(String(row.countryCode)))
        );
      })
      .slice(0, limit);
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }
}
