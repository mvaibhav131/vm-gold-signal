import { calendarAvailable } from '@vmgs/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresOutboxStore } from '../alerts/postgresOutboxStore';
import { query } from '../../../../packages/db/test/database';
import { plain } from '../../../../packages/core/src/messages/test-html';
import { createPgWorld, type PgWorld } from '../lifecycle/pgHarness';
import { FakeCalendar } from '../testing/fakeCalendar';
import { PostgresBotStore } from '../telegram/postgresBotStore';
import { CalendarAlerts } from './alerts';
import { CalendarPoller } from './poller';
import { PostgresCalendarStore } from './postgresStore';
import { BiquoteCalendarClient } from './provider';
import { T0, providerEvent, rowOf } from './testData';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

const MIN = 60_000;
const DAY = 86_400_000;
const WINDOW = { before: 45, after: 20, impact: ['high'] as const, currency: ['USD'] as const };
const SURPRISES = [0.1, -0.1, 0, 0.2, -0.2, 0.1, 0, -0.1];

let world: PgWorld;
let fake: FakeCalendar;

beforeAll(async () => {
  world = await createPgWorld();
  const day = new Date(T0).toISOString().slice(0, 10);
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
  await query(
    world.database.url,
    `CREATE TABLE IF NOT EXISTS ticks_${day.replaceAll('-', '')} PARTITION OF ticks FOR VALUES FROM ('${day}') TO ('${next}')`,
  );
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  await query(world.database.url, 'TRUNCATE macro_events, ticks');
  await query(world.database.url, 'DELETE FROM notification_outbox');
  await query(world.database.url, "DELETE FROM worker_heartbeats WHERE worker_name = 'calendar'");
  fake = new FakeCalendar();
  await fake.start();
});

afterEach(async () => {
  await fake.stop();
});

function rig() {
  const clock = { now: T0 - 25 * MIN };
  const store = new PostgresCalendarStore(world.pool, 'XAUUSD');
  const outbox = new PostgresOutboxStore(world.pool);
  const provider = new BiquoteCalendarClient({ baseUrl: fake.baseUrl, timeoutMs: 1000 });
  const logs: string[] = [];
  const poller = new CalendarPoller({
    provider,
    store,
    policy: async () => ({
      currencies: WINDOW.currency,
      minImpact: (await world.store.loadSettings()).newsAlerts.minImpact,
    }),
    now: () => clock.now,
    log: (level, message) => logs.push(`${level}: ${message}`),
  });
  const makeAlerts = () =>
    new CalendarAlerts({
      store,
      provider,
      outbox,
      settings: () => world.store.loadSettings(),
      window: WINDOW,
      now: () => clock.now,
    });
  return { clock, store, outbox, provider, poller, alerts: makeAlerts(), makeAlerts, logs };
}

const outboxRows = () =>
  query<{
    event_key: string;
    channel: string;
    kind: string;
    expires_at: Date;
    payload: { text: string };
  }>(
    world.database.url,
    'SELECT event_key, channel, kind, expires_at, payload FROM notification_outbox ORDER BY kind, channel',
  );

describe('the calendar, from the provider to the outbox (PostgreSQL)', () => {
  it('reads the week, tells about the event ahead, and later about its release with the surprise and the gold move', async () => {
    const { clock, poller, alerts, makeAlerts } = rig();
    fake.rows = [rowOf(providerEvent())];
    fake.history.set(
      'mql5:840030005',
      SURPRISES.map((surprise, i) =>
        rowOf(
          providerEvent({
            sourceEventId: `p${String(i + 1)}`,
            scheduledAt: T0 - (i + 1) * 30 * DAY,
            actual: Math.round((0.3 + surprise) * 10) / 10,
            forecast: 0.3,
          }),
        ),
      ),
    );

    expect((await poller.runOnce()).ok).toBe(true);
    expect(await alerts.runOnce()).toBe(1);
    const [upcoming] = await outboxRows();
    expect(upcoming).toMatchObject({ kind: 'NEWS_UPCOMING', channel: 'telegram' });
    expect(upcoming?.expires_at.getTime()).toBe(T0);
    expect(plain(upcoming?.payload.text ?? '')).toContain(
      'HIGH-IMPACT USD EVENT in 25 min: CPI m/m (18:00 IST)',
    );

    await query(
      world.database.url,
      `INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES
         ($1, $1, 'XAUUSD', 4000.0, 4000.2), ($2, $2, 'XAUUSD', 3997.0, 3997.4)`,
      [new Date(T0 - 1000), new Date(T0 + 15_000)],
    );
    clock.now = T0 + 40_000;
    fake.rows = [rowOf(providerEvent({ actual: 0.5 }))];
    expect((await poller.runOnce()).ok).toBe(true);
    expect(await alerts.runOnce()).toBe(1);

    const rows = await outboxRows();
    expect(rows.map((row) => [row.kind, row.channel])).toEqual([
      ['NEWS_RELEASED', 'telegram'],
      ['NEWS_UPCOMING', 'telegram'],
    ]);
    const text = plain(rows[0]?.payload.text ?? '');
    expect(text).toContain('CPI m/m released 18:00 IST');
    expect(text).toContain('Actual 0.5%, forecast 0.3%, previous 0.4% (surprise +1.5 sigma).');
    expect(text).toContain('Gold 15 s after: -2.900 USD, spread 0.400.');
    expect(text).toContain('NEWS WINDOW');
    const [event] = await query<{ raw: { surprise: { sigma: number; n: number } } }>(
      world.database.url,
      "SELECT raw FROM macro_events WHERE source_event_id = 'mql5:277492'",
    );
    expect(event?.raw.surprise.n).toBe(8);

    // a restarted worker does not tell again
    expect(await makeAlerts().runOnce()).toBe(0);
    expect(await outboxRows()).toHaveLength(2);
  });

  it('knows when the calendar cannot be read: unavailable after fifteen minutes, back after a good reading', async () => {
    const { clock, poller, store } = rig();
    fake.rows = [rowOf(providerEvent())];
    const bot = new PostgresBotStore(world.pool);
    expect((await bot.status(clock.now)).calendarAvailable).toBe(false);

    await poller.runOnce();
    const goodAt = clock.now;
    expect((await bot.status(clock.now)).calendarAvailable).toBe(true);
    expect(calendarAvailable(await store.lastOk(), clock.now)).toBe(true);

    clock.now = goodAt + 10 * MIN;
    fake.next({ type: 'status', status: 503 });
    expect(await poller.runOnce()).toEqual({ ok: false, delayMs: 30_000 });
    expect(await store.lastOk()).toBe(goodAt);
    expect((await bot.status(clock.now)).calendarAvailable).toBe(true);

    clock.now = goodAt + 15 * MIN + 1;
    expect((await bot.status(clock.now)).calendarAvailable).toBe(false);

    fake.next({ type: 'garbage' });
    expect((await poller.runOnce()).ok).toBe(false);
    expect((await poller.runOnce()).ok).toBe(true);
    expect((await bot.status(clock.now)).calendarAvailable).toBe(true);
  });

  it('stores an event once however often it is read, and follows a revision', async () => {
    const { clock, poller, store } = rig();
    fake.rows = [rowOf(providerEvent())];
    for (let i = 0; i < 3; i += 1) {
      await poller.runOnce();
      clock.now += 15_000;
    }
    fake.rows = [rowOf(providerEvent({ forecast: 0.2 }))];
    await poller.runOnce();
    const found = await store.between(T0 - MIN, T0 + MIN);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ forecast: 0.2, firstSeenAt: T0 - 25 * MIN });
    expect(fake.readings.length).toBe(4);
  });
});
