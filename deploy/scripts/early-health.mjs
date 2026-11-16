// Started by entry.sh before the worker, when the container has a PORT. A host looks at that port a few seconds after the
// start (Back4app: about 10 s, with a timeout of 1 s), and the worker needs about 15 s on a quarter of a CPU before it
// listens, because it compiles its code when it starts. This answers on PORT at once and hands every question to the health
// page of the worker, which listens one port higher, as soon as that page is there.
//
//   node early-health.mjs PORT INNER_PORT
//
// While the worker is still loading (nothing listens on INNER_PORT) it says 200 "starting", for three minutes; after that
// 503, because a worker that does not come up in three minutes is not healthy. Only GET and HEAD of / and /health are
// answered; nothing else is passed on.
import { request as httpRequest, createServer } from 'node:http';
import process from 'node:process';

const port = Number(process.argv[2]);
const inner = Number(process.argv[3]);
if (!Number.isInteger(port) || !Number.isInteger(inner)) {
  process.stderr.write('usage: node early-health.mjs PORT INNER_PORT\n');
  process.exit(2);
}
const startedAt = Date.now();
const LOADING_MS = 180_000;

function reply(response, status, text) {
  response.writeHead(status, { 'content-type': 'text/plain' }).end(`${text}\n`);
}

const server = createServer((incoming, response) => {
  const path = (incoming.url ?? '').split('?')[0];
  if (
    (incoming.method !== 'GET' && incoming.method !== 'HEAD') ||
    (path !== '/' && path !== '/health')
  ) {
    reply(response, 404, 'not found');
    return;
  }
  const forward = httpRequest(
    { host: '127.0.0.1', port: inner, path, method: incoming.method, timeout: 3000 },
    (answer) => {
      response.writeHead(answer.statusCode ?? 503, { 'content-type': 'text/plain' });
      answer.pipe(response);
    },
  );
  forward.on('timeout', () => {
    forward.destroy();
  });
  forward.on('error', () => {
    if (response.headersSent) return;
    if (Date.now() - startedAt < LOADING_MS)
      reply(response, 200, 'starting: the worker is loading');
    else reply(response, 503, 'the worker does not answer');
  });
  forward.end();
});

server.listen(port, '0.0.0.0');
process.on('SIGTERM', () => {
  process.exit(0);
});
process.on('SIGINT', () => {
  process.exit(0);
});
