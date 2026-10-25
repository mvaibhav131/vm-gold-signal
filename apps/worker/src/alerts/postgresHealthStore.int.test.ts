import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { query } from '../../../../packages/db/test/database';
import { createPgWorld, type PgWorld } from '../lifecycle/pgHarness';
import { FILL_AT, MINUTE, STRATEGY, buyDraft } from '../lifecycle/test-data';
import { PostgresHealthStore } from './postgresHealthStore';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

let world: PgWorld;
let store: PostgresHealthStore;

beforeAll(async () => {
  world = await createPgWorld();
  store = new PostgresHealthStore(world.pool);
});

afterAll(async () => {
  await world.close();
});

const incident = (kind: string, startedAt: number, endedAt: number | null) =>
  query(
    world.database.url,
    'INSERT INTO feed_incidents (kind, started_at, ended_at) VALUES ($1, $2, $3)',
    [kind, new Date(startedAt), endedAt === null ? null : new Date(endedAt)],
  );

describe('PostgresHealthStore', () => {
  it('has no incident and no open signal at first', async () => {
    expect(await store.incidents(0)).toEqual([]);
    expect(await store.openSeqs()).toEqual([]);
  });

  it('reads the incidents where data was lost: those open and those that ended since', async () => {
    await incident('STALE', FILL_AT, null);
    await incident('DISCONNECT', FILL_AT - 30 * MINUTE, FILL_AT - 20 * MINUTE);
    await incident('DISCONNECT', FILL_AT - 60 * MINUTE, FILL_AT - 50 * MINUTE);
    await incident('GAP', FILL_AT - 5 * MINUTE, FILL_AT - 4 * MINUTE);
    await incident('SPREAD_SPIKE', FILL_AT - MINUTE, null);
    await incident('MARKET_STATE', FILL_AT - MINUTE, null);
    // ended exactly at the limit: it counts
    await incident('STALE', FILL_AT - 26 * MINUTE, FILL_AT - 25 * MINUTE);

    expect(await store.incidents(FILL_AT - 25 * MINUTE)).toEqual([
      { kind: 'DISCONNECT', startedAt: FILL_AT - 30 * MINUTE, endedAt: FILL_AT - 20 * MINUTE },
      { kind: 'STALE', startedAt: FILL_AT - 26 * MINUTE, endedAt: FILL_AT - 25 * MINUTE },
      { kind: 'STALE', startedAt: FILL_AT, endedAt: null },
    ]);
    expect(await store.incidents(FILL_AT - 55 * MINUTE)).toHaveLength(4);
    expect(await store.incidents(FILL_AT)).toEqual([
      { kind: 'STALE', startedAt: FILL_AT, endedAt: null },
    ]);
  });

  it('lists the numbers of the open signals only', async () => {
    const strategy = await world.store.ensureStrategyVersion(STRATEGY);
    const first = await world.store.createSignal(
      buyDraft({ setupKey: 'health-1' }),
      strategy,
      () => [],
      FILL_AT,
    );
    const second = await world.store.createSignal(
      buyDraft({ setupKey: 'health-2' }),
      strategy,
      () => [],
      FILL_AT,
    );
    if (first.status !== 'CREATED' || second.status !== 'CREATED') throw new Error('not created');
    expect(await store.openSeqs()).toEqual([first.created.seq, second.created.seq]);
    await world.store.commit({
      signalId: first.created.id,
      events: [{ type: 'SL_HIT', at: FILL_AT + MINUTE, price: 4010.9 }],
      state: null,
      closing: {
        outcome: {
          result: 'LOSS',
          countsInStats: true,
          closedAt: FILL_AT + MINUTE,
          exitPrice: 4010.9,
          exitReason: 'STOP',
          realizedRGross: -1,
          costR: 0,
          realizedRNet: -1,
          durationS: 60,
          mfeR: 0,
          maeR: -1,
          tp1Hit: false,
          tp2Hit: false,
          ambiguous: false,
          isWin: false,
        },
        meta: {},
        review: null,
      },
      outbox: [],
      at: FILL_AT + MINUTE,
    });
    expect(await store.openSeqs()).toEqual([second.created.seq]);

    // a signal that hit TP1 is still open
    await world.store.commit({
      signalId: second.created.id,
      events: [{ type: 'TP1_HIT', at: FILL_AT + 2 * MINUTE, price: 4023.84 }],
      state: {
        status: 'TP1_HIT',
        stopLossCurrent: 4017.37,
        tp1HitAt: FILL_AT + 2 * MINUTE,
        mfeR: 1,
        maeR: 0,
      },
      closing: null,
      outbox: [],
      at: FILL_AT + 2 * MINUTE,
    });
    expect(await store.openSeqs()).toEqual([second.created.seq]);
  });
});
