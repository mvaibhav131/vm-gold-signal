import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startPgApi, type PgApi } from '../testing/pgApi';
import {
  SEED_AT,
  MINUTE_MS,
  outcomeOf,
  startSeedWorld,
  type SeedWorld,
  type SeededSignal,
} from '../testing/seedWorld';
import { PostgresSignalsReader } from './reader';

let api: PgApi;
let world: SeedWorld;

beforeAll(async () => {
  api = await startPgApi();
  world = await startSeedWorld(api);
});

afterAll(async () => {
  await world.finish();
  await api.close();
});

/**
 * A pool whose connections run `afterQuery` once, right after the first query that matches: the moment in which the
 * worker closes the signal while the API is half way through reading it. `pids` collects the process id of every
 * connection that was taken from the pool, so that a test can look at those connections and no others.
 */
function interrupted(
  pool: Pool,
  matches: string,
  afterQuery: () => Promise<void>,
  pids: number[] = [],
): Pool {
  let done = false;
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property !== 'connect') return Reflect.get(target, property, receiver) as unknown;
      return async () => {
        const client = await target.connect();
        const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        for (const row of rows) pids.push(row.pid);
        return new Proxy(client, {
          get(inner, name, innerReceiver) {
            if (name !== 'query') return Reflect.get(inner, name, innerReceiver) as unknown;
            return async (...args: unknown[]) => {
              const result = await (inner.query as (...rest: unknown[]) => Promise<unknown>)(
                ...args,
              );
              const text = typeof args[0] === 'string' ? args[0] : '';
              if (!done && text.includes(matches)) {
                done = true;
                await afterQuery();
              }
              return result;
            };
          },
        });
      };
    },
  });
}

describe('the signals reader on Postgres', () => {
  it('prices the open signals with the newest tick: by source time, then by the time it was received', async () => {
    await api.admin.query(
      `CREATE TABLE IF NOT EXISTS ticks_20261023 PARTITION OF ticks FOR VALUES FROM ('2026-10-23') TO ('2026-10-24')`,
    );
    const add = (ts: number, receivedAt: number, bid: number, symbol = 'XAUUSD') =>
      api.admin.query(
        'INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES ($1, $2, $3, $4, $5)',
        [new Date(ts), new Date(receivedAt), symbol, bid, bid + 0.2],
      );
    const newest = SEED_AT + 5 * MINUTE_MS;
    await add(SEED_AT, SEED_AT + 100, 4000);
    await add(newest, newest + 900, 4001); // the same source second as the next, received later, put in first
    await add(newest, newest + 100, 4002);
    await add(SEED_AT + 2 * MINUTE_MS, SEED_AT + 2 * MINUTE_MS + 50, 3999);
    await add(newest + MINUTE_MS, newest + MINUTE_MS, 1.08, 'EURUSD'); // newer, but not gold

    const { quote } = await new PostgresSignalsReader(api.pool).open(newest + 2 * MINUTE_MS);
    expect(quote).toEqual({ bid: 4001, ask: 4001.2, at: newest });
  });

  it('reads the detail in one snapshot: a signal that closes while it is read is open or closed, never both', async () => {
    const signal: SeededSignal = await world.createSignal({ generatedAt: SEED_AT });
    const closeIt = () =>
      world.close(signal, outcomeOf('TIME_EXIT', SEED_AT + 30 * MINUTE_MS, { durationS: 1800 }));
    const reader = new PostgresSignalsReader(interrupted(api.pool, 'FROM signal_state', closeIt));

    const during = await reader.detail(signal.id);
    expect(during?.state).not.toBeNull();
    expect(during?.outcome).toBeNull();

    const after = await new PostgresSignalsReader(api.pool).detail(signal.id);
    expect(after?.state).toBeNull();
    expect(after?.outcome).toMatchObject({ result: 'TIME_EXIT' });
  });

  it('gives its connection back, also when a read fails, and does not leave a transaction open', async () => {
    // the connections of this reader, by their process id: only these are looked at, so that a transaction of something else
    // that the API is doing in the same second cannot be taken for a leak
    const pids: number[] = [];
    const reader = new PostgresSignalsReader(
      interrupted(api.pool, 'FROM signal_state', () => Promise.reject(new Error('lost')), pids),
    );
    const signal = await world.createSignal({ generatedAt: SEED_AT + 5 * MINUTE_MS });
    await expect(reader.detail(signal.id)).rejects.toThrow('lost');
    expect(pids).toHaveLength(1);
    const { rows } = await api.admin.query<{ state: string }>(
      'SELECT state FROM pg_stat_activity WHERE pid = ANY($1::int[])',
      [pids],
    );
    // idle: back in the pool, with its transaction rolled back (not `idle in transaction`, and not gone)
    expect(rows.map((row) => row.state)).toEqual(['idle']);
    expect((await new PostgresSignalsReader(api.pool).detail(signal.id))?.signal.id).toBe(
      signal.id,
    );
  });

  it('says nothing for an unknown signal and for a replay', async () => {
    const reader = new PostgresSignalsReader(api.pool);
    expect(await reader.detail('0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e99')).toBeNull();
    const replay = await world.createSignal({
      generatedAt: SEED_AT + 9 * MINUTE_MS,
      draft: { mode: 'BACKTEST' },
    });
    expect(await reader.detail(replay.id)).toBeNull();
  });
});
