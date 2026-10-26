import { describe, expect, it } from 'vitest';

import { defaultSettings } from '@vmgs/config';
import {
  problemSchema,
  strategiesResponseSchema,
  strategyConfigResponseSchema,
  strategyInfoSchema,
} from '@vmgs/contracts';
import type { StrategyKey } from '@vmgs/core';

import { makeHarness } from '../testing/harness';
import type { StrategiesReader, StrategyChange, StrategyListing, StrategyRow } from './reader';
import { registerStrategiesRoutes } from './routes';

const BASE = '/api/v1/strategies';
const LAST = Date.UTC(2026, 9, 23, 6, 10, 0);

const EVIDENCE = {
  scope: 'FORWARD',
  level: 2,
  n: 12,
  wins: 5,
  sampleLabel: 'INSUFFICIENT',
  winRate: null,
  ci: null,
  expectancyR: null,
  profitFactor: null,
  tp1Rate: null,
  tp2Rate: null,
} as const;

const row = (key: StrategyKey, change: Partial<StrategyRow> = {}): StrategyRow => ({
  key,
  version: '0.1.0',
  status: 'FORWARD_TESTING',
  lastSignalAt: null,
  evidence: null,
  ...change,
});

class FakeReader implements StrategiesReader {
  changes: { key: StrategyKey; change: StrategyChange; at: number }[] = [];
  listing: StrategyListing = {
    rows: [
      row('trend_pullback', { lastSignalAt: LAST, evidence: EVIDENCE }),
      row('sweep_reversal'),
    ],
    switches: { enabled: {}, alerts: {} },
  };
  configs = new Map<StrategyKey, { version: string; config: Record<string, unknown> }>([
    [
      'trend_pullback',
      { version: '0.1.0', config: { strategyKey: 'trend_pullback', risk: { stopAtr: 1.5 } } },
    ],
  ]);

  list(): Promise<StrategyListing> {
    return Promise.resolve(this.listing);
  }

  config(key: StrategyKey) {
    return Promise.resolve(this.configs.get(key) ?? null);
  }

  change(key: StrategyKey, change: StrategyChange, at: number): Promise<void> {
    this.changes.push({ key, change, at });
    const { enabled, alerts } = this.listing.switches;
    this.listing = {
      ...this.listing,
      switches: {
        enabled: change.enabled === undefined ? enabled : { ...enabled, [key]: change.enabled },
        alerts:
          change.alerts === undefined ? alerts : { ...alerts, [key]: change.alerts ? 'on' : 'off' },
      },
    };
    return Promise.resolve();
  }
}

async function setup() {
  const reader = new FakeReader();
  const h = await makeHarness({
    routes: (app, clock) => {
      registerStrategiesRoutes(app, { reader, now: () => clock.now });
    },
  });
  return { h, reader, cookie: await h.login() };
}

describe('GET /strategies', () => {
  it('lists every strategy that has a version, as the contract says', async () => {
    const { h, cookie } = await setup();
    const reply = await h.send({ url: BASE, cookie });
    expect(reply.status).toBe(200);
    const { items } = strategiesResponseSchema.parse(reply.json());
    expect(items.map((item) => item.key)).toEqual(['trend_pullback', 'sweep_reversal']);
    expect(items[0]).toEqual({
      key: 'trend_pullback',
      version: '0.1.0',
      status: 'FORWARD_TESTING',
      enabled: true,
      alerts: true,
      lastSignalAt: new Date(LAST).toISOString(),
      evidence: EVIDENCE,
    });
    expect(items[1]).toMatchObject({ lastSignalAt: null, evidence: null });
  });

  it('takes a strategy that has no entry as enabled, and its alert switch from the documented default', async () => {
    const { h, cookie } = await setup();
    const defaults = defaultSettings().strategyAlerts;
    const { items } = strategiesResponseSchema.parse((await h.send({ url: BASE, cookie })).json());
    for (const item of items) expect(item.alerts).toBe(defaults[item.key] === 'on');
    expect(items.every((item) => item.enabled)).toBe(true);
  });

  it('shows the owner switches that are stored: off means off, and only an explicit false disables', async () => {
    const { h, reader, cookie } = await setup();
    reader.listing = {
      ...reader.listing,
      switches: {
        enabled: { trend_pullback: false, sweep_reversal: true },
        alerts: { trend_pullback: 'off', sweep_reversal: 'on' },
      },
    };
    const { items } = strategiesResponseSchema.parse((await h.send({ url: BASE, cookie })).json());
    expect(items.map((item) => [item.enabled, item.alerts])).toEqual([
      [false, false],
      [true, true],
    ]);
  });

  it('is an empty list, not an error, before the worker has made any version', async () => {
    const { h, reader, cookie } = await setup();
    reader.listing = { rows: [], switches: { enabled: {}, alerts: {} } };
    const reply = await h.send({ url: BASE, cookie });
    expect(strategiesResponseSchema.parse(reply.json())).toEqual({ items: [] });
  });

  it('needs a session', async () => {
    const { h } = await setup();
    expect((await h.send({ url: BASE })).status).toBe(401);
  });

  it('takes no query string, and ignores one', async () => {
    const { h, cookie } = await setup();
    expect((await h.send({ url: `${BASE}?x=1`, cookie })).status).toBe(200);
  });
});

describe('GET /strategies/:key/config', () => {
  it('gives the config of the version in use', async () => {
    const { h, cookie } = await setup();
    const reply = await h.send({ url: `${BASE}/trend_pullback/config`, cookie });
    expect(reply.status).toBe(200);
    expect(strategyConfigResponseSchema.parse(reply.json())).toEqual({
      key: 'trend_pullback',
      version: '0.1.0',
      config: { strategyKey: 'trend_pullback', risk: { stopAtr: 1.5 } },
    });
  });

  it('is 404 for a strategy that has no version, and 400 for a name that is no strategy', async () => {
    const { h, cookie } = await setup();
    const none = await h.send({ url: `${BASE}/sweep_reversal/config`, cookie });
    expect(none.status).toBe(404);
    expect(problemSchema.parse(none.json()).code).toBe('not_found');
    const bad = await h.send({ url: `${BASE}/not_a_strategy/config`, cookie });
    expect(bad.status).toBe(400);
    expect(problemSchema.parse(bad.json()).code).toBe('invalid_request');
  });
});

describe('PATCH /strategies/:key', () => {
  const patch = (cookie: string, key: string, body: unknown) => ({
    method: 'PATCH' as const,
    url: `${BASE}/${key}`,
    body,
    cookie,
  });

  it('switches a strategy off and answers with the updated entry', async () => {
    const { h, reader, cookie } = await setup();
    h.clock.advance(5000);
    const reply = await h.send(patch(cookie, 'trend_pullback', { enabled: false }));
    expect(reply.status).toBe(200);
    expect(strategyInfoSchema.parse(reply.json())).toMatchObject({
      key: 'trend_pullback',
      enabled: false,
      alerts: true,
    });
    expect(reader.changes).toEqual([
      { key: 'trend_pullback', change: { enabled: false }, at: h.clock.now },
    ]);
  });

  it('takes both switches in one call, and the alert switch alone', async () => {
    const { h, reader, cookie } = await setup();
    const both = await h.send(patch(cookie, 'sweep_reversal', { enabled: false, alerts: true }));
    expect(strategyInfoSchema.parse(both.json())).toMatchObject({ enabled: false, alerts: true });
    const alone = await h.send(patch(cookie, 'sweep_reversal', { alerts: false }));
    expect(strategyInfoSchema.parse(alone.json())).toMatchObject({ enabled: false, alerts: false });
    expect(reader.changes).toHaveLength(2);
  });

  it('is 400 for an empty body, an unknown field, a value of the wrong kind and no body at all; nothing changes', async () => {
    const { h, reader, cookie } = await setup();
    for (const body of [
      {},
      { enabled: 'yes' },
      { alerts: 1 },
      { status: 'PAUSED' },
      { enabled: true, version: '9.9.9' },
    ]) {
      const reply = await h.send(patch(cookie, 'trend_pullback', body));
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(problemSchema.parse(reply.json()).code).toBe('invalid_request');
    }
    const none = await h.send({ method: 'PATCH', url: `${BASE}/trend_pullback`, cookie });
    expect(none.status).toBe(400);
    expect(reader.changes).toEqual([]);
  });

  it('is 404 for a strategy that has no version yet, and writes nothing', async () => {
    const { h, reader, cookie } = await setup();
    const reply = await h.send(patch(cookie, 'squeeze_retest', { enabled: false }));
    expect(reply.status).toBe(404);
    expect(reader.changes).toEqual([]);
  });

  it('is 400 for a name that is no strategy of any kind', async () => {
    const { h, cookie } = await setup();
    for (const key of ['nope', 'TREND_PULLBACK', 'trend_pullback%20x']) {
      expect((await h.send(patch(cookie, key, { enabled: true }))).status, key).toBe(400);
    }
  });

  it('is refused without Origin and the header, and without a session', async () => {
    const { h, reader, cookie } = await setup();
    expect(
      (await h.send({ ...patch(cookie, 'trend_pullback', { enabled: false }), sameSite: false }))
        .status,
    ).toBe(403);
    expect(
      (await h.send({ method: 'PATCH', url: `${BASE}/trend_pullback`, body: { enabled: false } }))
        .status,
    ).toBe(401);
    expect(reader.changes).toEqual([]);
  });
});
