import { afterEach, describe, expect, it } from 'vitest';

import { startHealthServer, type HealthServer } from './healthServer';

const open: HealthServer[] = [];

async function serve(age: () => Promise<number | null>, startupGraceMs = 0): Promise<string> {
  const server = await startHealthServer({ port: 0, heartbeatAgeMs: age, startupGraceMs });
  open.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
}

afterEach(async () => {
  for (const server of open.splice(0)) await server.close();
});

describe('the health page of the worker', () => {
  it('answers 200 while the heartbeat is fresh, and says how old it is', async () => {
    const base = await serve(() => Promise.resolve(4_000));
    for (const path of ['/', '/health', '/health?x=1']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('ok: the heartbeat of the worker is 4 s old\n');
    }
  });

  it('answers 503 when the heartbeat is old, when there is none, and when the database cannot be read', async () => {
    const stale = await serve(() => Promise.resolve(10 * 60_000));
    const old = await fetch(`${stale}/health`);
    expect(old.status).toBe(503);
    expect(await old.text()).toBe('the heartbeat of the worker is 600 s old\n');

    const none = await fetch(`${await serve(() => Promise.resolve(null))}/health`);
    expect(none.status).toBe(503);
    expect(await none.text()).toBe('no heartbeat yet\n');

    const broken = await fetch(
      `${await serve(() => Promise.reject(new Error('connection lost: secret-host')))}/health`,
    );
    expect(broken.status).toBe(503);
    expect(await broken.text()).toBe('the database cannot be read\n');
  });

  it('answers 200 "starting" while the first minutes are not over, whatever the heartbeat says, and 503 after them', async () => {
    const early = await serve(() => Promise.resolve(null), 60_000);
    const starting = await fetch(`${early}/health`);
    expect(starting.status).toBe(200);
    expect(await starting.text()).toBe('starting: no fresh heartbeat yet\n');
    const unreadable = await fetch(
      `${await serve(() => Promise.reject(new Error('down')), 60_000)}/health`,
    );
    expect(unreadable.status).toBe(200);
    expect(await unreadable.text()).toBe('starting: the database is not read yet\n');

    // the grace is over at once when it is 0: a stale heartbeat is a failure then
    expect((await fetch(`${await serve(() => Promise.resolve(null), 0)}/health`)).status).toBe(503);
  });

  it('serves nothing else: other paths and other methods are 404', async () => {
    const base = await serve(() => Promise.resolve(1_000));
    expect((await fetch(`${base}/signals`)).status).toBe(404);
    expect((await fetch(`${base}/health/../etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(404);
  });

  it('stops listening when it is closed', async () => {
    const server = await startHealthServer({ port: 0, heartbeatAgeMs: () => Promise.resolve(1) });
    const base = `http://127.0.0.1:${String(server.port)}`;
    expect((await fetch(base)).status).toBe(200);
    await server.close();
    await expect(fetch(base)).rejects.toThrow();
  });
});
