import { STRATEGY_KEYS } from '@vmgs/core';
import { sseEventSchema, type SseEvent } from '@vmgs/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import {
  MOCK_PASSWORD,
  MOCK_TOTP_CODE,
  MOCK_USERNAME,
  createMockClient,
  seededRandom,
} from './mockClient';
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
    expect(api.preview).toEqual({
      username: MOCK_USERNAME,
      password: MOCK_PASSWORD,
      totp: MOCK_TOTP_CODE,
    });
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
      // With the calendar feed down the system cannot say what comes next, so there is no next event
      if (id === 'news-unknown') expect([news.state, news.next], id).toEqual(['UNKNOWN', null]);
      else expect(news.next, id).not.toBeNull();
      expect(headlines.items.length, id).toBeGreaterThan(0);
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
      'review-pending',
      'paused',
      'news-unknown',
      'system-warning',
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
    // the rest of the history is on the next pages, with the summary of the whole list
    expect(page.nextCursor).not.toBeNull();
    expect(page.summary.generated).toBe(43);
  });

  it('headlines are labelled as simulated', async () => {
    const { items } = await client().getHeadlines({ limit: 3 });
    expect(items.every((item) => item.title.startsWith('Simulated headline'))).toBe(true);
  });
});

describe('analytics endpoints', () => {
  it('the forward overview is the summary of the whole history list, and an open signal only adds to "generated"', async () => {
    for (const scenario of ['two-open', 'wait', 'review-pending']) {
      const api = client({ scenario });
      const overview = await api.getOverview({});
      expect(overview, scenario).toEqual((await api.getSignals({ limit: 1 })).summary);
      expect(await api.getOverview({ scope: 'FORWARD' }), scenario).toEqual(overview);
    }
    const [two, none] = await Promise.all([
      client({ scenario: 'two-open' }).getOverview({}),
      client({ scenario: 'wait' }).getOverview({}),
    ]);
    expect([two.generated, two.resolvedValid]).toEqual([43, 39]);
    expect([none.generated, none.resolvedValid]).toEqual([41, 39]);
  });

  it('the backtest overview is another set of results that is the same in every scenario', async () => {
    const [a, b] = await Promise.all([
      client({ scenario: 'two-open' }).getOverview({ scope: 'BACKTEST_OOS' }),
      client({ scenario: 'review-pending' }).getOverview({ scope: 'BACKTEST_OOS' }),
    ]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ generated: 318, resolvedValid: 302, winRate: 0.543, netR: 34.9 });
  });

  it('limits the overview to one strategy or to a date range', async () => {
    const api = client({ scenario: 'wait' });
    const trend = await api.getOverview({ scope: 'BACKTEST_OOS', strategy: 'trend_pullback' });
    expect(trend).toMatchObject({ resolvedValid: 214, winRate: 0.551 });
    // a strategy with fewer than 30 results has no percentage
    const sweep = await api.getOverview({ strategy: 'sweep_reversal' });
    expect(sweep.resolvedValid).toBe(11);
    expect([sweep.winRate, sweep.ci95]).toEqual([null, null]);
    const none = await api.getOverview({
      scope: 'BACKTEST_OOS',
      from: '2020-01-01T00:00:00Z',
      to: '2020-02-01T00:00:00Z',
    });
    expect(none).toMatchObject({ generated: 0, resolvedValid: 0, netR: 0 });
    // the first month of the backtest in IST (2025-07-01 00:00 IST is 2025-06-30 18:30 UTC)
    const first = (await api.getMonthly({ scope: 'BACKTEST_OOS' })).items[0];
    const july = await api.getOverview({
      scope: 'BACKTEST_OOS',
      from: '2025-06-30T18:30:00Z',
      to: '2025-07-31T18:30:00Z',
    });
    expect([july.generated, july.resolvedValid, july.netR]).toEqual([
      first?.generated,
      first?.resolvedValid,
      first?.netR,
    ]);
  });

  it('answers the monthly table by scope and keeps the last N months', async () => {
    const api = client({ scenario: 'wait' });
    expect((await api.getMonthly({})).items.map((m) => m.month)).toEqual([
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
    ]);
    const backtest = await api.getMonthly({ scope: 'BACKTEST_OOS' });
    expect(backtest.items).toHaveLength(12);
    expect(backtest.items.reduce((sum, m) => sum + m.generated, 0)).toBe(318);
    expect((await api.getMonthly({ scope: 'BACKTEST_OOS', months: 3 })).items).toHaveLength(3);
    const oneStrategy = await api.getMonthly({ scope: 'BACKTEST_OOS', strategy: 'squeeze_retest' });
    expect(oneStrategy.items.reduce((sum, m) => sum + m.resolvedValid, 0)).toBe(64);
  });

  it('answers the breakdown, failures, groups, calibration and equity curve for both scopes', async () => {
    const api = client({ scenario: 'wait' });
    for (const scope of ['FORWARD', 'BACKTEST_OOS'] as const) {
      const overview = await api.getOverview({ scope });
      const [side, failures, groups, calibration, equity] = await Promise.all([
        api.getBreakdown({ by: 'side', scope }),
        api.getFailures({ scope }),
        api.getGroupEffectiveness({ scope }),
        api.getCalibration({ scope }),
        api.getEquity({ scope }),
      ]);
      expect(side.by).toBe('side');
      expect(
        side.items.reduce((sum, i) => sum + i.n, 0),
        scope,
      ).toBe(overview.resolvedValid);
      expect(failures.causes.length, scope).toBeGreaterThan(0);
      expect(groups.items.length, scope).toBeGreaterThan(0);
      expect(
        calibration.items.reduce((sum, i) => sum + i.n, 0),
        scope,
      ).toBe(overview.resolvedValid);
      expect(equity.items, scope).toHaveLength(overview.resolvedValid);
      expect(equity.items.at(-1)?.netR, scope).toBe(overview.netR);
    }
  });

  it('the group view can be limited to one strategy', async () => {
    const { items } = await client().getGroupEffectiveness({
      scope: 'BACKTEST_OOS',
      strategy: 'squeeze_retest',
    });
    expect(new Set(items.map((i) => i.strategy))).toEqual(new Set(['squeeze_retest']));
  });

  it('the breakdown, the monthly table and the overview can be limited to one strategy, with a date range too', async () => {
    const api = client({ scenario: 'wait' });
    const total = (rows: { n: number }[]) => rows.reduce((sum, row) => sum + row.n, 0);
    expect(total((await api.getBreakdown({ by: 'side', strategy: 'sweep_reversal' })).items)).toBe(
      11,
    );
    expect(
      total(
        (await api.getBreakdown({ by: 'side', strategy: 'sweep_reversal', scope: 'BACKTEST_OOS' }))
          .items,
      ),
    ).toBe(24);
    // a date range with a strategy is computed, it is not the fixed counters of the dashboard
    const wide = { from: '2020-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' };
    expect(await api.getOverview({ ...wide, strategy: 'trend_pullback' })).toMatchObject({
      generated: 25,
      resolvedValid: 24,
    });
    expect(await api.getOverview({ ...wide, scope: 'BACKTEST_OOS' })).toMatchObject({
      generated: 318,
    });
  });

  it('drift is about the forward results only: every strategy has fewer than 30 so far, whatever the scope', async () => {
    const { items } = await client().getDrift();
    expect(items.map((i) => [i.strategy, i.status, i.rollingWinRate])).toEqual([
      ['trend_pullback', 'INSUFFICIENT_DATA', null],
      ['sweep_reversal', 'INSUFFICIENT_DATA', null],
      ['squeeze_retest', 'INSUFFICIENT_DATA', null],
    ]);
    // the evidence interval is the one of the backtest, as on the signals
    expect(items[0]?.evidenceCi95).toEqual([0.484, 0.617]);
    expect(items[1]?.evidenceCi95).toBeNull();
  });

  it('news impact is a table of topics and levels, with no percentage under 30 headlines', async () => {
    const { items } = await client().getNewsImpact();
    expect(items).toHaveLength(17);
    expect(items.filter((i) => i.movedShare === null).every((i) => i.n < 30)).toBe(true);
  });

  it('refuses a scope it does not know and a range that ends before it starts', async () => {
    const api = client();
    await expect(api.getOverview({ scope: 'LIVE' as never })).rejects.toThrow();
    await expect(api.getMonthly({ months: 0 })).rejects.toThrow();
    await expect(
      api.getEquity({ from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }),
    ).rejects.toThrow();
    await expect(api.getBreakdown({ by: 'colour' as never })).rejects.toThrow();
  });
});

describe('signal detail, snapshot and the chart around a trade', () => {
  const idOf = async (api: ReturnType<typeof client>, seq: number) => {
    const page = await api.getSignals({ limit: 200 });
    const row = page.items.find((item) => item.seq === seq);
    if (!row) throw new Error(`no signal ${String(seq)}`);
    return row.signalId;
  };

  it('gives an open signal a state and no outcome, with its events', async () => {
    const api = client({ scenario: 'tp1-hit' });
    const detail = await api.getSignalDetail(await idOf(api, 42));
    expect(detail.outcome).toBeNull();
    expect(detail.autopsy).toBeNull();
    expect(detail.state).toMatchObject({ status: 'TP1_HIT' });
    expect(detail.events.map((e) => e.eventType)).toEqual([
      'CREATED',
      'ALERT_QUEUED',
      'TP1_HIT',
      'STOP_MOVED_TO_ENTRY',
    ]);
  });

  it('gives a finished signal an outcome, its events and a review', async () => {
    const api = client();
    const detail = await api.getSignalDetail(await idOf(api, 40));
    expect(detail.state).toBeNull();
    expect(detail.outcome).toMatchObject({ result: 'LOSS', realizedRNet: -1.04 });
    expect(detail.autopsy).toMatchObject({ status: 'FINAL', primaryCause: 'NO_FOLLOW_THROUGH' });
    expect(detail.events.map((e) => e.eventType)).toContain('AUTOPSY_FINAL');
  });

  it('answers 404 not_found for an id that does not exist', async () => {
    const api = client();
    await expect(api.getSignalDetail('00000000-0000-4000-8000-ffffffffffff')).rejects.toMatchObject(
      {
        status: 404,
        code: 'not_found',
      },
    );
    await expect(
      api.getSignalSnapshot('00000000-0000-4000-8000-ffffffffffff'),
    ).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it('returns the snapshot of a signal, and 404 snapshot_pruned for the one that retention removed', async () => {
    const api = client();
    const snapshot = await api.getSignalSnapshot(await idOf(api, 12));
    expect(snapshot.features).toHaveProperty('groups');
    await expect(api.getSignalSnapshot(await idOf(api, 1))).rejects.toMatchObject({
      status: 404,
      code: 'snapshot_pruned',
    });
    const detail = await api.getSignalDetail(await idOf(api, 1));
    expect(detail.snapshotAvailable).toBe(false);
    // an open signal has its snapshot too
    expect((await api.getSignalSnapshot(await idOf(api, 42))).features).toHaveProperty(
      'indicators',
    );
  });

  it('draws the candles around a finished trade when the chart asks for the ones before its end', async () => {
    const api = client();
    const detail = await api.getSignalDetail(await idOf(api, 12));
    const exit = Date.parse(detail.outcome?.closedAt ?? '');
    const before = new Date(exit + 61 * 300_000).toISOString();
    const page = await api.getCandles({ tf: '5m', limit: 300, before });
    const times = page.candles.map((c) => Date.parse(c.t));
    expect(Math.max(...times)).toBeLessThan(Date.parse(before));
    expect(Math.min(...times)).toBeLessThanOrEqual(
      Date.parse(detail.signal.generatedAt) - 60 * 300_000,
    );
    // the trade's levels are inside the picture
    const highs = Math.max(...page.candles.map((c) => c.h));
    expect(highs).toBeGreaterThanOrEqual(detail.signal.tp2 ?? 0);
    expect(page.levels).toEqual([]);
    // limit counts from the end
    expect((await api.getCandles({ tf: '5m', limit: 10, before })).candles).toHaveLength(10);
  });

  it('falls back to the simulated market for a time that is not around a trade', async () => {
    const page = await client().getCandles({
      tf: '5m',
      limit: 20,
      before: new Date().toISOString(),
    });
    expect(page.candles).toHaveLength(20);
  });
});

describe('the preview state with a fresh loss', () => {
  it('adds one more signal whose review turns final 60 minutes after its close', async () => {
    let nowMs = Date.parse('2026-10-23T12:00:00Z');
    const api = client({ scenario: 'review-pending', now: () => new Date(nowMs) });
    const page = await api.getSignals({ limit: 5 });
    expect(page.items.map((row) => [row.seq, row.result, row.autopsyStatus])).toEqual([
      [42, 'LOSS', 'PRELIMINARY'],
      [41, 'WIN', null],
      [40, 'LOSS', 'FINAL'],
      [39, 'PARTIAL_WIN', 'FINAL'],
      [38, 'WIN', null],
    ]);
    const id = page.items[0]?.signalId ?? '';
    expect((await api.getSignalDetail(id)).autopsy).toMatchObject({ status: 'PRELIMINARY' });
    nowMs += 24 * 60_000;
    expect((await api.getSignalDetail(id)).autopsy).toMatchObject({ status: 'PRELIMINARY' });
    nowMs += 2 * 60_000;
    const final = await api.getSignalDetail(id);
    expect(final.autopsy).toMatchObject({ status: 'FINAL' });
    expect(final.autopsy?.counterfactual).not.toBeNull();
    expect((await api.getSignals({ limit: 1 })).items[0]?.autopsyStatus).toBe('FINAL');
  });

  it('does not exist in the other states', async () => {
    const page = await client({ scenario: 'wait' }).getSignals({ limit: 1 });
    expect(page.items[0]?.seq).toBe(41);
  });
});

describe('news endpoints', () => {
  it('answer by the state of the preview: clear, inside the window, or unknown with the feeds down', async () => {
    const states = await Promise.all(
      ['two-open', 'wait', 'news-unknown'].map(async (scenario) => {
        const api = client({ scenario });
        const [state, events, headlines] = await Promise.all([
          api.getNewsState(),
          api.getNewsEvents({}),
          api.getHeadlines({ limit: 50 }),
        ]);
        return { scenario, state, events, headlines };
      }),
    );
    expect(states.map((s) => s.state.state)).toEqual(['CLEAR', 'IN_WINDOW', 'UNKNOWN']);
    expect(states.map((s) => s.events.items.length)).toEqual([18, 18, 10]);
    expect(states.map((s) => s.headlines.items.length)).toEqual([14, 14, 11]);
    expect(
      states.map((s) => s.headlines.sources.every((source) => source.lastError === null)),
    ).toEqual([true, true, false]);
  });

  it('give the headlines the filters and the cursor of the contract, and refuse what the contract refuses', async () => {
    const api = client();
    expect((await api.getHeadlines({ limit: 50, minImpact: 'HIGH' })).items).toHaveLength(4);
    expect((await api.getHeadlines({ limit: 50, topic: 'FED_RATES' })).items).toHaveLength(3);
    const page = await api.getHeadlines({ limit: 5 });
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).not.toBeNull();
    const next = await api.getHeadlines({ limit: 5, cursor: page.nextCursor ?? '' });
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
    await expect(api.getHeadlines({ limit: 500 })).rejects.toThrow();
    await expect(api.getHeadlines({ limit: 5, minImpact: 'URGENT' as never })).rejects.toThrow();
    await expect(api.getHeadlines({ limit: 5, cursor: 'nonsense' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_cursor',
    });
  });

  it('give the calendar its importance filter and its range, and refuse a range that ends first', async () => {
    const api = client();
    expect((await api.getNewsEvents({ importance: 'high' })).items).toHaveLength(7);
    expect(
      (await api.getNewsEvents({ from: new Date().toISOString() })).items.length,
    ).toBeGreaterThan(0);
    await expect(api.getNewsEvents({ importance: 'urgent' as never })).rejects.toThrow();
    await expect(
      api.getNewsEvents({ from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }),
    ).rejects.toThrow();
  });

  it('list the market moves of a range, newest first', async () => {
    const api = client();
    expect((await api.getMarketMoves({})).items.map((m) => m.id)).toEqual([5, 4, 3, 2, 1]);
    const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
    expect((await api.getMarketMoves({ from: week })).items.length).toBeGreaterThan(0);
    await expect(
      api.getMarketMoves({ to: '2026-01-01T00:00:00Z', from: '2026-02-01T00:00:00Z' }),
    ).rejects.toThrow();
  });
});

describe('system endpoints', () => {
  it('answer health, incidents, storage and latency for every preview state', async () => {
    for (const { id } of SCENARIOS) {
      const api = client({ scenario: id });
      const [health, incidents, storage, latency] = await Promise.all([
        api.getSystemHealth(),
        api.getSystemIncidents(),
        api.getSystemStorage(),
        api.getSystemLatency(),
      ]);
      expect(health.dbReachable, id).toBe(true);
      expect(incidents.items.length, id).toBeGreaterThanOrEqual(9);
      expect(storage.tables.length, id).toBeGreaterThan(0);
      expect(latency.dbCommit.samples, id).toBeGreaterThan(0);
    }
  });

  it('tell the same story as the feed: a stale or disconnected feed has an open incident, a running feed has none', async () => {
    const open = async (scenario: string) =>
      (await client({ scenario }).getSystemIncidents()).items
        .filter((i) => i.endedAt === null)
        .map((i) => i.kind);
    expect(await open('two-open')).toEqual([]);
    expect(await open('stale')).toEqual(['STALE']);
    expect(await open('disconnected')).toEqual(['DISCONNECT']);
    expect(await open('system-warning')).toEqual(['CLOCK_SKEW']);
    const nowMs = Date.parse('2026-10-23T12:00:00Z');
    const stale = await client({ scenario: 'stale', now: () => new Date(nowMs) }).getSystemHealth();
    expect([stale.ticksPerSecond, stale.feedAgeMs]).toEqual([0, 18_400]);
    expect(
      (await client({ scenario: 'disconnected' }).getSystemHealth()).ticksPerSecond,
    ).toBeNull();
  });

  it('show the warnings of the warning state, and none in the others', async () => {
    const warning = client({ scenario: 'system-warning' });
    expect((await warning.getSystemHealth()).telegram.lastError).toMatch(/502/);
    expect((await warning.getSystemStorage()).budgetPct).toBe(82);
    expect((await client().getSystemHealth()).telegram.lastError).toBeNull();
    expect((await client().getSystemStorage()).budgetPct).toBe(11);
  });

  it('send a test message, which moves the last Telegram send of the health to now', async () => {
    const nowMs = Date.parse('2026-10-23T12:00:00Z');
    const api = client({ now: () => new Date(nowMs) });
    const before = await api.getSystemHealth();
    expect(before.telegram.lastSendAt).toBe('2026-10-23T11:13:00.000Z');
    const { eventKey } = await api.sendTestNotification({ channel: 'telegram' });
    expect(eventKey).toMatch(
      /^test:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect((await api.getSystemHealth()).telegram.lastSendAt).toBe('2026-10-23T12:00:00.000Z');
    // every test has a key of its own
    expect((await api.sendTestNotification({ channel: 'telegram' })).eventKey).not.toBe(eventKey);
  });

  it('cannot send a test to Web Push before a device has subscribed (phase U6)', async () => {
    await expect(client().sendTestNotification({ channel: 'webpush' })).rejects.toMatchObject({
      status: 409,
      code: 'no_push_subscription',
    });
    await expect(client().sendTestNotification({ channel: 'sms' as never })).rejects.toThrow();
  });
});

describe('settings and strategies', () => {
  it('start with the defaults, and a change answers with all the settings', async () => {
    const api = client();
    expect((await api.getSettings()).locale).toBe('en');
    const next = await api.updateSettings({ locale: 'hinglish' });
    expect(next).toMatchObject({ locale: 'hinglish', displayTz: 'Asia/Kolkata' });
    expect(await api.getSettings()).toEqual(next);
  });

  it('are kept for the next page load, which uses the same storage', async () => {
    const storage = memoryStorage();
    const first = createMockClient({ storage, latencyMs: 0, scenario: 'two-open' });
    await first.updateSettings({
      displayTz: 'America/New_York',
      alerts: { telegram: { enabled: false } },
    });
    await first.updateStrategy('trend_pullback', { enabled: false });
    const second = createMockClient({ storage, latencyMs: 0, scenario: 'two-open' });
    expect(await second.getSettings()).toMatchObject({
      displayTz: 'America/New_York',
      alerts: { telegram: { enabled: false } },
    });
    expect((await second.getStrategies())[0]?.enabled).toBe(false);
    // another browser tab has its own storage and starts from the defaults
    expect((await client().getSettings()).displayTz).toBe('Asia/Kolkata');
  });

  it('refuse a patch that is empty, has an unknown field or a time zone that is not a name', async () => {
    const api = client();
    await expect(api.updateSettings({})).rejects.toThrow();
    await expect(api.updateSettings({ engine: { paused: true } } as never)).rejects.toThrow();
    await expect(api.updateSettings({ displayTz: '+05:30' })).rejects.toThrow();
    expect((await api.getSettings()).displayTz).toBe('Asia/Kolkata');
  });

  it('have one alert switch for a strategy, whether it is changed in the settings or on the strategy', async () => {
    const api = client();
    const alertsOf = async (key: string) =>
      (await api.getStrategies()).find((s) => s.key === key)?.alerts;
    expect(await alertsOf('trend_pullback')).toBe(true);
    await api.updateStrategy('trend_pullback', { alerts: false });
    expect((await api.getSettings()).strategyAlerts.trend_pullback).toBe('off');
    expect(await alertsOf('trend_pullback')).toBe(false);
    await api.updateSettings({ strategyAlerts: { trend_pullback: 'on', pattern_breakout: 'on' } });
    expect(await alertsOf('trend_pullback')).toBe(true);
    expect(await alertsOf('pattern_breakout')).toBe(true);
  });

  it('let the owner switch a strategy off and on without touching its alerts, and answer with the strategy', async () => {
    const api = client();
    const off = await api.updateStrategy('sweep_reversal', { enabled: false });
    expect([off.key, off.enabled, off.alerts]).toEqual(['sweep_reversal', false, true]);
    const on = await api.updateStrategy('sweep_reversal', { enabled: true });
    expect([on.enabled, on.alerts]).toEqual([true, true]);
    await expect(api.updateStrategy('sweep_reversal', {})).rejects.toThrow();
    await expect(
      api.updateStrategy('sweep_reversal', { status: 'VALIDATED' } as never),
    ).rejects.toThrow();
  });

  it('show for each strategy its version, status, newest signal and the evidence of that signal', async () => {
    const api = client({ scenario: 'wait' });
    const strategies = await api.getStrategies();
    const byKey = new Map(strategies.map((s) => [s.key, s]));
    expect(strategies.map((s) => [s.key, s.version, s.status])).toEqual([
      ['trend_pullback', '0.1.0', 'FORWARD_TESTING'],
      ['sweep_reversal', '0.1.0', 'FORWARD_TESTING'],
      ['squeeze_retest', '0.1.0', 'FORWARD_TESTING'],
      ['trendline_retest', '0.0.1', 'RESEARCH'],
      ['pattern_breakout', '0.0.1', 'RESEARCH'],
    ]);
    const rows = (await api.getSignals({ limit: 200 })).items;
    for (const key of ['trend_pullback', 'sweep_reversal', 'squeeze_retest'] as const) {
      const newest = rows
        .filter((row) => row.strategyKey === key)
        .map((row) => row.generatedAt)
        .sort()
        .at(-1);
      expect(byKey.get(key)?.lastSignalAt, key).toBe(newest);
      expect(byKey.get(key)?.evidence, key).not.toBeNull();
    }
    // the strategies that have not produced a signal have nothing to show
    expect([
      byKey.get('trendline_retest')?.lastSignalAt,
      byKey.get('trendline_retest')?.evidence,
    ]).toEqual([null, null]);
    expect(byKey.get('trend_pullback')?.evidence).toMatchObject({ scope: 'BACKTEST_OOS', n: 214 });
    expect(byKey.get('sweep_reversal')?.evidence).toMatchObject({
      scope: 'FORWARD',
      sampleLabel: 'INSUFFICIENT',
    });
  });

  it('show the config of a strategy, read only', async () => {
    const config = await client().getStrategyConfig('squeeze_retest');
    expect(config).toMatchObject({ key: 'squeeze_retest', version: '0.1.0' });
    expect(config.config).toHaveProperty('setup.squeezePercentile', 20);
  });
});

describe('security', () => {
  const owner = { username: MOCK_USERNAME, password: MOCK_PASSWORD };

  it('lists the three sessions of the owner after a login, and refuses to without one', async () => {
    const api = client();
    await expect(api.getSessions()).rejects.toMatchObject({ status: 401 });
    await api.login(owner);
    const { items } = await api.getSessions();
    expect(items.map((s) => [s.id, s.current])).toEqual([
      ['sess-current', true],
      ['sess-phone', false],
      ['sess-laptop', false],
    ]);
  });

  it('revokes another session, and a session that does not exist is not found', async () => {
    const api = client();
    await api.login(owner);
    await api.revokeSession('sess-phone');
    expect((await api.getSessions()).items.map((s) => s.id)).toEqual([
      'sess-current',
      'sess-laptop',
    ]);
    await expect(api.revokeSession('sess-phone')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    await expect(api.revokeSession('nobody')).rejects.toMatchObject({ status: 404 });
    // the revoked session stays revoked after a reload
    expect((await api.me())?.username).toBe(MOCK_USERNAME);
  });

  it('logs out when the session in use is revoked', async () => {
    const api = client();
    await api.login(owner);
    await api.revokeSession('sess-current');
    expect(await api.me()).toBeNull();
  });

  describe('the password', () => {
    it('is not changed when the current one is wrong (403), or the new one is shorter than 12 characters', async () => {
      const api = client();
      await expect(
        api.changePassword({ current: 'wrong', next: 'a-long-new-password' }),
      ).rejects.toMatchObject({ status: 403, code: 'wrong_password' });
      await expect(
        api.changePassword({ current: MOCK_PASSWORD, next: 'short-11-ch' }),
      ).rejects.toThrow();
      await api.login(owner);
    });

    it('is changed for the next login, revokes every other session and is shown on the login page of the preview', async () => {
      const storage = memoryStorage();
      const api = createMockClient({ storage, latencyMs: 0, scenario: 'two-open' });
      await api.login(owner);
      await api.changePassword({ current: MOCK_PASSWORD, next: 'a-long-new-password' });
      expect((await api.getSessions()).items.map((s) => s.id)).toEqual(['sess-current']);
      expect(api.preview?.password).toBe('a-long-new-password');
      await api.logout();
      await expect(api.login(owner)).rejects.toMatchObject({ status: 401 });
      await api.login({ ...owner, password: 'a-long-new-password' });
      expect((await api.me())?.username).toBe(MOCK_USERNAME);
      // a new page load with the same storage has the new password too
      const reloaded = createMockClient({ storage, latencyMs: 0 });
      await expect(reloaded.login(owner)).rejects.toMatchObject({ status: 401 });
    });
  });

  describe('the second step', () => {
    it('is off at first, and its setup gives a secret and a link for an authenticator app', async () => {
      const api = client();
      await api.login(owner);
      expect((await api.me())?.totpEnabled).toBe(false);
      const setup = await api.setupTotp();
      expect(setup.secret).toMatch(/^[A-Z2-7]{16,64}$/);
      expect(setup.otpauthUrl).toContain(`secret=${setup.secret}`);
      expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    });

    it('is not turned on by a wrong code, and a malformed code is refused', async () => {
      const api = client();
      await api.login(owner);
      await expect(api.enableTotp({ code: '000000' })).rejects.toMatchObject({
        status: 400,
        code: 'invalid_code',
      });
      await expect(api.enableTotp({ code: '12345' })).rejects.toThrow();
      expect((await api.me())?.totpEnabled).toBe(false);
    });

    it('is turned on by the right code, gives eight recovery codes and then needs the code at login', async () => {
      const api = client();
      await api.login(owner);
      const { recoveryCodes } = await api.enableTotp({ code: MOCK_TOTP_CODE });
      expect(recoveryCodes).toHaveLength(8);
      expect(new Set(recoveryCodes).size).toBe(8);
      expect((await api.me())?.totpEnabled).toBe(true);
      expect(api.preview?.totp).toBe(MOCK_TOTP_CODE);
      await expect(api.setupTotp()).rejects.toMatchObject({
        status: 409,
        code: 'totp_already_enabled',
      });
      await api.logout();
      await expect(api.login(owner)).rejects.toMatchObject({ status: 401 });
      await expect(api.login({ ...owner, totp: '000000' })).rejects.toMatchObject({ status: 401 });
      await api.login({ ...owner, totp: MOCK_TOTP_CODE });
      expect((await api.me())?.totpEnabled).toBe(true);
    });

    it('is turned off by the right code only', async () => {
      const api = client();
      await api.login(owner);
      await api.enableTotp({ code: MOCK_TOTP_CODE });
      await expect(api.disableTotp({ code: '111111' })).rejects.toMatchObject({
        code: 'invalid_code',
      });
      expect((await api.me())?.totpEnabled).toBe(true);
      await api.disableTotp({ code: MOCK_TOTP_CODE });
      expect((await api.me())?.totpEnabled).toBe(false);
      await api.logout();
      await api.login(owner);
    });
  });
});
