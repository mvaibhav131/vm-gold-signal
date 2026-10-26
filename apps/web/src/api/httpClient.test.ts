import { sseEventSchema, type SseEvent } from '@vmgs/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMockClient } from '../mocks/mockClient';
import { memoryStorage } from '../test-utils';
import { ApiError, type ApiClient } from './client';
import {
  STREAM_EVENT_NAMES,
  createHttpClient,
  queryString,
  type EventSourceLike,
  type FetchInit,
  type FetchLike,
} from './httpClient';

afterEach(() => {
  vi.useRealTimers();
});

interface Call {
  readonly url: string;
  readonly init: FetchInit;
}

/** A fetch that answers from a queue and remembers what it was asked. */
function fakeFetch(...replies: ({ status: number; body?: unknown } | Error)[]) {
  const calls: Call[] = [];
  const queue = [...replies];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const next = queue.shift() ?? { status: 204 };
    if (next instanceof Error) return Promise.reject(next);
    const text =
      next.body === undefined
        ? ''
        : typeof next.body === 'string'
          ? next.body
          : JSON.stringify(next.body);
    return Promise.resolve({ status: next.status, text: () => Promise.resolve(text) });
  };
  return { calls, fetch };
}

const problem = (status: number, code: string, detail = 'Something.') => ({
  status,
  body: { type: 'about:blank', title: 'Title', status, code, detail },
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

describe('queryString', () => {
  it('writes a list as one comma-separated value and leaves out what is missing or empty', () => {
    expect(queryString(undefined)).toBe('');
    expect(queryString({})).toBe('');
    expect(queryString({ tf: '15m', limit: 200, before: undefined, cursor: '', x: null })).toBe(
      '?tf=15m&limit=200',
    );
    expect(queryString({ overlays: ['ema20', 'ema50'], objects: [] })).toBe(
      '?overlays=ema20%2Cema50',
    );
    expect(queryString({ from: '2026-10-01T00:00:00.000Z', side: 'BUY' })).toBe(
      '?from=2026-10-01T00%3A00%3A00.000Z&side=BUY',
    );
  });
});

describe('a request', () => {
  it('is a GET with the cookie of the page, no CSRF header and no body', async () => {
    const { calls, fetch } = fakeFetch({ status: 200, body: { items: [] } });
    const client = createHttpClient({ fetch });
    await client.getSessions();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/v1/auth/sessions');
    expect(calls[0]?.init).toEqual({
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
    });
  });

  it('puts the query after the path, and a base address before it', async () => {
    const { calls, fetch } = fakeFetch(
      { status: 200, body: { candles: [], overlays: {}, levels: [], objects: [] } },
      { status: 404, body: problem(404, 'not_found').body },
    );
    const client = createHttpClient({ fetch, baseUrl: 'http://localhost:5173' });
    await client.getCandles({
      tf: '15m',
      limit: 3,
      overlays: 'ema20',
      objects: 'zones,fib',
    });
    expect(calls[0]?.url).toBe(
      'http://localhost:5173/api/v1/market/candles?tf=15m&limit=3&overlays=ema20&objects=zones%2Cfib',
    );
    await failure(client.getSignalDetail('a/b c'));
    expect(calls[1]?.url).toBe('http://localhost:5173/api/v1/signals/a%2Fb%20c');
  });

  it('is a change with the CSRF header, and a JSON body when it has one', async () => {
    const { calls, fetch } = fakeFetch({ status: 204 }, { status: 204 }, { status: 204 });
    const client = createHttpClient({ fetch });
    await client.login({ username: 'owner', password: 'a long enough phrase' });
    await client.pauseEngine({ minutes: 30 });
    await client.resumeEngine();
    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      'POST /api/v1/auth/login',
      'POST /api/v1/engine/pause',
      'POST /api/v1/engine/resume',
    ]);
    for (const call of calls) expect(call.init.headers['x-vmgs-csrf']).toBe('1');
    expect(calls[0]?.init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual({
      username: 'owner',
      password: 'a long enough phrase',
    });
    expect(calls[1]?.init.body).toBe('{"minutes":30}');
    expect(calls[2]?.init.body).toBeUndefined();
    expect(calls[2]?.init.headers['content-type']).toBeUndefined();
  });

  it('sends the pause of no length as an empty object', async () => {
    const { calls, fetch } = fakeFetch({ status: 204 });
    await createHttpClient({ fetch }).pauseEngine({});
    expect(calls[0]?.init.body).toBe('{}');
  });

  it('asks for a session to be revoked by its encoded id, with DELETE', async () => {
    const { calls, fetch } = fakeFetch({ status: 204 });
    await createHttpClient({ fetch }).revokeSession('ab12/cd');
    expect(calls[0]?.init.method).toBe('DELETE');
    expect(calls[0]?.url).toBe('/api/v1/auth/sessions/ab12%2Fcd');
    expect(calls[0]?.init.headers['x-vmgs-csrf']).toBe('1');
  });

  it('answers a PATCH with the entry it parsed, and unwraps the list of strategies', async () => {
    const mock = createMockClient({ storage: memoryStorage(), latencyMs: 0 });
    const strategies = await mock.getStrategies();
    const first = strategies[0];
    if (first === undefined) throw new Error('the mock has no strategy');
    const { calls, fetch } = fakeFetch(
      { status: 200, body: { items: strategies } },
      { status: 200, body: { ...first, enabled: false } },
    );
    const client = createHttpClient({ fetch });
    expect(await client.getStrategies()).toEqual(strategies);
    expect(await client.updateStrategy(first.key, { enabled: false })).toEqual({
      ...first,
      enabled: false,
    });
    expect(calls[1]?.init.method).toBe('PATCH');
    expect(calls[1]?.url).toBe(`/api/v1/strategies/${first.key}`);
    expect(calls[1]?.init.body).toBe('{"enabled":false}');
  });

  it('reads the settings the mock makes (a full answer is parsed with its schema)', async () => {
    const mock = createMockClient({ storage: memoryStorage(), latencyMs: 0 });
    const settings = await mock.getSettings();
    const { fetch } = fakeFetch({ status: 200, body: settings });
    expect(await createHttpClient({ fetch }).getSettings()).toEqual(settings);
  });
});

describe('an error', () => {
  it('is the problem+json of the server: its status, its code and its detail', async () => {
    const { fetch } = fakeFetch(
      problem(401, 'unauthenticated', 'There is no valid session.'),
      problem(404, 'snapshot_pruned', 'The snapshot was removed.'),
      problem(429, 'rate_limited', 'Too many tries.'),
    );
    const client = createHttpClient({ fetch });
    expect(await failure(client.getSnapshot())).toMatchObject({
      status: 401,
      code: 'unauthenticated',
      message: 'There is no valid session.',
    });
    expect(await failure(client.getSignalSnapshot('x'))).toMatchObject({
      status: 404,
      code: 'snapshot_pruned',
    });
    expect(await failure(client.login({ username: 'a', password: 'b' }))).toMatchObject({
      status: 429,
      code: 'rate_limited',
    });
  });

  it('is still an ApiError when the answer is no problem+json (a proxy page, an empty body)', async () => {
    const { fetch } = fakeFetch(
      { status: 502, body: '<html>Bad gateway</html>' },
      { status: 500 },
      { status: 503, body: JSON.stringify([1, 2]) },
      { status: 400, body: { title: 'Only a title' } },
    );
    const client = createHttpClient({ fetch });
    expect(await failure(client.getSettings())).toMatchObject({ status: 502, code: 'http_error' });
    expect(await failure(client.getSettings())).toMatchObject({ status: 500, code: 'http_error' });
    expect(await failure(client.getSettings())).toMatchObject({ status: 503, code: 'http_error' });
    expect(await failure(client.getSettings())).toMatchObject({
      status: 400,
      code: 'http_error',
      message: 'Only a title',
    });
  });

  it('is status 0 and network_error when the server cannot be reached', async () => {
    const { fetch } = fakeFetch(new TypeError('Failed to fetch'));
    expect(await failure(createHttpClient({ fetch }).getSettings())).toMatchObject({
      status: 0,
      code: 'network_error',
    });
  });

  it('is invalid_response when an answer of 200 is not JSON or does not match its contract, naming fields and never values', async () => {
    const { fetch } = fakeFetch(
      { status: 200, body: 'not json' },
      { status: 200, body: { username: 'secret-name-xyz', totpEnabled: 'yes' } },
    );
    const client = createHttpClient({ fetch });
    expect(await failure(client.getSettings())).toMatchObject({
      status: 502,
      code: 'invalid_response',
    });
    const mismatch = await failure(client.getSessions());
    expect(mismatch).toMatchObject({ status: 502, code: 'invalid_response' });
    const mismatched = await failure(
      createHttpClient({
        fetch: fakeFetch({ status: 200, body: { username: 'secret-name-xyz', totpEnabled: 'yes' } })
          .fetch,
      }).getSessions(),
    );
    expect(mismatched.message).not.toContain('secret-name-xyz');
  });
});

describe('every endpoint', () => {
  const sample = '2026-10-01T00:00:00.000Z';
  const encoded = '2026-10-01T00%3A00%3A00.000Z';
  const gets: [string, (client: ApiClient) => Promise<unknown>, string][] = [
    ['getSettings', (c) => c.getSettings(), '/settings'],
    ['getSnapshot', (c) => c.getSnapshot(), '/market/snapshot'],
    ['getStrategies', (c) => c.getStrategies(), '/strategies'],
    [
      'getCandles',
      (c) =>
        c.getCandles({ tf: '1h', limit: 5, before: sample, overlays: 'ema20', objects: 'fib' }),
      `/market/candles?tf=1h&limit=5&before=${encoded}&overlays=ema20&objects=fib`,
    ],
    ['getOpenSignals', (c) => c.getOpenSignals(), '/signals/open'],
    [
      'getSignals',
      (c) => c.getSignals({ limit: 5, cursor: 'abc', result: 'WIN' }),
      '/signals?limit=5&cursor=abc&result=WIN',
    ],
    ['getSignalDetail', (c) => c.getSignalDetail('x'), '/signals/x'],
    ['getSignalSnapshot', (c) => c.getSignalSnapshot('x'), '/signals/x/snapshot'],
    [
      'getOverview',
      (c) => c.getOverview({ strategy: 'trend_pullback', scope: 'BACKTEST_OOS' }),
      '/analytics/overview?strategy=trend_pullback&scope=BACKTEST_OOS',
    ],
    ['getMonthly', (c) => c.getMonthly({ months: 6 }), '/analytics/monthly?months=6'],
    [
      'getBreakdown',
      (c) => c.getBreakdown({ by: 'side', scope: 'FORWARD' }),
      '/analytics/breakdown?by=side&scope=FORWARD',
    ],
    ['getFailures', (c) => c.getFailures({ from: sample }), `/analytics/failures?from=${encoded}`],
    [
      'getGroupEffectiveness',
      (c) => c.getGroupEffectiveness({ strategy: 'sweep_reversal' }),
      '/analytics/groups?strategy=sweep_reversal',
    ],
    [
      'getCalibration',
      (c) => c.getCalibration({ scope: 'FORWARD' }),
      '/analytics/score-calibration?scope=FORWARD',
    ],
    ['getEquity', (c) => c.getEquity({ to: sample }), `/analytics/equity?to=${encoded}`],
    ['getDrift', (c) => c.getDrift(), '/analytics/drift'],
    ['getNewsImpact', (c) => c.getNewsImpact(), '/analytics/news-impact'],
    ['getNewsState', (c) => c.getNewsState(), '/news/state'],
    ['getNewsEvents', (c) => c.getNewsEvents({ from: sample }), `/news/events?from=${encoded}`],
    [
      'getHeadlines',
      (c) => c.getHeadlines({ minImpact: 'HIGH', limit: 5 }),
      '/news/headlines?minImpact=HIGH&limit=5',
    ],
    ['getMarketMoves', (c) => c.getMarketMoves({ from: sample }), `/news/moves?from=${encoded}`],
    ['getSystemHealth', (c) => c.getSystemHealth(), '/system/health'],
    ['getSystemIncidents', (c) => c.getSystemIncidents(), '/system/incidents'],
    ['getSystemStorage', (c) => c.getSystemStorage(), '/system/storage'],
    ['getSystemLatency', (c) => c.getSystemLatency(), '/system/latency'],
    [
      'getStrategyConfig',
      (c) => c.getStrategyConfig('trend_pullback'),
      '/strategies/trend_pullback/config',
    ],
    ['getSessions', (c) => c.getSessions(), '/auth/sessions'],
    ['me', (c) => c.me(), '/auth/me'],
  ];

  it('is a GET to the path of the contract, with the query it was given', async () => {
    const { calls, fetch } = fakeFetch(...gets.map(() => ({ status: 200, body: {} })));
    const client = createHttpClient({ fetch });
    for (const [, call] of gets) await call(client).catch(() => undefined); // the answers do not match: the call is the point
    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual(
      gets.map(([, , url]) => `GET /api/v1${url}`),
    );
  });

  const changes: [string, (client: ApiClient) => Promise<unknown>, string, string, unknown][] = [
    [
      'updateSettings',
      (c) => c.updateSettings({ displayTz: 'Europe/London' }),
      'PATCH',
      '/settings',
      { displayTz: 'Europe/London' },
    ],
    [
      'updateStrategy',
      (c) => c.updateStrategy('sweep_reversal', { alerts: false }),
      'PATCH',
      '/strategies/sweep_reversal',
      { alerts: false },
    ],
    [
      'sendTestNotification',
      (c) => c.sendTestNotification({ channel: 'telegram' }),
      'POST',
      '/notifications/test',
      { channel: 'telegram' },
    ],
    ['setupTotp', (c) => c.setupTotp(), 'POST', '/auth/totp/setup', undefined],
    [
      'enableTotp',
      (c) => c.enableTotp({ code: '123456' }),
      'POST',
      '/auth/totp/enable',
      { code: '123456' },
    ],
    [
      'disableTotp',
      (c) => c.disableTotp({ code: '123456' }),
      'POST',
      '/auth/totp/disable',
      { code: '123456' },
    ],
    [
      'changePassword',
      (c) => c.changePassword({ current: 'a', next: 'b' }),
      'POST',
      '/auth/password',
      { current: 'a', next: 'b' },
    ],
    ['pauseEngine', (c) => c.pauseEngine({ minutes: 5 }), 'POST', '/engine/pause', { minutes: 5 }],
    ['resumeEngine', (c) => c.resumeEngine(), 'POST', '/engine/resume', undefined],
    ['logout', (c) => c.logout(), 'POST', '/auth/logout', undefined],
    ['revokeSession', (c) => c.revokeSession('abc'), 'DELETE', '/auth/sessions/abc', undefined],
  ];

  it('is a POST, PATCH or DELETE to the path of the contract, with the CSRF header and the body it was given', async () => {
    const { calls, fetch } = fakeFetch(...changes.map(() => ({ status: 200, body: {} })));
    const client = createHttpClient({ fetch });
    for (const [, call] of changes) await call(client).catch(() => undefined);
    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual(
      changes.map(([, , method, url]) => `${method} /api/v1${url}`),
    );
    expect(calls.map((call) => call.init.headers['x-vmgs-csrf'])).toEqual(changes.map(() => '1'));
    expect(
      calls.map((call) =>
        call.init.body === undefined ? undefined : (JSON.parse(call.init.body) as unknown),
      ),
    ).toEqual(changes.map(([, , , , body]) => body));
  });
});

describe('the session', () => {
  it('has no owner when the API says 401, and an error for anything else', async () => {
    const { fetch } = fakeFetch(
      problem(401, 'unauthenticated'),
      {
        status: 200,
        body: {
          username: 'owner',
          totpEnabled: false,
          sessionExpiresAt: '2026-11-02T10:00:00.000Z',
        },
      },
      problem(500, 'internal_error'),
    );
    const client = createHttpClient({ fetch });
    expect(await client.me()).toBeNull();
    expect(await client.me()).toEqual({
      username: 'owner',
      totpEnabled: false,
      sessionExpiresAt: '2026-11-02T10:00:00.000Z',
    });
    expect(await failure(client.me())).toMatchObject({ status: 500 });
  });

  it('ends quietly when there is no session to end, and fails for a real error', async () => {
    const { fetch } = fakeFetch(
      problem(401, 'unauthenticated'),
      { status: 204 },
      problem(500, 'x'),
    );
    const client = createHttpClient({ fetch });
    await expect(client.logout()).resolves.toBeUndefined();
    await expect(client.logout()).resolves.toBeUndefined();
    expect(await failure(client.logout())).toMatchObject({ status: 500 });
  });

  it('refuses a login with the generic 401 as an error the form can read', async () => {
    const { fetch } = fakeFetch(problem(401, 'invalid_credentials', 'Login failed.'));
    expect(
      await failure(createHttpClient({ fetch }).login({ username: 'a', password: 'b' })),
    ).toMatchObject({
      status: 401,
      code: 'invalid_credentials',
    });
  });
});

type Listener = (event: { data?: unknown }) => void;

class FakeSource implements EventSourceLike {
  static readonly made: FakeSource[] = [];
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(readonly url: string) {
    FakeSource.made.push(this);
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
  refuse(): void {
    this.readyState = 2;
    this.emit('error');
  }
}

function stream(options: { onProtocolProblem?: (message: string) => void } = {}) {
  FakeSource.made.length = 0;
  const client = createHttpClient({
    eventSource: (url) => new FakeSource(url),
    streamRetryMs: { first: 1000, max: 4000 },
    ...options,
  });
  const events: SseEvent[] = [];
  const stop = client.subscribe((event) => events.push(event));
  const source = (index = 0): FakeSource => {
    const found = FakeSource.made[index];
    if (found === undefined) throw new Error(`no source ${String(index)}`);
    return found;
  };
  return { events, stop, source };
}

const QUOTE = { bid: 4017.3, ask: 4017.5, spread: 0.2, ageMs: 400, feedState: 'LIVE' };

describe('the stream', () => {
  it('listens for every event the contract has', () => {
    const names = sseEventSchema.options.map((option) => option.shape.event.value);
    expect([...STREAM_EVENT_NAMES].sort()).toEqual([...names].sort());
  });

  it('opens one source on the stream address and hands on the events it parses', () => {
    const { events, source } = stream();
    expect(FakeSource.made).toHaveLength(1);
    expect(source().url).toBe('/api/v1/stream');
    source().open();
    source().emit('quote', JSON.stringify(QUOTE));
    source().emit(
      'engine',
      JSON.stringify({ status: 'PAUSED', waitReasons: [], regime: 'RANGE', session: 'ASIA' }),
    );
    source().emit('resync', '{}');
    expect(events).toEqual([
      { event: 'quote', data: QUOTE },
      {
        event: 'engine',
        data: { status: 'PAUSED', waitReasons: [], regime: 'RANGE', session: 'ASIA' },
      },
      { event: 'resync', data: {} },
    ]);
  });

  it('drops an event that does not match its contract and says so, and goes on', () => {
    const problems: string[] = [];
    const { events, source } = stream({ onProtocolProblem: (message) => problems.push(message) });
    source().open();
    source().emit('quote', JSON.stringify({ bid: 'x' }));
    source().emit('quote', 'not json');
    source().emit('quote', undefined);
    source().emit('quote', JSON.stringify(QUOTE));
    expect(events).toEqual([{ event: 'quote', data: QUOTE }]);
    expect(problems).toEqual([
      'an event of the stream is not valid: quote',
      'an event of the stream is not valid: quote',
      'an event of the stream is not valid: quote',
    ]);
  });

  it('leaves a browser that is connecting again alone: it does that by itself and the server replays', () => {
    vi.useFakeTimers();
    const { events, source } = stream();
    source().open();
    source().readyState = 0; // the connection dropped; the browser is trying again
    source().emit('error');
    vi.advanceTimersByTime(60_000);
    expect(FakeSource.made).toHaveLength(1); // no second source, now or later
    expect(source().closed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    source().open();
    expect(events).toEqual([]); // no resync: the server decides, with Last-Event-ID
  });

  it('opens the stream again after the server refused it, with a growing wait, and tells the screens to reload', () => {
    vi.useFakeTimers();
    const { events, source } = stream();
    source().refuse(); // 401, 429 and the like: the browser closes it for good
    expect(source().closed).toBe(true);
    vi.advanceTimersByTime(999);
    expect(FakeSource.made).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSource.made).toHaveLength(2);

    source(1).refuse();
    vi.advanceTimersByTime(1999);
    expect(FakeSource.made).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSource.made).toHaveLength(3);

    source(2).refuse();
    vi.advanceTimersByTime(4000); // 4 s is the most
    expect(FakeSource.made).toHaveLength(4);
    expect(events).toEqual([]);

    // a source that was made again has no Last-Event-ID: its first open is a resync, once
    source(3).open();
    expect(events).toEqual([{ event: 'resync', data: {} }]);
    source(3).emit('error'); // connecting again: nothing
    source(3).open();
    expect(events).toHaveLength(1);
  });

  it('starts the waits again from the first one after a source opened', () => {
    vi.useFakeTimers();
    const { source } = stream();
    source().refuse();
    vi.advanceTimersByTime(1000);
    source(1).refuse();
    vi.advanceTimersByTime(2000);
    source(2).open();
    source(2).refuse();
    vi.advanceTimersByTime(999);
    expect(FakeSource.made).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeSource.made).toHaveLength(4);
  });

  it('closes its source and its timer when it is left, and says nothing after that', () => {
    vi.useFakeTimers();
    const first = stream();
    first.source().open();
    first.stop();
    expect(first.source().closed).toBe(true);

    const second = stream();
    second.source().refuse();
    expect(vi.getTimerCount()).toBe(1);
    second.stop(); // while it waits to try again
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(FakeSource.made).toHaveLength(1);
    second.source().emit('quote', JSON.stringify(QUOTE));
    expect(second.events).toEqual([]); // even a late event of the source that was closed is not handed on

    // a late refusal of a source that was closed does not start a wait
    const third = stream();
    third.source().open();
    third.stop();
    third.source().emit('error');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('has no EventSource to use in a browser that lacks it: an error, not a silent screen', () => {
    vi.stubGlobal('EventSource', undefined);
    try {
      expect(() => createHttpClient().subscribe(() => undefined)).toThrow('no EventSource');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
