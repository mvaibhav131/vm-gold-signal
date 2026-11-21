import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  strategiesResponseSchema,
  strategyConfigResponseSchema,
  strategyInfoSchema,
} from '@vmgs/contracts';

import { PostgresEngineStore } from '../../../worker/src/engine/postgresStore';
import { startPgApi, type PgApi } from '../testing/pgApi';
import { MINUTE_MS, SEED_AT, startSeedWorld, type SeedWorld } from '../testing/seedWorld';

const BASE = '/api/v1/strategies';

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

const list = async () =>
  strategiesResponseSchema.parse((await api.send({ url: BASE })).json()).items;

async function settingOf(key: string): Promise<unknown> {
  const { rows } = await api.admin.query<{ value: unknown }>(
    'SELECT value FROM app_settings WHERE key = $1',
    [key],
  );
  return rows[0]?.value;
}

describe('the strategies on Postgres', () => {
  it('is an empty list before the worker has made a version, and a switch of a strategy without a version writes nothing', async () => {
    expect(await list()).toEqual([]);
    expect((await api.send({ url: `${BASE}/trend_pullback/config` })).status).toBe(404);
    const patch = await api.send({
      method: 'PATCH',
      url: `${BASE}/trend_pullback`,
      body: { enabled: false, alerts: false },
    });
    expect(patch.status).toBe(404);
    expect(await settingOf('strategyEnabled')).toBeUndefined();
    expect(await settingOf('strategyAlerts')).toBeUndefined();
  });

  it('shows the newest version of each strategy, its newest signal and the evidence that signal showed', async () => {
    const older = await world.createSignal({
      strategy: 'trend_pullback',
      generatedAt: SEED_AT,
      draft: { evidence: { ...evidenceOf(40), n: 40, wins: 20 } },
    });
    const newer = await world.createSignal({
      strategy: 'trend_pullback',
      generatedAt: SEED_AT + 10 * MINUTE_MS,
      draft: { evidence: { ...evidenceOf(64), n: 64, wins: 37 } },
    });
    // a replay is not a forward signal: it does not count as the strategy's last
    await world.createSignal({
      strategy: 'trend_pullback',
      generatedAt: SEED_AT + 60 * MINUTE_MS,
      draft: { mode: 'BACKTEST' },
    });
    await world.createSignal({ strategy: 'sweep_reversal', generatedAt: SEED_AT + 5 * MINUTE_MS });
    expect(older.seq).toBeLessThan(newer.seq);

    // a newer version of one strategy: the list and the config follow it
    await api.admin.query(
      `INSERT INTO strategy_versions (strategy_key, version, config, config_hash, status, created_at)
       SELECT strategy_key, '0.2.0', jsonb_set(config, '{version}', '"0.2.0"'), 'hash-0.2.0', 'BACKTESTED', now() + interval '1 hour'
         FROM strategy_versions WHERE strategy_key = 'sweep_reversal'`,
    );

    const items = await list();
    expect(items.map((item) => item.key)).toEqual(['trend_pullback', 'sweep_reversal']);
    const [trend, sweep] = items;
    expect(trend).toMatchObject({
      version: '0.1.0',
      status: 'RESEARCH',
      enabled: true,
      alerts: true,
      lastSignalAt: new Date(SEED_AT + 10 * MINUTE_MS).toISOString(),
    });
    expect(trend?.evidence).toMatchObject({ n: 64, wins: 37 });
    expect(sweep).toMatchObject({
      version: '0.2.0',
      status: 'BACKTESTED',
      alerts: true,
      lastSignalAt: new Date(SEED_AT + 5 * MINUTE_MS).toISOString(),
    });

    const config = strategyConfigResponseSchema.parse(
      (await api.send({ url: `${BASE}/sweep_reversal/config` })).json(),
    );
    expect(config).toMatchObject({ key: 'sweep_reversal', version: '0.2.0' });
    expect(config.config.version).toBe('0.2.0');
    expect(
      strategyConfigResponseSchema.parse(
        (await api.send({ url: `${BASE}/trend_pullback/config` })).json(),
      ).config.strategyKey,
    ).toBe('trend_pullback');
  });

  it('switches a strategy off, and the worker reads the same switch', async () => {
    const reply = await api.send({
      method: 'PATCH',
      url: `${BASE}/trend_pullback`,
      body: { enabled: false },
    });
    expect(reply.status).toBe(200);
    expect(strategyInfoSchema.parse(reply.json())).toMatchObject({ enabled: false, alerts: true });
    expect(await settingOf('strategyEnabled')).toEqual({ trend_pullback: false });

    const engine = new PostgresEngineStore(world.pool);
    expect((await engine.controls(api.clock.now)).disabled).toEqual(['trend_pullback']);

    await api.send({ method: 'PATCH', url: `${BASE}/trend_pullback`, body: { enabled: true } });
    expect((await engine.controls(api.clock.now)).disabled).toEqual([]);
    expect((await list())[0]?.enabled).toBe(true);
  });

  it('starts the alert switches from the documented defaults when the database has none, and keeps the others', async () => {
    expect(await settingOf('strategyAlerts')).toBeUndefined();
    const reply = await api.send({
      method: 'PATCH',
      url: `${BASE}/sweep_reversal`,
      body: { alerts: false },
    });
    expect(strategyInfoSchema.parse(reply.json())).toMatchObject({ alerts: false });
    expect(await settingOf('strategyAlerts')).toEqual({
      trend_pullback: 'on',
      sweep_reversal: 'off',
      squeeze_retest: 'on',
      trendline_retest: 'off',
      pattern_breakout: 'off',
      hourly_trend: 'off',
      confluence: 'on',
    });
    const other = await api.send({
      method: 'PATCH',
      url: `${BASE}/trend_pullback`,
      body: { alerts: false },
    });
    expect(strategyInfoSchema.parse(other.json())).toMatchObject({ alerts: false });
    expect(await settingOf('strategyAlerts')).toMatchObject({
      trend_pullback: 'off',
      sweep_reversal: 'off',
      squeeze_retest: 'on',
    });
  });

  it('keeps every switch when many are changed at the same moment', async () => {
    await api.admin.query(
      "DELETE FROM app_settings WHERE key IN ('strategyAlerts', 'strategyEnabled')",
    );
    await world.createSignal({ strategy: 'squeeze_retest', generatedAt: SEED_AT });
    await world.createSignal({ strategy: 'trendline_retest', generatedAt: SEED_AT });
    await world.createSignal({ strategy: 'pattern_breakout', generatedAt: SEED_AT });
    const keys = [
      'trend_pullback',
      'sweep_reversal',
      'squeeze_retest',
      'trendline_retest',
      'pattern_breakout',
    ];
    const replies = await Promise.all(
      keys.flatMap((key, index) => [
        api.send({ method: 'PATCH', url: `${BASE}/${key}`, body: { alerts: index % 2 === 0 } }),
        api.send({ method: 'PATCH', url: `${BASE}/${key}`, body: { enabled: index % 2 === 1 } }),
      ]),
    );
    expect(replies.map((reply) => reply.status)).toEqual(Array<number>(10).fill(200));
    const items = await list();
    expect(items.map((item) => [item.key, item.alerts, item.enabled])).toEqual(
      keys.map((key, index) => [key, index % 2 === 0, index % 2 === 1]),
    );
  });

  it('writes nothing for a body it refuses', async () => {
    await api.admin.query(
      "DELETE FROM app_settings WHERE key IN ('strategyAlerts', 'strategyEnabled')",
    );
    const refused = await api.send({
      method: 'PATCH',
      url: `${BASE}/trend_pullback`,
      body: { enabled: 'no' },
    });
    expect(refused.status).toBe(400);
    expect(await settingOf('strategyEnabled')).toBeUndefined();
    expect(await settingOf('strategyAlerts')).toBeUndefined();
  });
});

function evidenceOf(n: number) {
  return {
    scope: 'FORWARD' as const,
    level: 2,
    n,
    wins: 0,
    sampleLabel: 'LOW_SAMPLE' as const,
    winRate: 0.5,
    ci: [0.4, 0.6] as [number, number],
    expectancyR: 0.3,
    profitFactor: 1.4,
    tp1Rate: 0.7,
    tp2Rate: 0.4,
  };
}
