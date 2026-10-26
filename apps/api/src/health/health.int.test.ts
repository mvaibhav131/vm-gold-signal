import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { healthReadySchema } from '@vmgs/contracts';
import { WORKER_HEARTBEAT, WORKER_READY_MAX_AGE_MS, loadMigrations } from '@vmgs/db';

import { PostgresReadinessReader } from './readiness';
import { startPgApi, type PgApi } from '../testing/pgApi';

let api: PgApi;

beforeAll(async () => {
  api = await startPgApi();
});

afterAll(async () => {
  await api.close();
});

async function beat(ageMs: number | null): Promise<void> {
  await api.admin.query('DELETE FROM worker_heartbeats');
  if (ageMs === null) return;
  await api.admin.query(
    `INSERT INTO worker_heartbeats (worker_name, heartbeat_at, metadata) VALUES ($1, $2, '{}'::jsonb)`,
    [WORKER_HEARTBEAT, new Date(api.clock.now - ageMs)],
  );
}

describe('GET /health on Postgres', () => {
  it('reads the migration and the worker heartbeat with the rights of the api role', async () => {
    await beat(5000);
    const reader = new PostgresReadinessReader(api.pool);
    const facts = await reader.facts();
    expect(facts.migrationVersion).toBe((await loadMigrations()).length);
    expect(facts.workerHeartbeatAt).toBe(api.clock.now - 5000);
  });

  it('is ok for a living worker, and not_ready when it is old or missing', async () => {
    api.clock.now += 3000; // the answer of the earlier call is no longer cached
    await beat(1000);
    expect(healthReadySchema.parse((await api.anonymous('/api/v1/health/ready')).json())).toEqual({
      status: 'ok',
    });

    api.clock.now += 3000;
    await beat(WORKER_READY_MAX_AGE_MS + 1);
    const old = await api.anonymous('/api/v1/health/ready');
    expect(old.status).toBe(503);
    expect(healthReadySchema.parse(old.json())).toEqual({ status: 'not_ready' });

    api.clock.now += 3000;
    await beat(null);
    expect((await api.anonymous('/api/v1/health/ready')).status).toBe(503);
  });

  it('answers live without any database', async () => {
    expect((await api.anonymous('/api/v1/health/live')).json()).toEqual({ status: 'ok' });
  });
});
