import { STRATEGY_KEYS } from '@vmgs/core';
import { sseEventSchema, type SseEvent } from '@vmgs/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import { MOCK_PASSWORD, MOCK_USERNAME, createMockClient, seededRandom } from './mockClient';
import { SCENARIOS } from './scenarios';

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
}

function client(options: Parameters<typeof createMockClient>[0] = {}) {
  return createMockClient({
    storage: memoryStorage(),
    latencyMs: 0,
    quoteIntervalMs: 1000,
    scenario: 'two-open',
    ...options,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('seededRandom', () => {
  it('gives the same sequence for the same seed and values in [0, 1)', () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const first = Array.from({ length: 5 }, () => a());
    expect(first).toEqual(Array.from({ length: 5 }, () => b()));
    expect(first.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(seededRandom(8)()).not.toBe(first[0]);
  });
});

describe('mock client login', () => {
  const owner = { username: MOCK_USERNAME, password: MOCK_PASSWORD };

  it('starts without a session', async () => {
    expect(await client().me()).toBeNull();
  });

  it('accepts the preview credentials and opens a session', async () => {
    const api = client();
    await api.login(owner);
    expect(await api.me()).toMatchObject({ username: MOCK_USERNAME, totpEnabled: false });
  });

  it('answers every failure the same way (generic 401)', async () => {
    const api = client();
    const wrongPassword = await api.login({ ...owner, password: 'nope' }).catch((e: unknown) => e);
    const wrongUser = await api.login({ ...owner, username: 'nobody' }).catch((e: unknown) => e);
    const badCode = await api.login({ ...owner, totp: 'abc' }).catch((e: unknown) => e);
    for (const error of [wrongPassword, wrongUser, badCode]) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        status: 401,
        code: 'invalid_credentials',
        message: 'Login failed.',
      });
    }
    expect(await api.me()).toBeNull();
  });

  it('closes the session on logout', async () => {
    const api = client();
    await api.login(owner);
    await api.logout();
    expect(await api.me()).toBeNull();
  });

  it('expires the session after 12 hours', async () => {
    let now = new Date('2026-10-23T06:00:00Z');
    const api = client({ now: () => now });
    await api.login(owner);
    now = new Date('2026-10-23T17:59:00Z');
    expect(await api.me()).not.toBeNull();
    now = new Date('2026-10-23T18:00:01Z');
    expect(await api.me()).toBeNull();
  });
});

describe('mock client data follows the contracts', () => {
  it('is marked as a preview with its own credentials', () => {
    const api = client();
    expect(api.kind).toBe('mock');
    expect(api.preview).toEqual({ username: MOCK_USERNAME, password: MOCK_PASSWORD });
  });

  it('always reports SIMULATED data (rule C8)', async () => {
    const snapshot = await client().getSnapshot();
    expect(snapshot.mode).toBe('SIMULATED');
    expect(snapshot.symbol).toBe('XAUUSD');
    expect(snapshot.engine.status).toBe('RUNNING');
  });

  it('lists the five strategies, alerts on for A, B and C only, none validated', async () => {
    const strategies = await client().getStrategies();
    expect(strategies.map((s) => s.key)).toEqual([...STRATEGY_KEYS]);
    expect(strategies.filter((s) => s.alerts).map((s) => s.key)).toEqual([
      'trend_pullback',
      'sweep_reversal',
      'squeeze_retest',
    ]);
    expect(strategies.some((s) => s.status === 'VALIDATED')).toBe(false);
  });

  it('shows times in IST by default', async () => {
    expect((await client().getSettings()).displayTz).toBe('Asia/Kolkata');
  });

  it('answers every endpoint of the dashboard in every scenario with valid data', async () => {
    for (const { id } of SCENARIOS) {
      const api = client({ scenario: id });
      const [snapshot, open, recent, today, news, headlines, candles] = await Promise.all([
        api.getSnapshot(),
        api.getOpenSignals(),
        api.getSignals({ limit: 5 }),
        api.getOverview({}),
        api.getNewsState(),
        api.getHeadlines({ limit: 3 }),
        api.getCandles({ tf: '5m', limit: 50, overlays: 'ema20,ema50', objects: 'zones' }),
      ]);
      expect(snapshot.engine.openCount, id).toBe(open.openCount);
      expect(recent.items.length, id).toBeLessThanOrEqual(5);
      expect(today.generated, id).toBeGreaterThan(0);
      expect(news.next, id).not.toBeNull();
      expect(headlines.items, id).toHaveLength(3);
      expect(candles.candles, id).toHaveLength(50);
    }
  });
});

describe('scenarios', () => {
  it('lists the states the owner can switch to, starting with two open signals', () => {
    const api = client();
    expect(api.scenarios?.scenarios.map((s) => s.id)).toEqual([
      'two-open',
      'open-buy',
      'tp1-hit',
      'wait',
      'warming-up',
      'stale',
      'disconnected',
      'market-closed',
      'paused',
    ]);
    expect(api.scenarios?.current()).toBe('two-open');
  });

  it('starts in the state named in the options and falls back to the default for an unknown name', () => {
    expect(client({ scenario: 'wait' }).scenarios?.current()).toBe('wait');
    expect(client({ scenario: 'nonsense' }).scenarios?.current()).toBe('two-open');
  });

  it('remembers the owner’s choice for the next page load', () => {
    const storage = memoryStorage();
    const first = createMockClient({ storage, latencyMs: 0, scenario: 'two-open' });
    first.scenarios?.set('stale');
    const second = createMockClient({ storage, latencyMs: 0 });
    expect(second.scenarios?.current()).toBe('stale');
  });

  it('two open signals: the newest first, the SELL opposes the BUY, 1R open risk each', async () => {
    const api = client();
    const open = await api.getOpenSignals();
    expect(open.items.map((i) => [i.signal.seq, i.signal.side])).toEqual([
      [43, 'SELL'],
      [42, 'BUY'],
    ]);
    expect(open.openCount).toBe(2);
    expect(open.openRiskR).toBe(2);
    const sell = open.items[0]?.signal;
    expect(sell?.warnings).toContain('OPPOSES_OPEN');
    expect(sell?.explanation.warnings.find((w) => w.code === 'OPPOSES_OPEN')?.text).toBe(
      'Opposes open signal S-0042',
    );
    expect(sell?.explanation.open).toEqual({ count: 1, riskR: 1 });
  });

  it('the first signal has evidence with a rate and the second has too few trades for any percentage', async () => {
    const [sell, buy] = (await client().getOpenSignals()).items.map((i) => i.signal.evidence);
    expect(buy).toMatchObject({
      n: 64,
      sampleLabel: 'LOW_SAMPLE',
      winRate: 0.58,
      ci: [0.46, 0.69],
    });
    expect(sell).toMatchObject({
      n: 18,
      wins: 10,
      sampleLabel: 'INSUFFICIENT',
      winRate: null,
      ci: null,
      expectancyR: null,
      profitFactor: null,
    });
  });

  it('every open signal explains all seven groups', async () => {
    for (const item of (await client().getOpenSignals()).items) {
      expect(item.signal.explanation.groups.map((g) => g.key)).toEqual([
        'trend',
        'structure',
        'trigger',
        'volatility',
        'execution',
        'sessionMacro',
        'reward',
      ]);
      expect(item.signal.explanation.groups.every((g) => g.facts.length > 0)).toBe(true);
    }
  });

  it('after TP1 the stop is at the entry and the signal says TP1_HIT', async () => {
    const [item] = (await client({ scenario: 'tp1-hit' }).getOpenSignals()).items;
    expect(item?.live.status).toBe('TP1_HIT');
    expect(item?.live.stopLossCurrent).toBe(item?.signal.entry);
    expect(item?.live.mfeR).toBeGreaterThanOrEqual(1);
  });

  it('no signal: the WAIT reasons of the document, news window open, range regime', async () => {
    const api = client({ scenario: 'wait' });
    const snapshot = await api.getSnapshot();
    expect(snapshot.engine.waitReasons.map((r) => r.label)).toEqual([
      'Spread too high: 0.90 USD',
      'News window: CPI in 22 min',
      'Regime: range, no strategy accepts it',
    ]);
    expect(snapshot.regime).toBe('RANGE');
    expect((await api.getOpenSignals()).openCount).toBe(0);
    expect((await api.getNewsState()).state).toBe('IN_WINDOW');
  });

  it('warming up names the missing timeframes', async () => {
    const { engine, feedState } = await client({ scenario: 'warming-up' }).getSnapshot();
    expect(feedState).toBe('WARMING_UP');
    expect(engine.warmup).toEqual({
      ready: false,
      progressPct: 62,
      missingTimeframes: ['1h', '4h'],
    });
  });

  it('stale and disconnected feeds keep the last price and let its age grow', async () => {
    let now = new Date('2026-10-23T10:00:00Z');
    const api = client({ scenario: 'stale', now: () => now });
    const first = await api.getSnapshot();
    now = new Date('2026-10-23T10:00:10Z');
    vi.useFakeTimers();
    let latest = first;
    const stop = api.subscribe((event) => {
      if (event.event === 'quote') latest = { ...latest, ...event.data, mid: latest.mid };
    });
    vi.advanceTimersByTime(1000);
    stop();
    expect(first.feedState).toBe('STALE');
    expect(first.ageMs).toBeGreaterThanOrEqual(18_400);
    expect(latest.feedState).toBe('STALE');
    expect(latest.bid).toBe(first.bid);
    expect(latest.ageMs).toBeGreaterThanOrEqual(28_400);
    expect((await client({ scenario: 'disconnected' }).getSnapshot()).feedState).toBe(
      'DISCONNECTED',
    );
  });

  it('market closed: no signals, the last tick is hours old', async () => {
    const api = client({ scenario: 'market-closed' });
    const snapshot = await api.getSnapshot();
    expect(snapshot.feedState).toBe('MARKET_CLOSED');
    expect(snapshot.ageMs).toBeGreaterThan(3_600_000);
    expect((await api.getOpenSignals()).openCount).toBe(0);
  });

  it('the live R of simulated signals stays between their stop and TP1 as time passes', async () => {
    let now = new Date('2026-10-23T06:00:00Z');
    const api = client({ now: () => now });
    for (let minute = 0; minute < 24 * 60; minute += 7) {
      now = new Date(Date.parse('2026-10-23T06:00:00Z') + minute * 60_000);
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const stop = api.subscribe(() => undefined);
      vi.advanceTimersByTime(1000);
      stop();
      vi.useRealTimers();
      for (const item of (await api.getOpenSignals()).items) {
        expect(item.live.unrealisedR).toBeGreaterThan(-1);
        expect(item.live.unrealisedR).toBeLessThan(1);
        expect(item.live.status).toBe('ACTIVE');
      }
    }
  });
});

describe('pause and resume', () => {
  it('the paused scenario starts paused with a time and a reason', async () => {
    const { engine } = await client({ scenario: 'paused' }).getSnapshot();
    expect(engine.status).toBe('PAUSED');
    expect(engine.pausedSince).toBeDefined();
    expect(engine.waitReasons.map((r) => r.code)).toEqual(['PAUSED']);
  });

  it('pause and resume change the engine state and tell the stream', async () => {
    const api = client({ scenario: 'open-buy' });
    const events: SseEvent[] = [];
    const stop = api.subscribe((event) => events.push(event));
    await api.pauseEngine({});
    expect((await api.getSnapshot()).engine.status).toBe('PAUSED');
    await api.resumeEngine();
    const after = await api.getSnapshot();
    expect(after.engine.status).toBe('RUNNING');
    expect(after.engine.pausedSince).toBeUndefined();
    stop();
    expect(events.filter((e) => e.event === 'engine').map((e) => e.data)).toMatchObject([
      { status: 'PAUSED' },
      { status: 'RUNNING' },
    ]);
  });

  it('a timed pause ends by itself', async () => {
    let now = new Date('2026-10-23T10:00:00Z');
    const api = client({ scenario: 'open-buy', now: () => now });
    await api.pauseEngine({ minutes: 30 });
    now = new Date('2026-10-23T10:29:00Z');
    expect((await api.getSnapshot()).engine.status).toBe('PAUSED');
    now = new Date('2026-10-23T10:31:00Z');
    expect((await api.getSnapshot()).engine.status).toBe('RUNNING');
  });

  it('open signals are still tracked while paused', async () => {
    const api = client({ scenario: 'paused' });
    expect((await api.getOpenSignals()).openCount).toBe(1);
  });
});

describe('mock stream', () => {
  it('sends a quote at once and then one per interval, all valid SSE events', () => {
    vi.useFakeTimers();
    const api = client();
    const events: SseEvent[] = [];
    const stop = api.subscribe((e) => events.push(e));
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    const quotes = events.filter((e) => e.event === 'quote');
    expect(quotes).toHaveLength(4);
    for (const event of events) expect(sseEventSchema.safeParse(event).success).toBe(true);
    stop();
  });

  it('sends signal_update for every open signal every 5 seconds, matching the REST values', async () => {
    vi.useFakeTimers();
    const api = client({ signalUpdateIntervalMs: 5000, quoteIntervalMs: 60_000 });
    const updates: Extract<SseEvent, { event: 'signal_update' }>[] = [];
    const stop = api.subscribe((e) => {
      if (e.event === 'signal_update') updates.push(e);
    });
    vi.advanceTimersByTime(4900);
    expect(updates).toHaveLength(0);
    vi.advanceTimersByTime(200);
    expect(updates).toHaveLength(2);
    for (const update of updates) expect(sseEventSchema.safeParse(update).success).toBe(true);
    stop();
    const open = await api.getOpenSignals();
    for (const update of updates) {
      const item = open.items.find((i) => i.signal.id === update.data.id);
      expect(item?.live.unrealisedR).toBe(update.data.unrealisedR);
    }
  });

  it('sends no updates while the feed is stale: the trade cannot be tracked', () => {
    vi.useFakeTimers();
    const api = client({ scenario: 'stale' });
    const updates: SseEvent[] = [];
    const stop = api.subscribe((e) => {
      if (e.event === 'signal_update') updates.push(e);
    });
    vi.advanceTimersByTime(20_000);
    stop();
    expect(updates).toEqual([]);
  });

  it('asks the client to reload everything with resync when the scenario changes', () => {
    const api = client();
    const events: SseEvent[] = [];
    const stop = api.subscribe((e) => events.push(e));
    api.scenarios?.set('wait');
    stop();
    expect(events.at(-1)).toEqual({ event: 'resync', data: {} });
  });

  it('stops after unsubscribe', () => {
    vi.useFakeTimers();
    const api = client();
    const events: SseEvent[] = [];
    const stop = api.subscribe((e) => events.push(e));
    stop();
    vi.advanceTimersByTime(5000);
    expect(events).toHaveLength(1);
  });

  it('is deterministic for a seed and keeps ask at or above bid', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T10:00:00Z'));
    const run = () => {
      vi.setSystemTime(new Date('2026-10-23T10:00:00Z'));
      const quotes: { bid: number; ask: number }[] = [];
      const stop = client({ seed: 42 }).subscribe((e) => {
        if (e.event === 'quote') quotes.push(e.data);
      });
      vi.advanceTimersByTime(20_000);
      stop();
      return quotes;
    };
    const first = run();
    expect(run()).toEqual(first);
    expect(first.length).toBeGreaterThan(10);
    expect(first.every((q) => q.ask >= q.bid)).toBe(true);
  });
});

describe('candles for the chart', () => {
  it('returns the requested number of closed candles with aligned overlays', async () => {
    const api = client();
    const result = await api.getCandles({
      tf: '5m',
      limit: 120,
      overlays: 'ema20,ema50,ema200,supertrend',
    });
    expect(result.candles).toHaveLength(120);
    for (const name of ['ema20', 'ema50', 'ema200', 'supertrend'] as const) {
      expect(result.overlays[name], name).toHaveLength(120);
      expect(
        result.overlays[name]?.every((v) => v !== null),
        name,
      ).toBe(true);
    }
  });

  it('draws objects only when asked for them', async () => {
    const api = client();
    expect((await api.getCandles({ tf: '5m', limit: 200 })).objects).toEqual([]);
    const withAll = await api.getCandles({
      tf: '5m',
      limit: 200,
      objects: 'trendlines,zones,patterns,fib',
    });
    expect(withAll.objects.length).toBeGreaterThan(0);
    // A channel is a line through two points and a parallel through the third, so only the others run in time order.
    for (const object of withAll.objects.filter((o) => o.type !== 'channel')) {
      const times = object.points.map((p) => Date.parse(p.t));
      expect(times, object.id).toEqual([...times].sort((a, b) => a - b));
    }
  });

  it('gives previous-day, session and round-number levels', async () => {
    const { levels } = await client().getCandles({ tf: '5m', limit: 20 });
    const keys = levels.map((l) => l.key);
    expect(keys).toEqual(expect.arrayContaining(['pdh', 'pdl', 'session-high', 'session-low']));
    expect(keys.some((k) => k.startsWith('round-'))).toBe(true);
    const price = (key: string) => levels.find((l) => l.key === key)?.price ?? 0;
    expect(price('pdh')).toBeGreaterThan(price('pdl'));
  });
});

describe('counters and recent signals', () => {
  it('today has one win, the month is under the minimum sample and carries no percentage', async () => {
    const api = client();
    const day = 86_400_000;
    const to = new Date('2026-10-23T12:00:00Z');
    const today = await api.getOverview({
      from: new Date(to.getTime() - day).toISOString(),
      to: to.toISOString(),
    });
    expect(today).toMatchObject({
      generated: 3,
      resolvedValid: 1,
      wins: 1,
      netR: 1.47,
      winRate: null,
    });
    const month = await api.getOverview({
      from: new Date(to.getTime() - 30 * day).toISOString(),
      to: to.toISOString(),
    });
    expect(month).toMatchObject({ generated: 15, resolvedValid: 12, winRate: null, ci95: null });
  });

  it('lists the open signals first, then finished ones with their results', async () => {
    const page = await client().getSignals({ limit: 5 });
    expect(page.items.map((row) => [row.seq, row.state, row.result])).toEqual([
      [43, 'ACTIVE', null],
      [42, 'ACTIVE', null],
      [41, 'CLOSED', 'WIN'],
      [40, 'CLOSED', 'LOSS'],
      [39, 'CLOSED', 'PARTIAL_WIN'],
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('headlines are labelled as simulated', async () => {
    const { items } = await client().getHeadlines({ limit: 3 });
    expect(items.every((item) => item.title.startsWith('Simulated headline'))).toBe(true);
  });
});
