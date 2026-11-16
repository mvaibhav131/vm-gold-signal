import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = new URL(
  '../../../../deploy/scripts/early-health.mjs',
  import.meta.url,
).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const children: ChildProcess[] = [];
const servers: Server[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

async function answerOf(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, init);
  return { status: response.status, text: await response.text() };
}

async function until(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`${url} never came up`);
}

async function start(): Promise<{ outer: string; inner: number }> {
  const [port, inner] = [await freePort(), await freePort()];
  children.push(
    spawn(process.execPath, [SCRIPT, String(port), String(inner)], { stdio: 'ignore' }),
  );
  const outer = `http://127.0.0.1:${String(port)}`;
  await until(outer);
  return { outer, inner };
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGTERM');
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  }
});

describe('early-health.mjs, the answer on PORT while the worker is still loading', () => {
  it('says 200 "starting" at once, while nothing listens on the inner port', async () => {
    const { outer } = await start();
    for (const path of ['/', '/health', '/health?x=1']) {
      expect(await answerOf(`${outer}${path}`)).toEqual({
        status: 200,
        text: 'starting: the worker is loading\n',
      });
    }
  });

  it('passes the health page of the worker through as soon as it is there, with its status and its text', async () => {
    const { outer, inner } = await start();
    let status = 200;
    let text = 'ok: the heartbeat of the worker is 3 s old\n';
    const worker = createServer((_request, response) => {
      response.writeHead(status, { 'content-type': 'text/plain' }).end(text);
    });
    servers.push(worker);
    await new Promise<void>((resolve) => worker.listen(inner, '127.0.0.1', resolve));

    expect(await answerOf(`${outer}/health`)).toEqual({ status: 200, text });
    status = 503;
    text = 'the heartbeat of the worker is 600 s old\n';
    expect(await answerOf(`${outer}/`)).toEqual({ status: 503, text });
  });

  it('answers nothing but GET and HEAD of / and /health: everything else is 404 and never reaches the worker', async () => {
    const { outer, inner } = await start();
    let reached = 0;
    const worker = createServer((_request, response) => {
      reached += 1;
      response.writeHead(200).end('ok\n');
    });
    servers.push(worker);
    await new Promise<void>((resolve) => worker.listen(inner, '127.0.0.1', resolve));

    expect((await answerOf(`${outer}/signals`)).status).toBe(404);
    expect((await answerOf(`${outer}/health/x`)).status).toBe(404);
    expect((await answerOf(`${outer}/health`, { method: 'POST' })).status).toBe(404);
    expect(reached).toBe(0);
    expect((await answerOf(`${outer}/health`, { method: 'HEAD' })).status).toBe(200);
    expect(reached).toBe(1);
  });

  it('stops on SIGTERM (exit code 0 where signals exist; Windows kills the process) and refuses arguments that are not ports', async () => {
    const { outer } = await start();
    const child = children[0];
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child?.once('exit', (code, signal) => {
        resolve({ code, signal });
      }),
    );
    child?.kill('SIGTERM');
    const result = await exited;
    if (process.platform === 'win32') expect(result.signal ?? result.code).toBeTruthy();
    else expect(result).toEqual({ code: 0, signal: null });
    await expect(fetch(outer)).rejects.toThrow();

    const bad = spawn(process.execPath, [SCRIPT, 'x', 'y'], { stdio: 'ignore' });
    expect(await new Promise<number | null>((resolve) => bad.once('exit', resolve))).toBe(2);
  });
});
