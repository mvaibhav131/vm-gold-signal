import { afterEach, describe, expect, it, vi } from 'vitest';

import { HealthPinger } from './pinger';

const URL_OK = 'https://hc-ping.com/11111111-2222-3333-4444-555555555555';

interface Call {
  url: string;
  timeout: boolean;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function setup(
  options: {
    alive?: () => Promise<boolean>;
    respond?: (url: string) => Response | Promise<Response>;
    intervalMs?: number;
  } = {},
) {
  const calls: Call[] = [];
  const logs: { level: string; message: string; details?: Record<string, unknown> }[] = [];
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    calls.push({ url, timeout: init?.signal instanceof AbortSignal });
    return (options.respond ?? (() => new Response('OK', { status: 200 })))(url);
  }) as typeof fetch;
  const pinger = new HealthPinger({
    url: URL_OK,
    alive: options.alive ?? (() => Promise.resolve(true)),
    fetch: fetchFake,
    intervalMs: options.intervalMs ?? 60_000,
    log: (level, message, details) =>
      logs.push({ level, message, ...(details === undefined ? {} : { details }) }),
  });
  return { pinger, calls, logs };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('HealthPinger.pingOnce', () => {
  it('pings the URL of the check when the worker is working', async () => {
    const { pinger, calls } = setup();
    expect(await pinger.pingOnce()).toBe('OK');
    expect(calls).toEqual([{ url: URL_OK, timeout: true }]);
  });

  it('pings /fail when the worker heartbeat is stale', async () => {
    const { pinger, calls } = setup({ alive: () => Promise.resolve(false) });
    expect(await pinger.pingOnce()).toBe('FAIL');
    expect(calls[0]?.url).toBe(`${URL_OK}/fail`);
  });

  it('counts a database that cannot be read as a worker that is not working', async () => {
    const { pinger, calls } = setup({
      alive: () => Promise.reject(new Error('connection refused')),
    });
    expect(await pinger.pingOnce()).toBe('FAIL');
    expect(calls[0]?.url).toBe(`${URL_OK}/fail`);
  });

  it('does not double the slash before /fail', async () => {
    const calls: string[] = [];
    const pinger = new HealthPinger({
      url: `${URL_OK}/`,
      alive: () => Promise.resolve(false),
      fetch: (input: string | URL | Request) => {
        calls.push(urlOf(input));
        return Promise.resolve(new Response('OK'));
      },
    });
    await pinger.pingOnce();
    expect(calls).toEqual([`${URL_OK}/fail`]);
  });

  it('reports an unreachable check, once, and tells when pings are delivered again', async () => {
    let up = false;
    const { pinger, logs } = setup({
      respond: () => {
        if (!up) throw new Error('getaddrinfo ENOTFOUND hc-ping.com');
        return new Response('OK');
      },
    });
    expect(await pinger.pingOnce()).toBe('UNREACHABLE');
    expect(await pinger.pingOnce()).toBe('UNREACHABLE');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'error', details: { host: 'hc-ping.com' } });

    up = true;
    expect(await pinger.pingOnce()).toBe('OK');
    expect(await pinger.pingOnce()).toBe('OK');
    expect(logs.map((entry) => entry.level)).toEqual(['error', 'info']);
  });

  it('counts an HTTP error as not delivered', async () => {
    const { pinger, logs } = setup({ respond: () => new Response('nope', { status: 404 }) });
    expect(await pinger.pingOnce()).toBe('UNREACHABLE');
    expect(logs[0]?.details).toMatchObject({ error: 'HTTP 404' });
  });

  it('never writes the secret URL into the log', async () => {
    const { pinger, logs } = setup({
      respond: () => {
        throw new Error('boom');
      },
    });
    await pinger.pingOnce();
    expect(JSON.stringify(logs)).not.toContain('11111111-2222');
  });
});

describe('HealthPinger loop', () => {
  it('pings at once, then every interval, and stops when asked', async () => {
    vi.useFakeTimers();
    const { pinger, calls } = setup({ intervalMs: 60_000 });
    pinger.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(4);

    await pinger.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls).toHaveLength(4);
  });

  it('start twice is one loop, and stop without a start is harmless', async () => {
    vi.useFakeTimers();
    const { pinger, calls } = setup();
    await pinger.stop();
    pinger.start();
    pinger.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await pinger.stop();
  });
});
