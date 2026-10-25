import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

/** What the fake does with the next call of a path. */
export type FeedBehaviour =
  | { readonly type: 'status'; readonly status: number }
  /** The connection is cut without an answer. */
  | { readonly type: 'drop' }
  /** No answer at all (the client's timeout ends it). */
  | { readonly type: 'hang' }
  /** The answer comes after this many milliseconds. */
  | { readonly type: 'slow'; readonly ms: number }
  /** A body that never ends, so that the size limit has to stop it. */
  | { readonly type: 'endless' }
  /** An answer that says it is this many bytes long. */
  | { readonly type: 'declared'; readonly bytes: number };

export interface FeedRoute {
  readonly body: string;
  readonly contentType?: string;
  readonly etag?: string;
  readonly lastModified?: string;
  /** Like a server that sends an ETag but answers 200 to every request (Al Jazeera does). */
  readonly ignoreConditions?: boolean;
  readonly gzip?: boolean;
}

export interface FeedRequest {
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly at: number;
}

/**
 * A few feeds on a local port for the tests of the feed client and the poller: it serves the bodies a
 * test sets, answers a conditional request with 304 when the ETag or the date still matches, records
 * every request, and can be told to fail the next calls of a path.
 */
export class FakeFeeds {
  readonly requests: FeedRequest[] = [];
  private readonly routes = new Map<string, FeedRoute>();
  private readonly behaviours = new Map<string, FeedBehaviour[]>();
  private readonly server: Server;
  private readonly open = new Set<ServerResponse>();
  /** How many endless bodies were cut by the client. */
  cancelled = 0;
  private base = '';

  constructor() {
    this.server = createServer((request, response) => {
      this.handle(request, response);
    });
  }

  get baseUrl(): string {
    return this.base;
  }

  url(path: string): string {
    return `${this.base}${path}`;
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

  set(path: string, route: FeedRoute): void {
    this.routes.set(path, route);
  }

  /** The next call of `path` behaves like this (calls queue up). */
  next(path: string, behaviour: FeedBehaviour): void {
    this.behaviours.set(path, [...(this.behaviours.get(path) ?? []), behaviour]);
  }

  requestsTo(path: string): FeedRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    this.open.add(response);
    response.on('close', () => {
      this.open.delete(response);
    });
    const url = new URL(request.url ?? '/', 'http://fake');
    const path = `${url.pathname}${url.search}`;
    this.requests.push({ path, headers: request.headers, at: Date.now() });

    const behaviour = this.behaviours.get(path)?.shift();
    if (behaviour !== undefined) {
      switch (behaviour.type) {
        case 'drop':
          response.destroy();
          return;
        case 'hang':
          return;
        case 'status':
          response.writeHead(behaviour.status, { 'content-type': 'text/plain' });
          response.end('failed');
          return;
        case 'declared':
          response.writeHead(200, {
            'content-type': 'text/xml',
            'content-length': String(behaviour.bytes),
          });
          response.write('<rss>');
          return;
        case 'endless': {
          response.writeHead(200, { 'content-type': 'text/xml' });
          const timer = setInterval(() => {
            response.write('x'.repeat(10_000));
          }, 1);
          response.on('close', () => {
            clearInterval(timer);
            this.cancelled += 1;
          });
          return;
        }
        case 'slow':
          setTimeout(() => {
            this.serve(request, response, path);
          }, behaviour.ms);
          return;
      }
    }
    this.serve(request, response, path);
  }

  private serve(request: IncomingMessage, response: ServerResponse, path: string): void {
    const route = this.routes.get(path);
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    const headers: Record<string, string> = {
      'content-type': route.contentType ?? 'application/xml',
    };
    if (route.etag !== undefined) headers.etag = route.etag;
    if (route.lastModified !== undefined) headers['last-modified'] = route.lastModified;
    if (route.ignoreConditions !== true) {
      const noneMatch = request.headers['if-none-match'];
      const modifiedSince = request.headers['if-modified-since'];
      if (
        (route.etag !== undefined && noneMatch === route.etag) ||
        (route.lastModified !== undefined && modifiedSince === route.lastModified)
      ) {
        response.writeHead(304, headers);
        response.end();
        return;
      }
    }
    const body = Buffer.from(route.body, 'utf8');
    if (route.gzip === true) {
      headers['content-encoding'] = 'gzip';
      const packed = gzipSync(body);
      headers['content-length'] = String(packed.byteLength);
      response.writeHead(200, headers);
      response.end(packed);
      return;
    }
    // like most servers, it says how long the answer is
    headers['content-length'] = String(body.byteLength);
    response.writeHead(200, headers);
    response.end(body);
  }
}
