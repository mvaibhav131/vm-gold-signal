import http from 'node:http';

import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SseEvent } from '@vmgs/contracts';
import type { Review } from '@vmgs/core';

import { at, marketCandles } from '../../../packages/core/src/levels/test-data';
import { ApiError, type ApiClient } from '../../web/src/api/client';
import {
  createHttpClient,
  type EventSourceFactory,
  type EventSourceLike,
  type FetchLike,
} from '../../web/src/api/httpClient';
import { OWNER, SITE } from './testing/harness';
import { startPgApi, type PgApi } from './testing/pgApi';
import { MINUTE_MS, SEED_AT, outcomeOf, startSeedWorld, type SeedWorld } from './testing/seedWorld';
import { listenOnFreePort } from './testing/sseClient';

/**
 * The web client against the real API (phase U5a): the live `HttpApiClient` of `apps/web` talks over HTTP to the whole
 * application of `apps/api` on a real Postgres, with data that the worker's own store wrote. Every answer is parsed
 * with its schema of `packages/contracts` inside the client, so a call that succeeds here is an answer that fits the
 * contract, and a route, a query or a status that the client gets wrong fails.
 */

const HOUR = 60 * MINUTE_MS;
const NOW = at('2026-10-23T12:07');

let api: PgApi;
let world: SeedWorld;
let origin: string;

/** The cookie jar of a browser: `Set-Cookie` in, `Cookie` out, and `Origin` on every request, as a page of the site sends. */
function browser() {
  const jar = new Map<string, string>();
  const send: FetchLike = async (url, init) => {
    const headers: Record<string, string> = { ...init.headers, origin: SITE };
    if (jar.size > 0)
      headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await fetch(url, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0] ?? '';
      const equals = pair.indexOf('=');
      const name = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1);
      if (value === '' || /max-age=0/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
    return { status: response.status, text: () => response.text() };
  };

  /** An `EventSource` over `http`: a refusal closes it for good (as in a browser), a lost connection is retried by the client. */
  const eventSource: EventSourceFactory = (url) => {
    const listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
    let closed = false;
    const source = {
      readyState: 0,
      addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      close() {
        closed = true;
        source.readyState = 2;
        request.destroy();
      },
    } satisfies EventSourceLike & { readyState: number };
    const emit = (type: string, data?: unknown) => {
      if (closed) return;
      for (const listener of listeners.get(type) ?? []) listener({ data });
    };
    const target = new URL(url);
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const request = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        headers: { accept: 'text/event-stream', ...(cookie === '' ? {} : { cookie }) },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          source.readyState = 2;
          emit('error');
          return;
        }
        source.readyState = 1;
        emit('open');
        response.setEncoding('utf8');
        let buffer = '';
        response.on('data', (chunk: string) => {
          buffer += chunk;
          for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            let name: string | null = null;
            const data: string[] = [];
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) name = line.slice(6).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).trim());
            }
            if (name !== null) emit(name, data.join('\n'));
          }
        });
        response.on('close', () => {
          if (closed) return;
          source.readyState = 0;
          emit('error');
        });
      },
    );
    request.on('error', () => {
      if (closed) return;
      source.readyState = 2;
      emit('error');
    });
    request.end();
    return source;
  };

  return { jar, fetch: send, eventSource };
}

const review = (primaryCause: Review['primaryCause']): Review => ({
  status: 'PRELIMINARY',
  primaryCause,
  causes: [{ code: primaryCause, evidence: { mfeR: 0.2 } }],
  weakGroupsAtEntry: [{ group: 'trigger', state: 'WEAK' }],
  counterfactual: null,
});

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('a failure was expected');
}

const five = marketCandles('2026-10-05T00:00', '2026-10-23T12:30', 12).map((c) => ({
  openTime: c.openTime,
  o: Math.round(c.o * 1000) / 1000,
  h: Math.round(c.h * 1000) / 1000,
  l: Math.round(c.l * 1000) / 1000,
  c: Math.round(c.c * 1000) / 1000,
}));

beforeAll(async () => {
  api = await startPgApi({
    streamIntervals: { marketMs: 100, idleMs: 300, signalMs: 100, newsMs: 300, healthMs: 300 },
  });
  world = await startSeedWorld(api);
  const port = await listenOnFreePort(api.app);
  origin = `http://127.0.0.1:${String(port)}`;
  api.clock.now = NOW;
  for (const day of ['2026-10-22', '2026-10-23']) {
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    await api.admin.query(
      `CREATE TABLE IF NOT EXISTS ticks_${day.replaceAll('-', '')} PARTITION OF ticks FOR VALUES FROM ('${day}') TO ('${next}')`,
    );
  }
  for (let i = 0; i < 100 && api.stream.listener?.connected !== true; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

afterAll(async () => {
  await world.finish();
  await api.close();
});

describe('the live client on the real API', () => {
  let web: ReturnType<typeof browser>;
  let client: ApiClient;

  beforeAll(() => {
    web = browser();
    client = createHttpClient({
      baseUrl: '',
      fetch: (url, init) => web.fetch(`${origin}${url}`, init),
      eventSource: (url) => web.eventSource(`${origin}${url}`),
      streamRetryMs: { first: 30, max: 60 },
    });
  });
  const events: SseEvent[] = [];
  let stopStream: () => void = () => undefined;

  it('has no owner before the login: 401 for a screen, null for the session, and a refusal of a wrong password', async () => {
    expect(await client.me()).toBeNull();
    expect(await failure(client.getSnapshot())).toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
    expect(
      await failure(client.login({ username: OWNER.username, password: 'wrong wrong wrong 1' })),
    ).toMatchObject({ status: 401, code: 'invalid_credentials' });
    await expect(client.logout()).resolves.toBeUndefined(); // nothing to end is fine

    // the stream is refused (401), and the client keeps trying: the login that follows makes it work
    stopStream = client.subscribe((event) => events.push(event));
  });

  it('logs in with the cookie of the page, and the stream that was refused opens and says resync', async () => {
    await client.login(OWNER);
    expect([...web.jar.keys()]).toEqual(['__Host-vmgs_session']);
    expect(await client.me()).toMatchObject({ username: OWNER.username, totpEnabled: false });
    await vi.waitFor(
      () => {
        expect(events.map((event) => event.event)).toContain('resync');
      },
      { timeout: 5000 },
    );
    expect(events.filter((event) => event.event === 'resync')).toHaveLength(1);
  });

  it('says 503 no_quote until a tick exists, then answers the snapshot, and the candles with their layers', async () => {
    expect(await failure(client.getSnapshot())).toMatchObject({ status: 503, code: 'no_quote' });

    await api.admin.query(
      'INSERT INTO ticks (ts, rx_at, symbol, bid, ask) VALUES ($1, $2, $3, $4, $5)',
      [new Date(NOW - 3000), new Date(NOW - 2500), 'XAUUSD', 4017.37, 4017.55],
    );
    await api.admin.query(
      `INSERT INTO worker_heartbeats (worker_name, heartbeat_at, metadata) VALUES ('worker', $1, $2::jsonb)`,
      [
        new Date(NOW - 4000),
        JSON.stringify({
          mode: 'record-only',
          provider: 'biquote',
          recorder: { feedState: 'LIVE' },
        }),
      ],
    );
    await api.admin.query(
      `INSERT INTO app_settings (key, value) VALUES ('engineState', $1::jsonb)`,
      [
        JSON.stringify({
          evaluatedAt: NOW - 2 * MINUTE_MS,
          regime: 'RANGE',
          volBucket: 'NORMAL',
          session: 'LONDON',
          newsState: 'CLEAR',
          atr5: 4.3,
          warmup: { ready: true, progressPct: 100, missingTimeframes: [] },
          waitReasons: [],
        }),
      ],
    );
    const snapshot = await client.getSnapshot();
    expect(snapshot).toMatchObject({
      symbol: 'XAUUSD',
      bid: 4017.37,
      ask: 4017.55,
      feedState: 'LIVE',
    });

    for (const [tf, ms] of [
      ['5m', 5 * MINUTE_MS],
      ['15m', 15 * MINUTE_MS],
      ['1h', HOUR],
    ] as const) {
      const candles = new Map<number, (typeof five)[number]>();
      for (const candle of five) {
        const openTime = Math.floor(candle.openTime / ms) * ms;
        const held = candles.get(openTime);
        candles.set(
          openTime,
          held === undefined
            ? { ...candle, openTime }
            : {
                ...held,
                h: Math.max(held.h, candle.h),
                l: Math.min(held.l, candle.l),
                c: candle.c,
              },
        );
      }
      const closed = [...candles.values()].filter((c) => c.openTime + ms <= NOW);
      await api.admin.query(
        `INSERT INTO candles (symbol, tf, open_time, o, h, l, c, tick_count, complete)
         SELECT 'XAUUSD', $1, x.t, x.o, x.h, x.l, x.c, 10, true
           FROM unnest($2::timestamptz[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[]) AS x(t, o, h, l, c)`,
        [
          tf,
          closed.map((c) => new Date(c.openTime)),
          closed.map((c) => c.o),
          closed.map((c) => c.h),
          closed.map((c) => c.l),
          closed.map((c) => c.c),
        ],
      );
    }
    const chart = await client.getCandles({
      tf: '15m',
      limit: 50,
      overlays: 'ema20,supertrend',
      objects: 'zones,trendlines,patterns,fib',
    });
    expect(chart.candles).toHaveLength(50);
    expect(Object.keys(chart.overlays).sort()).toEqual(['ema20', 'supertrend']);
    expect(chart.levels.length).toBeGreaterThan(0);
    expect((await client.getCandles({ tf: '5m', limit: 3 })).candles).toHaveLength(3);
  });

  it('lists the signals the worker wrote: open, a page and the next by its cursor, with filters', async () => {
    const make = (
      hours: number,
      strategy: 'trend_pullback' | 'sweep_reversal',
      side: 'BUY' | 'SELL',
    ) =>
      world.createSignal({
        strategy,
        side,
        generatedAt: SEED_AT + hours * HOUR,
        qualityScore: 70 + hours,
      });
    const a = await make(0, 'trend_pullback', 'BUY');
    const b = await make(1, 'trend_pullback', 'SELL');
    const c = await make(2, 'sweep_reversal', 'BUY');
    const d = await make(3, 'sweep_reversal', 'SELL');
    await make(4, 'trend_pullback', 'BUY'); // stays open
    await world.close(
      a,
      outcomeOf('WIN', SEED_AT + 40 * MINUTE_MS, { durationS: 2400 }),
      review('NO_FOLLOW_THROUGH'),
    );
    await world.close(
      b,
      outcomeOf('LOSS', SEED_AT + HOUR + 10 * MINUTE_MS, { durationS: 600 }),
      review('STOP_HUNT_REVERSAL'),
    );
    await world.close(
      c,
      outcomeOf('PARTIAL_WIN', SEED_AT + 2 * HOUR + 50 * MINUTE_MS, { durationS: 3000 }),
    );
    await world.close(d, outcomeOf('CANCELLED', SEED_AT + 3 * HOUR + MINUTE_MS));

    const open = await client.getOpenSignals();
    expect(open.items).toHaveLength(1);
    expect(open.openCount).toBe(1);

    const first = await client.getSignals({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await client.getSignals({ limit: 2, cursor: first.nextCursor ?? '' });
    expect(second.items.map((row) => row.signalId)).not.toContain(first.items[0]?.signalId);

    const wins = await client.getSignals({ result: 'WIN', strategy: 'trend_pullback', limit: 10 });
    expect(wins.items.map((row) => row.signalId)).toEqual([a.id]);
    const byR = await client.getSignals({ sort: 'realizedRNet', order: 'desc', limit: 10 });
    expect(byR.items[0]?.signalId).toBe(a.id);
    expect(await failure(client.getSignals({ limit: 2, cursor: 'not a cursor' }))).toMatchObject({
      status: 400,
      code: 'invalid_cursor',
    });

    const closedDetail = await client.getSignalDetail(a.id);
    expect(closedDetail.outcome?.result).toBe('WIN');
    expect(closedDetail.state).toBeNull();
    expect(closedDetail.autopsy?.primaryCause).toBe('NO_FOLLOW_THROUGH');
    const openDetail = await client.getSignalDetail(open.items[0]?.signal.id ?? '');
    expect(openDetail.state).not.toBeNull();
    expect((await client.getSignalSnapshot(a.id)).features).toBeDefined();
    expect(
      await failure(client.getSignalDetail('0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e99')),
    ).toMatchObject({
      status: 404,
      code: 'not_found',
    });

    const pruned = await world.createSignal({
      generatedAt: SEED_AT - 400 * 24 * HOUR,
      draft: {
        featureSnapshot: { pruned: true, prunedAt: '2026-10-01T00:00:00.000Z', spread: 0.12 },
      },
    });
    expect(await failure(client.getSignalSnapshot(pruned.id))).toMatchObject({
      status: 404,
      code: 'snapshot_pruned',
    });
  });

  it('answers every analytics section, for the forward scope and for the other', async () => {
    const overview = await client.getOverview({});
    expect(overview.generated).toBeGreaterThan(0);
    expect((await client.getOverview({ scope: 'BACKTEST_OOS' })).generated).toBe(0);
    expect(
      (await client.getOverview({ strategy: 'trend_pullback', from: '2026-10-01T00:00:00.000Z' }))
        .generated,
    ).toBeGreaterThan(0);
    expect((await client.getMonthly({ months: 6 })).items.length).toBeGreaterThan(0);
    for (const by of ['strategy', 'side', 'session', 'regime'] as const) {
      expect((await client.getBreakdown({ by })).items.length).toBeGreaterThan(0);
    }
    expect((await client.getFailures({})).causes.length).toBeGreaterThan(0);
    await client.getGroupEffectiveness({});
    expect((await client.getCalibration({})).items.length).toBeGreaterThan(0);
    expect((await client.getEquity({})).items.length).toBeGreaterThan(0);
    await client.getDrift();
    await client.getNewsImpact();
    expect(
      await failure(
        client.getOverview({ from: '2026-10-02T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }),
      ),
    ).toMatchObject({ status: 400, code: 'invalid_request' });
  });

  it('answers the news screens, the system screens and the strategies and the settings', async () => {
    await api.admin.query(
      `INSERT INTO macro_events (id, source, source_event_id, scheduled_at, currency, name, importance, raw)
       VALUES ('0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e90', 'biquote', 'ev-1', $1, 'USD', 'US CPI m/m', 'high', '{}'::jsonb)`,
      [new Date(NOW + 10 * MINUTE_MS)],
    );
    await api.admin.query(
      `INSERT INTO worker_heartbeats (worker_name, heartbeat_at) VALUES ('calendar', $1)
       ON CONFLICT (worker_name) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`,
      [new Date(NOW - 5000)],
    );
    expect((await client.getNewsState()).state).toBe('IN_WINDOW');
    expect((await client.getNewsEvents({})).items).toHaveLength(1);
    expect((await client.getNewsEvents({ importance: 'low' })).items).toHaveLength(0);
    await client.getHeadlines({ minImpact: 'HIGH', limit: 10 });
    await client.getMarketMoves({});

    await client.getSystemHealth();
    await client.getSystemIncidents();
    await client.getSystemStorage();
    await client.getSystemLatency();

    const strategies = await client.getStrategies();
    expect(strategies.length).toBeGreaterThan(0);
    const key = strategies[0]?.key;
    if (key === undefined) throw new Error('no strategy');
    expect((await client.updateStrategy(key, { enabled: false })).enabled).toBe(false);
    expect((await client.getStrategies()).find((s) => s.key === key)?.enabled).toBe(false);
    expect((await client.updateStrategy(key, { enabled: true })).enabled).toBe(true);
    expect((await client.getStrategyConfig(key)).key).toBe(key);

    const settings = await client.getSettings();
    const changed = await client.updateSettings({ displayTz: 'Europe/London' });
    expect(changed.displayTz).toBe('Europe/London');
    expect((await client.updateSettings({ displayTz: settings.displayTz })).displayTz).toBe(
      settings.displayTz,
    );
    expect(await failure(client.updateSettings({ displayTz: 'Not/AZone' }))).toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(await failure(client.sendTestNotification({ channel: 'webpush' }))).toMatchObject({
      status: 409,
      code: 'no_push_subscription',
    });
    expect((await client.sendTestNotification({ channel: 'telegram' })).eventKey).toMatch(/^test:/);
  });

  it('pauses and resumes the engine, and the stream tells the page the engine changed', async () => {
    const before = events.length;
    await client.pauseEngine({ minutes: 10 });
    expect((await client.getSnapshot()).engine.status).toBe('PAUSED');
    await vi.waitFor(
      () => {
        expect(
          events.slice(before).some((e) => e.event === 'engine' && e.data.status === 'PAUSED'),
        ).toBe(true);
      },
      { timeout: 5000 },
    );
    expect(await failure(client.pauseEngine({}))).toMatchObject({
      status: 409,
      code: 'already_paused',
    });
    await client.resumeEngine();
    expect((await client.getSnapshot()).engine.status).toBe('RUNNING');
    expect(await failure(client.resumeEngine())).toMatchObject({ status: 409, code: 'not_paused' });
    expect(await failure(client.pauseEngine({ minutes: 0 }))).toMatchObject({ status: 400 });
  });

  it('brings a new signal to the page over the stream (the worker announces it, the API sends it)', async () => {
    const before = events.length;
    const signal = await world.createSignal({ generatedAt: SEED_AT + 9 * HOUR });
    await vi.waitFor(
      () => {
        expect(
          events.slice(before).some((e) => e.event === 'signal' && e.data.id === signal.id),
        ).toBe(true);
      },
      { timeout: 5000 },
    );
    expect(events.some((e) => e.event === 'quote')).toBe(true);
  });

  it('keeps the sessions: the current first, another one revoked by its id, a password changed and changed back', async () => {
    const sessions = await client.getSessions();
    expect(sessions.items.length).toBeGreaterThan(1);
    expect(sessions.items[0]?.current).toBe(true);
    const other = sessions.items.find((session) => !session.current);
    if (other === undefined) throw new Error('no other session');
    await client.revokeSession(other.id);
    expect((await client.getSessions()).items).toHaveLength(1);
    expect(await failure(client.revokeSession('not-a-session'))).toMatchObject({ status: 404 });

    expect(
      await failure(
        client.changePassword({ current: 'wrong wrong wrong 2', next: 'another long phrase' }),
      ),
    ).toMatchObject({ status: 403, code: 'wrong_password' });
    await client.changePassword({ current: OWNER.password, next: 'another long phrase!' });
    await client.changePassword({ current: 'another long phrase!', next: OWNER.password });
    expect(await client.me()).not.toBeNull();
  });

  it('sets up the second step, refuses a wrong code, turns it on with the right one and off again', async () => {
    const setup = await client.setupTotp();
    expect(setup.secret).toMatch(/^[A-Z2-7]+$/);
    expect(setup.otpauthUrl).toContain('otpauth://');
    expect(await failure(client.enableTotp({ code: '000000' }))).toMatchObject({
      status: 400,
      code: 'invalid_code',
    });
    const code = await generate({ secret: setup.secret, epoch: Math.floor(api.clock.now / 1000) });
    const enabled = await client.enableTotp({ code });
    expect(enabled.recoveryCodes).toHaveLength(8);
    expect((await client.me())?.totpEnabled).toBe(true);
    expect(await failure(client.setupTotp())).toMatchObject({
      status: 409,
      code: 'totp_already_enabled',
    });

    api.clock.now += 30_000; // a code works once: the next step
    const next = await generate({ secret: setup.secret, epoch: Math.floor(api.clock.now / 1000) });
    await client.disableTotp({ code: next });
    expect((await client.me())?.totpEnabled).toBe(false);
  });

  it('logs out: the cookie is gone, the session is over, and the page is back to a login', async () => {
    await client.logout();
    expect(web.jar.size).toBe(0);
    expect(await client.me()).toBeNull();
    expect(await failure(client.getSettings())).toMatchObject({ status: 401 });
    await client.logout(); // twice is fine
    stopStream();
  });

  it('says network_error when the server is not there', async () => {
    const lost = createHttpClient({
      baseUrl: '',
      fetch: (url, init) => web.fetch(`http://127.0.0.1:1${url}`, init),
    });
    expect(await failure(lost.getSettings())).toMatchObject({ status: 0, code: 'network_error' });
  });
});
