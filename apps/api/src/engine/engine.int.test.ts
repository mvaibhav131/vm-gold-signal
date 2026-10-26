import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresEngineStore } from '../../../worker/src/engine/postgresStore';
import { startPgApi, type PgApi } from '../testing/pgApi';
import { startSeedWorld, type SeedWorld } from '../testing/seedWorld';

const PAUSE = '/api/v1/engine/pause';
const RESUME = '/api/v1/engine/resume';
const MIN = 60_000;

let api: PgApi;
let world: SeedWorld;
let engine: PostgresEngineStore;

beforeAll(async () => {
  api = await startPgApi();
  world = await startSeedWorld(api);
  engine = new PostgresEngineStore(world.pool);
});

afterAll(async () => {
  await world.finish();
  await api.close();
});

const post = (url: string, body?: unknown) =>
  api.send({ method: 'POST', url, ...(body === undefined ? {} : { body }) });

async function engineDoc(): Promise<unknown> {
  const { rows } = await api.admin.query<{ value: unknown }>(
    "SELECT value FROM app_settings WHERE key = 'engine'",
  );
  return rows[0]?.value;
}

const outbox = async () =>
  (
    await api.admin.query<{
      event_key: string;
      channel: string;
      kind: string;
      payload: { text?: string };
    }>('SELECT event_key, channel, kind, payload FROM notification_outbox ORDER BY id')
  ).rows;

describe('the owner pause on Postgres', () => {
  it('is a 409 to resume an engine that was never paused, and writes nothing that matters', async () => {
    const reply = await post(RESUME);
    expect(reply.status).toBe(409);
    expect(await engineDoc()).toEqual({ status: 'RUNNING' });
    expect(await outbox()).toEqual([]);
  });

  it('pauses with no end: the worker sees the pause, and the message is queued once for the channels that are on', async () => {
    const reply = await post(PAUSE, {});
    expect(reply.status).toBe(204);
    expect(await engineDoc()).toEqual({
      status: 'PAUSED',
      pausedSince: new Date(api.clock.now).toISOString(),
      pausedUntil: null,
    });
    expect((await engine.controls(api.clock.now)).paused).toBe(true);
    // the default settings: Telegram on (every kind), Web Push off
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_key: `engine:${String(api.clock.now)}:paused`,
      channel: 'telegram',
      kind: 'ENGINE_PAUSED',
    });
    expect(rows[0]?.payload.text).toContain('PAUSED');
  });

  it('is a 409 to pause an engine that is paused, and writes no second message', async () => {
    api.clock.now += MIN;
    const reply = await post(PAUSE, { minutes: 5 });
    expect(reply.status).toBe(409);
    expect((await engine.controls(api.clock.now)).paused).toBe(true);
    expect(await outbox()).toHaveLength(1);
  });

  it('resumes: the worker runs again, and nothing is queued for a resume', async () => {
    const reply = await post(RESUME);
    expect(reply.status).toBe(204);
    expect(await engineDoc()).toEqual({ status: 'RUNNING' });
    expect((await engine.controls(api.clock.now)).paused).toBe(false);
    expect(await outbox()).toHaveLength(1);
    expect((await post(RESUME)).status).toBe(409);
  });

  it('pauses for a time, which runs out by itself: a new pause is then possible, with its own message', async () => {
    api.clock.now += MIN;
    expect((await post(PAUSE, { minutes: 10 })).status).toBe(204);
    expect(await engineDoc()).toMatchObject({
      status: 'PAUSED',
      pausedUntil: new Date(api.clock.now + 10 * MIN).toISOString(),
    });
    api.clock.now += 9 * MIN;
    expect((await post(PAUSE, {})).status).toBe(409);
    api.clock.now += 2 * MIN; // the ten minutes are over
    expect((await engine.controls(api.clock.now)).paused).toBe(false);
    expect((await post(RESUME)).status).toBe(409);
    expect((await post(PAUSE, {})).status).toBe(204);
    const keys = (await outbox()).map((row) => row.event_key);
    expect(new Set(keys).size).toBe(3);
  });

  it('also queues Web Push when it is on, and nothing for a channel that is off', async () => {
    await post(RESUME);
    await api.admin.query(
      `INSERT INTO app_settings (key, value) VALUES
         ('alerts', '{"telegram":{"enabled":false,"minGrade":"Moderate","kinds":[]},"webpush":{"enabled":true,"minGrade":"Moderate"}}'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    api.clock.now += MIN;
    expect((await post(PAUSE, {})).status).toBe(204);
    const added = (await outbox()).filter(
      (row) => row.event_key === `engine:${String(api.clock.now)}:paused`,
    );
    expect(added.map((row) => row.channel)).toEqual(['webpush']);
    expect(added[0]?.payload).toMatchObject({ title: 'ENGINE PAUSED', url: '/' });
  });

  it('lets exactly one of many parallel pauses win', async () => {
    await post(RESUME);
    await api.admin.query('DELETE FROM notification_outbox');
    api.clock.now += MIN;
    const replies = await Promise.all(Array.from({ length: 6 }, () => post(PAUSE, {})));
    expect(replies.map((reply) => reply.status).sort()).toEqual([204, 409, 409, 409, 409, 409]);
    expect((await outbox()).length).toBeLessThanOrEqual(1);
  });

  it('refuses a body it does not know, and writes nothing', async () => {
    await post(RESUME);
    const before = await engineDoc();
    for (const body of [{ minutes: 0 }, { minutes: 20_000 }, { hours: 2 }]) {
      expect((await post(PAUSE, body)).status).toBe(400);
    }
    expect(await engineDoc()).toEqual(before);
  });
});
