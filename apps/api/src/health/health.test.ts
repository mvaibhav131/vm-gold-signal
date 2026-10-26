import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { healthLiveSchema, healthReadySchema } from '@vmgs/contracts';
import { WORKER_READY_MAX_AGE_MS } from '@vmgs/db';

import { isReady, type ReadinessFacts, type ReadinessReader } from './readiness';
import { registerHealthRoutes } from './routes';
import { makeHarness, type Clock } from '../testing/harness';

const READY = '/api/v1/health/ready';
const LIVE = '/api/v1/health/live';

class FakeReader implements ReadinessReader {
  calls = 0;
  failure: Error | null = null;
  gate: Promise<void> | null = null;
  constructor(public facts_: ReadinessFacts) {}
  async facts(): Promise<ReadinessFacts> {
    this.calls += 1;
    if (this.gate !== null) await this.gate;
    if (this.failure !== null) throw this.failure;
    return this.facts_;
  }
}

async function harness(reader: FakeReader, expectedMigration = 6, cacheMs = 2000) {
  let clock: Clock | null = null;
  const h = await makeHarness({
    routes: (app, c) => {
      clock = c;
      registerHealthRoutes(app, { reader, expectedMigration, now: () => c.now, cacheMs });
    },
  });
  return { h, clock: clock as unknown as Clock };
}

const fresh = (clock: Clock, ageMs = 5000): ReadinessFacts => ({
  migrationVersion: 6,
  workerHeartbeatAt: clock.now - ageMs,
});

describe('isReady', () => {
  const NOW = 1_000_000;
  it('needs the expected migration and a worker heard from within the last minute', () => {
    const facts = { migrationVersion: 6, workerHeartbeatAt: NOW - WORKER_READY_MAX_AGE_MS };
    expect(isReady(facts, 6, NOW)).toBe(true);
    expect(
      isReady({ ...facts, workerHeartbeatAt: NOW - WORKER_READY_MAX_AGE_MS - 1 }, 6, NOW),
    ).toBe(false);
    expect(isReady({ ...facts, migrationVersion: 5 }, 6, NOW)).toBe(false);
    expect(isReady({ ...facts, migrationVersion: 7 }, 6, NOW)).toBe(false);
    expect(isReady({ ...facts, migrationVersion: null }, 6, NOW)).toBe(false);
    expect(isReady({ ...facts, workerHeartbeatAt: null }, 6, NOW)).toBe(false);
  });
});

describe('the health routes', () => {
  it('are left out of the log while they go well: a probe every 30 s would fill it', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString('utf8'));
        done();
      },
    });
    const reader = new FakeReader({ migrationVersion: 6, workerHeartbeatAt: 0 });
    const h = await makeHarness({
      logger: { level: 'info', stream },
      routes: (app, c) => {
        registerHealthRoutes(app, { reader, expectedMigration: 6, now: () => c.now, cacheMs: 0 });
      },
    });
    expect((await h.send({ url: LIVE })).status).toBe(200);
    expect((await h.send({ url: READY })).status).toBe(503); // not ready: still a probe, still quiet
    expect(lines.join('')).not.toContain('/health/');

    // any other request is logged
    await h.send({ url: '/api/v1/auth/me' });
    expect(lines.join('')).toContain('/api/v1/auth/me');
  });

  it('answer without a session, say nothing but ok, and carry the usual headers', async () => {
    const { h } = await harness(new FakeReader({ migrationVersion: 6, workerHeartbeatAt: 0 }));
    const live = await h.send({ url: LIVE });
    expect(live.status).toBe(200);
    expect(healthLiveSchema.parse(live.json())).toEqual({ status: 'ok' });
    expect(live.res.headers['cache-control']).toBe('no-store');
  });

  it('say ok when the database is at the version and the worker is alive', async () => {
    const reader = new FakeReader({ migrationVersion: 6, workerHeartbeatAt: 0 });
    const { h, clock } = await harness(reader);
    reader.facts_ = fresh(clock);
    const reply = await h.send({ url: READY });
    expect(reply.status).toBe(200);
    expect(healthReadySchema.parse(reply.json())).toEqual({ status: 'ok' });
  });

  it('say not_ready with 503 for an old worker, another migration, no heartbeat and a database that is gone', async () => {
    const reader = new FakeReader({ migrationVersion: 6, workerHeartbeatAt: 0 });
    const { h, clock } = await harness(reader, 6, 0);
    const cases: [string, () => void][] = [
      ['an old heartbeat', () => (reader.facts_ = fresh(clock, WORKER_READY_MAX_AGE_MS + 1))],
      ['an old schema', () => (reader.facts_ = { ...fresh(clock), migrationVersion: 5 })],
      ['no heartbeat', () => (reader.facts_ = { ...fresh(clock), workerHeartbeatAt: null })],
      ['no database', () => (reader.failure = new Error('connect ECONNREFUSED 10.0.0.1:5432'))],
    ];
    for (const [name, set] of cases) {
      reader.failure = null;
      reader.facts_ = fresh(clock);
      set();
      const reply = await h.send({ url: READY });
      expect(reply.status, name).toBe(503);
      expect(healthReadySchema.parse(reply.json()), name).toEqual({ status: 'not_ready' });
      expect(reply.res.body, name).not.toContain('ECONNREFUSED');
    }
  });

  it('work the answer out once in the cache time, however many probes come', async () => {
    const reader = new FakeReader({ migrationVersion: 6, workerHeartbeatAt: 0 });
    const { h, clock } = await harness(reader, 6, 2000);
    reader.facts_ = fresh(clock);
    await Promise.all([1, 2, 3, 4, 5].map(() => h.send({ url: READY })));
    expect(reader.calls).toBe(1);
    clock.advance(1999);
    await h.send({ url: READY });
    expect(reader.calls).toBe(1);
    clock.advance(1);
    await h.send({ url: READY });
    expect(reader.calls).toBe(2);
  });

  it('share the one answer of probes that come while it is being worked out', async () => {
    const reader = new FakeReader({ migrationVersion: 6, workerHeartbeatAt: 0 });
    const { h, clock } = await harness(reader, 6, 0);
    reader.facts_ = fresh(clock);
    let release: () => void = () => undefined;
    reader.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = [1, 2, 3].map(() => h.send({ url: READY }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const replies = await Promise.all(pending);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200]);
    expect(reader.calls).toBe(1);
  });

  it('do not trust a cached answer from the future (the clock moved back)', async () => {
    const reader = new FakeReader({ migrationVersion: 6, workerHeartbeatAt: 0 });
    const { h, clock } = await harness(reader, 6, 2000);
    reader.facts_ = fresh(clock);
    await h.send({ url: READY });
    clock.advance(-10_000);
    reader.facts_ = fresh(clock);
    await h.send({ url: READY });
    expect(reader.calls).toBe(2);
  });
});
