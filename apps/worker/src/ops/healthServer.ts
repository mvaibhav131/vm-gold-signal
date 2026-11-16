import { createServer, type Server } from 'node:http';

import { isFresh } from './alive';

export interface HealthServer {
  /** The port it listens on (the real one when 0 was asked for). */
  readonly port: number;
  close(): Promise<void>;
}

/**
 * A page for the hosts that want to see a container answer on a port (the "web service" kind of host runs a worker only
 * if it listens on `PORT`). It tells what the check of the deploy tells: whether the heartbeat of the worker in the
 * database is fresh. 200 when it is, 503 when it is not; nothing else is served and nothing about the data is shown.
 * During the first `startupGraceMs` (the engine warms up and the first heartbeat is not written yet) it answers 200
 * "starting", so that a host does not judge a worker that is still starting.
 */
export async function startHealthServer(options: {
  port: number;
  heartbeatAgeMs: () => Promise<number | null>;
  startupGraceMs?: number;
}): Promise<HealthServer> {
  const startedAt = Date.now();
  const grace = options.startupGraceMs ?? 120_000;
  const server: Server = createServer((request, response) => {
    if ((request.method !== 'GET' && request.method !== 'HEAD') || !isHealthPath(request.url)) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
      return;
    }
    const starting = Date.now() - startedAt < grace;
    options.heartbeatAgeMs().then(
      (age) => {
        const fresh = isFresh(age);
        const status = fresh || starting ? 200 : 503;
        const text = fresh
          ? `ok: the heartbeat of the worker is ${String(Math.round((age ?? 0) / 1000))} s old\n`
          : starting
            ? 'starting: no fresh heartbeat yet\n'
            : age === null
              ? 'no heartbeat yet\n'
              : `the heartbeat of the worker is ${String(Math.round(age / 1000))} s old\n`;
        response.writeHead(status, { 'content-type': 'text/plain' }).end(text);
      },
      () => {
        response
          .writeHead(starting ? 200 : 503, { 'content-type': 'text/plain' })
          .end(
            starting ? 'starting: the database is not read yet\n' : 'the database cannot be read\n',
          );
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

function isHealthPath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0];
  return path === '/' || path === '/health';
}
