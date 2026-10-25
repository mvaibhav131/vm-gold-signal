import type { TradeOutcome } from '@vmgs/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { query } from '../../../../packages/db/test/database';
import { createPgWorld, type PgWorld } from './pgHarness';
import { SIGNAL_NOTIFY_CHANNEL } from './postgresStore';
import { lifecycleStoreContract } from './storeContract';
import { FILL_AT, MINUTE, STRATEGY, buyDraft } from './test-data';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

let world: PgWorld;

beforeAll(async () => {
  world = await createPgWorld();
});

afterAll(async () => {
  await world.close();
});

lifecycleStoreContract('PostgreSQL', () =>
  Promise.resolve({ harness: world.harness, done: () => Promise.resolve() }),
);

describe('PostgreSQL specifics', () => {
  async function newSignal(setupKey: string) {
    const strategy = await world.store.ensureStrategyVersion(STRATEGY);
    const result = await world.store.createSignal(
      buyDraft({ setupKey }),
      strategy,
      () => [],
      FILL_AT,
    );
    if (result.status !== 'CREATED') throw new Error('not created');
    return result.created.id;
  }

  const lossOutcome: TradeOutcome = {
    result: 'LOSS',
    countsInStats: true,
    closedAt: FILL_AT + 10_000,
    exitPrice: 4010.9,
    exitReason: 'STOP',
    realizedRGross: -1,
    costR: 0,
    realizedRNet: -1,
    durationS: 10,
    mfeR: 0,
    maeR: -1,
    tp1Hit: false,
    tp2Hit: false,
    ambiguous: false,
    isWin: false,
  };

  it('tells the API about a new signal, a closing and a final review (LISTEN / NOTIFY)', async () => {
    const listener = new pg.Client({ connectionString: world.database.url });
    await listener.connect();
    const heard: { id: string; change: string }[] = [];
    listener.on('notification', (message) => {
      heard.push(JSON.parse(message.payload ?? '{}') as { id: string; change: string });
    });
    await listener.query(`LISTEN ${SIGNAL_NOTIFY_CHANNEL}`);
    try {
      const id = await newSignal('notify-1');
      await world.store.commit({
        signalId: id,
        events: [{ type: 'SL_HIT', at: FILL_AT + 10_000, price: 4010.9 }],
        state: null,
        closing: {
          outcome: lossOutcome,
          meta: {},
          review: {
            review: {
              status: 'PRELIMINARY',
              primaryCause: 'NORMAL_LOSS',
              causes: [{ code: 'NORMAL_LOSS', evidence: {} }],
              weakGroupsAtEntry: [],
              counterfactual: null,
            },
            computedAt: FILL_AT + 11_000,
            finalizedAt: null,
          },
        },
        outbox: [],
        at: FILL_AT + 11_000,
      });
      await world.store.commitFinalReview({
        signalId: id,
        review: {
          status: 'FINAL',
          primaryCause: 'NORMAL_LOSS',
          causes: [{ code: 'NORMAL_LOSS', evidence: {} }],
          weakGroupsAtEntry: [],
          counterfactual: { reachedTp1: false, candlesToTp1: null },
        },
        finalizedAt: FILL_AT + 99 * MINUTE,
        outbox: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(heard.filter((message) => message.id === id).map((message) => message.change)).toEqual(
        ['created', 'closed', 'review'],
      );
    } finally {
      await listener.end();
    }
  });

  it('a close whose messages cannot be written leaves the signal open and nothing behind', async () => {
    const id = await newSignal('atomic-1');
    await expect(
      world.store.commit({
        signalId: id,
        events: [{ type: 'SL_HIT', at: FILL_AT + 10_000, price: 4010.9 }],
        state: null,
        closing: { outcome: lossOutcome, meta: {}, review: null },
        outbox: [
          {
            eventKey: `signal:${id}:closed`,
            channel: 'sms' as never,
            kind: 'SIGNAL_CLOSED',
            signalId: id,
            payload: {},
            expiresAt: FILL_AT + 1000,
          },
        ],
        at: FILL_AT,
      }),
    ).rejects.toThrow();
    expect(await world.harness.outcome(id)).toBeNull();
    expect(await world.harness.state(id)).not.toBeNull();
    expect((await world.harness.events(id)).map((event) => event.type)).toEqual(['CREATED']);
    expect((await world.store.loadOpenSignals()).map((open) => open.id)).toContain(id);
  });

  it('of two writers closing the same signal at once, one wins and the other writes nothing', async () => {
    const id = await newSignal('race-1');
    const write = (price: number) => ({
      signalId: id,
      events: [{ type: 'SL_HIT' as const, at: FILL_AT + 10_000, price }],
      state: null,
      closing: { outcome: lossOutcome, meta: {}, review: null },
      outbox: [],
      at: FILL_AT,
    });
    const results = await Promise.all([
      world.store.commit(write(4010.9)),
      world.store.commit(write(4010.8)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      (await world.harness.events(id)).filter((event) => event.type === 'SL_HIT'),
    ).toHaveLength(1);
    expect(await world.harness.state(id)).toBeNull();
  });

  it('the worker role cannot change what is written', async () => {
    const id = await newSignal('role-1');
    await expect(
      world.pool.query('UPDATE signals SET entry = 1 WHERE id = $1', [id]),
    ).rejects.toThrow();
    await expect(
      world.pool.query('DELETE FROM signal_events WHERE signal_id = $1', [id]),
    ).rejects.toThrow();
    await expect(
      world.pool.query('UPDATE signal_outcomes SET result = $1', ['WIN']),
    ).rejects.toThrow();
  });

  it('refuses a signal that points at a strategy version that does not exist', async () => {
    await expect(
      world.store.createSignal(
        buyDraft({ setupKey: 'ghost' }),
        {
          id: '00000000-0000-4000-8000-000000000000',
          strategyKey: 'trend_pullback',
          version: '9.9.9',
          status: 'RESEARCH',
        },
        () => [],
        FILL_AT,
      ),
    ).rejects.toThrow();
  });

  it('reads the settings the owner saved, and falls back to the defaults for the rest', async () => {
    await query(
      world.database.url,
      `INSERT INTO app_settings (key, value) VALUES ('locale', '"hinglish"'::jsonb), ('displayTz', '"Europe/London"'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    const settings = await world.store.loadSettings();
    expect(settings).toMatchObject({ locale: 'hinglish', displayTz: 'Europe/London' });
    expect(settings.alerts.telegram.enabled).toBe(true);
    await query(
      world.database.url,
      "DELETE FROM app_settings WHERE key IN ('locale', 'displayTz')",
    );
  });
});
