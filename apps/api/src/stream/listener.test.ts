import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';

import { SIGNAL_NOTIFY_CHANNEL } from '@vmgs/contracts';

import { SignalListener } from './listener';

class FakeClient extends EventEmitter {
  queries: string[] = [];
  released: (boolean | undefined)[] = [];
  failQuery: Error | null = null;
  query(text: string): Promise<unknown> {
    this.queries.push(text);
    return this.failQuery === null ? Promise.resolve({}) : Promise.reject(this.failQuery);
  }
  release(destroy?: boolean): void {
    this.released.push(destroy);
  }
}

class FakePool {
  clients: FakeClient[] = [];
  /** Errors for the next calls of `connect`, one each; then it works. */
  failures: Error[] = [];
  connect(): Promise<PoolClient> {
    const failure = this.failures.shift();
    if (failure !== undefined) return Promise.reject(failure);
    const client = new FakeClient();
    this.clients.push(client);
    return Promise.resolve(client as unknown as PoolClient);
  }
}

function rig(options: { retryMs?: { first: number; max: number }; keepAliveMs?: number } = {}) {
  const pool = new FakePool();
  const notes: string[] = [];
  const logs: string[] = [];
  let connected = 0;
  const listener = new SignalListener({
    pool: pool as unknown as Pool,
    onNotification: (payload) => notes.push(payload),
    onConnected: () => {
      connected += 1;
    },
    log: (level, message) => logs.push(`${level}: ${message}`),
    retryMs: options.retryMs ?? { first: 1000, max: 8000 },
    ...(options.keepAliveMs === undefined ? {} : { keepAliveMs: options.keepAliveMs }),
  });
  return { pool, listener, notes, logs, connected: () => connected };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SignalListener', () => {
  it('listens on the channel of the worker, hands on its payloads, and says it is connected, also the first time', async () => {
    const r = rig();
    await r.listener.start();
    const client = r.pool.clients[0];
    expect(client?.queries).toEqual([`LISTEN ${SIGNAL_NOTIFY_CHANNEL}`]);
    expect(r.listener.connected).toBe(true);
    expect(r.connected()).toBe(1);

    client?.emit('notification', { channel: SIGNAL_NOTIFY_CHANNEL, payload: '{"id":"x"}' });
    client?.emit('notification', { channel: 'another', payload: 'no' });
    client?.emit('notification', { channel: SIGNAL_NOTIFY_CHANNEL });
    expect(r.notes).toEqual(['{"id":"x"}']);
    r.listener.stop();
  });

  it('is started once: a second start does not make a second connection', async () => {
    const r = rig();
    await r.listener.start();
    await r.listener.start();
    expect(r.pool.clients).toHaveLength(1);
    r.listener.stop();
  });

  it('tries again with a growing wait when it cannot connect, and says it is connected when it can', async () => {
    vi.useFakeTimers();
    const r = rig({ retryMs: { first: 1000, max: 3000 } });
    r.pool.failures = [new Error('down'), new Error('down'), new Error('down'), new Error('down')];
    await r.listener.start();
    expect(r.listener.connected).toBe(false);
    expect(r.connected()).toBe(0);

    await vi.advanceTimersByTimeAsync(999);
    expect(r.logs).toHaveLength(1); // the first wait is 1 s
    await vi.advanceTimersByTimeAsync(1); // 1 s: the second try fails
    expect(r.logs).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1999); // the second wait is 2 s
    expect(r.logs).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.logs).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(2999); // the third is 4 s, but 3 s is the most
    expect(r.logs).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.logs).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(3000); // the fifth try works
    expect(r.listener.connected).toBe(true);
    expect(r.connected()).toBe(1);
    r.listener.stop();
  });

  it('makes the connection again when it was lost, and says so, once per loss', async () => {
    vi.useFakeTimers();
    const r = rig();
    await r.listener.start();
    const first = r.pool.clients[0];
    first?.emit('error', new Error('reset'));
    first?.emit('error', new Error('reset again'));
    expect(r.listener.connected).toBe(false);
    expect(first?.released).toEqual([true]);
    expect(r.logs.filter((line) => line.includes('was lost'))).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(r.pool.clients).toHaveLength(2);
    expect(r.listener.connected).toBe(true);
    expect(r.connected()).toBe(2);
    // the connection that was dropped is not listened to any more
    first?.emit('notification', { channel: SIGNAL_NOTIFY_CHANNEL, payload: 'old' });
    expect(r.notes).toEqual([]);
    r.listener.stop();
  });

  it('starts the waits again from the first one once a connection was made', async () => {
    vi.useFakeTimers();
    const r = rig({ retryMs: { first: 1000, max: 30_000 } });
    r.pool.failures = [new Error('down'), new Error('down'), new Error('down')];
    await r.listener.start(); // fails, waits 1 s
    await vi.advanceTimersByTimeAsync(1000); // fails, waits 2 s
    await vi.advanceTimersByTimeAsync(2000); // fails, waits 4 s
    await vi.advanceTimersByTimeAsync(4000); // works
    expect(r.listener.connected).toBe(true);

    r.pool.clients.at(-1)?.emit('error', new Error('reset'));
    const clients = r.pool.clients.length;
    await vi.advanceTimersByTimeAsync(1000); // not 8 s: what went wrong before is forgotten
    expect(r.pool.clients).toHaveLength(clients + 1);
    expect(r.listener.connected).toBe(true);
    r.listener.stop();
  });

  it('asks an idle connection whether it is there, and treats no answer as a loss', async () => {
    vi.useFakeTimers();
    const r = rig({ keepAliveMs: 5000 });
    await r.listener.start();
    const client = r.pool.clients[0];
    await vi.advanceTimersByTimeAsync(5000);
    expect(client?.queries).toEqual([`LISTEN ${SIGNAL_NOTIFY_CHANNEL}`, 'SELECT 1']);
    expect(r.listener.connected).toBe(true);

    if (client !== undefined) client.failQuery = new Error('gone');
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.listener.connected).toBe(false);
    expect(client?.released).toEqual([true]);
    r.listener.stop();
  });

  it('gives back the connection when LISTEN fails, and tries again', async () => {
    vi.useFakeTimers();
    const r = rig();
    const original = r.pool.connect.bind(r.pool);
    let first = true;
    r.pool.connect = async () => {
      const client = (await original()) as unknown as FakeClient;
      if (first) {
        first = false;
        client.failQuery = new Error('no permission');
      }
      return client as unknown as PoolClient;
    };
    await r.listener.start();
    expect(r.pool.clients[0]?.released).toEqual([true]);
    expect(r.listener.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.listener.connected).toBe(true);
    r.listener.stop();
  });

  it('lets go of everything when it is stopped, also while it waits to try again and while it connects', async () => {
    vi.useFakeTimers();
    const r = rig();
    await r.listener.start();
    const client = r.pool.clients[0];
    r.listener.stop();
    expect(client?.released).toEqual([true]);
    expect(r.listener.connected).toBe(false);
    client?.emit('notification', { channel: SIGNAL_NOTIFY_CHANNEL, payload: 'late' });
    expect(r.notes).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.pool.clients).toHaveLength(1); // no timer is left

    // stopped while the first try waits for a connection
    const waiting = rig();
    const pending = waiting.listener.start();
    waiting.listener.stop();
    await pending;
    expect(waiting.listener.connected).toBe(false);
    expect(waiting.pool.clients[0]?.released).toEqual([true]);
    expect(waiting.connected()).toBe(0);
  });

  it('can be started again after it was stopped', async () => {
    const r = rig();
    await r.listener.start();
    r.listener.stop();
    await r.listener.start();
    expect(r.pool.clients).toHaveLength(2);
    expect(r.listener.connected).toBe(true);
    r.listener.stop();
  });
});
