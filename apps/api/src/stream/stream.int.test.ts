import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startPgApi, type PgApi } from '../testing/pgApi';
import { SEED_AT, outcomeOf, startSeedWorld, type SeedWorld } from '../testing/seedWorld';
import { isEvent, listenOnFreePort, openStream } from '../testing/sseClient';

const MIN = 60_000;

let api: PgApi;
let world: SeedWorld;
let port: number;

beforeAll(async () => {
  api = await startPgApi({
    streamIntervals: { marketMs: 40, idleMs: 200, signalMs: 40, newsMs: 100, healthMs: 200 },
  });
  world = await startSeedWorld(api);
  port = await listenOnFreePort(api.app);
  await api.admin.query(
    `CREATE TABLE IF NOT EXISTS ticks_20261026 PARTITION OF ticks FOR VALUES FROM ('2026-10-26') TO ('2026-10-27')`,
  );
  // the listener of the database is up before a test announces anything
  for (let i = 0; i < 100 && api.stream.listener?.connected !== true; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(api.stream.listener?.connected).toBe(true);
});

afterAll(async () => {
  await world.finish();
  await api.close();
});

const tick = (bid: number, ask: number, ageMs = 1000) =>
  api.admin.query(
    `INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES ($1, $1, 'XAUUSD', $2, $3)`,
    [new Date(api.clock.now - ageMs), bid, ask],
  );

describe('the stream on Postgres', () => {
  it('shows the market that is stored: the quote, and the engine as it is', async () => {
    await tick(4017.37, 4017.55);
    const stream = await openStream(port, { cookie: api.cookie });
    const quote = await stream.next(isEvent('quote'));
    // the worker has not said anything yet, so the feed is not known to be live
    expect(JSON.parse(quote.data ?? '{}')).toMatchObject({
      bid: 4017.37,
      ask: 4017.55,
      spread: 0.18,
      ageMs: 1000,
      feedState: 'DISCONNECTED',
    });
    const engine = await stream.next(isEvent('engine'));
    expect(JSON.parse(engine.data ?? '{}')).toMatchObject({
      status: 'RUNNING',
      regime: 'UNCERTAIN',
    });
    expect(engine.id).toMatch(/^[0-9a-f]{12}:\d+$/);
    stream.close();
  });

  it('follows a quote that moves, at most about once for each look', async () => {
    const stream = await openStream(port, { cookie: api.cookie });
    await stream.next(isEvent('quote'));
    await tick(4018.1, 4018.3, 200);
    const moved = await stream.next(
      (frame) =>
        frame.event === 'quote' &&
        (JSON.parse(frame.data ?? '{}') as { bid: number }).bid === 4018.1,
    );
    expect(JSON.parse(moved.data ?? '{}')).toMatchObject({ ask: 4018.3, ageMs: 200 });
    stream.close();
  });

  it('announces a signal that the worker wrote, as soon as it is committed, and replays it to a client that was away', async () => {
    const waiting = await openStream(port, { cookie: api.cookie });
    const signal = await world.createSignal({ generatedAt: SEED_AT });
    const event = await waiting.next(isEvent('signal'));
    expect(JSON.parse(event.data ?? '{}')).toEqual({ id: signal.id });
    waiting.close();

    // a client that was away when it happened is given it when it comes back with the id of the last thing it saw
    const lastSeen = api.stream.hub.lastId;
    const second = await world.createSignal({ generatedAt: SEED_AT + 5 * MIN });
    for (let i = 0; i < 100 && api.stream.hub.lastId === lastSeen; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const back = await openStream(port, { cookie: api.cookie, lastEventId: lastSeen });
    const replayed = await back.next(isEvent('signal'));
    expect(JSON.parse(replayed.data ?? '{}')).toEqual({ id: second.id });
    back.close();
  });

  it('sends the numbers of an open signal as the price moves, and CLOSED with the result when it ends', async () => {
    const stream = await openStream(port, { cookie: api.cookie });
    const opened = await world.createSignal({ generatedAt: SEED_AT + 10 * MIN, side: 'BUY' });
    await tick(4020.1, 4020.3, 100);
    const update = await stream.next(
      (frame) =>
        frame.event === 'signal_update' &&
        (JSON.parse(frame.data ?? '{}') as { id: string; unrealisedR: number }).id === opened.id &&
        (JSON.parse(frame.data ?? '{}') as { unrealisedR: number }).unrealisedR === 0.42,
    );
    expect(JSON.parse(update.data ?? '{}')).toMatchObject({ status: 'ACTIVE', stop: 4010.9 });

    await world.close(opened, outcomeOf('WIN', SEED_AT + 50 * MIN, { realizedRNet: 1.47 }));
    const closed = await stream.next(
      (frame) =>
        frame.event === 'signal_update' &&
        (JSON.parse(frame.data ?? '{}') as { status: string }).status === 'CLOSED',
    );
    expect(JSON.parse(closed.data ?? '{}')).toMatchObject({ id: opened.id, unrealisedR: 1.47 });
    stream.close();
  });

  it('tells the screens at once when the owner pauses the engine', async () => {
    const stream = await openStream(port, { cookie: api.cookie });
    await world.createSignal({ generatedAt: SEED_AT + 20 * MIN });
    expect((await api.send({ method: 'POST', url: '/api/v1/engine/pause', body: {} })).status).toBe(
      204,
    );
    const paused = await stream.next(
      (frame) =>
        frame.event === 'engine' &&
        (JSON.parse(frame.data ?? '{}') as { status: string }).status === 'PAUSED',
    );
    expect(JSON.parse(paused.data ?? '{}')).toMatchObject({ status: 'PAUSED' });
    expect((await api.send({ method: 'POST', url: '/api/v1/engine/resume' })).status).toBe(204);
    await stream.next(
      (frame) =>
        frame.event === 'engine' &&
        (JSON.parse(frame.data ?? '{}') as { status: string }).status === 'RUNNING',
    );
    stream.close();
  });

  it('sends the health when the clock has gone on, and the news when the state of the window changes', async () => {
    const stream = await openStream(port, { cookie: api.cookie });
    // the map is sent at least every `healthMs` of the clock of the service: let it pass
    api.clock.now += 60_000;
    const health = await stream.next(isEvent('health'));
    expect(JSON.parse(health.data ?? '{}')).toMatchObject({ database: 'OK', worker: 'UNKNOWN' });
    // the calendar is read well and a high-impact USD event is ten minutes away: the window is open
    await api.admin.query(
      `INSERT INTO worker_heartbeats (worker_name, heartbeat_at) VALUES ('calendar', $1)
       ON CONFLICT (worker_name) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`,
      [new Date(api.clock.now - 5000)],
    );
    await api.admin.query(
      `INSERT INTO macro_events (id, source, source_event_id, scheduled_at, currency, name, importance, raw)
       VALUES ('0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e90', 'biquote', 'ev-1', $1, 'USD', 'US CPI m/m', 'high', '{}'::jsonb)`,
      [new Date(api.clock.now + 10 * MIN)],
    );
    const news = await stream.next(
      (frame) =>
        frame.event === 'news' &&
        (JSON.parse(frame.data ?? '{}') as { state: string }).state === 'IN_WINDOW',
    );
    expect(JSON.parse(news.data ?? '{}')).toMatchObject({
      next: { name: 'US CPI m/m', importance: 'high' },
    });
    stream.close();
  });

  it('tells the clients to reload when the connection that listens was lost, and works again afterwards', async () => {
    const stream = await openStream(port, { cookie: api.cookie });
    await stream.next((frame) => frame.retry !== null);
    const killed = await api.admin.query<{ pid: number }>(
      `SELECT pg_terminate_backend(pid) AS ok, pid FROM pg_stat_activity
        WHERE datname = $1 AND usename = 'vmgs_api' AND query LIKE 'LISTEN%'`,
      [api.database.name],
    );
    expect(killed.rows).toHaveLength(1);
    await stream.next(isEvent('resync'), 8000);
    for (let i = 0; i < 100 && api.stream.listener?.connected !== true; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(api.stream.listener?.connected).toBe(true);
    const signal = await world.createSignal({ generatedAt: SEED_AT + 30 * MIN });
    const announced = await stream.next(isEvent('signal'), 5000);
    expect(JSON.parse(announced.data ?? '{}')).toEqual({ id: signal.id });
    stream.close();
  });
});
