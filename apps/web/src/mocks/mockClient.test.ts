import { STRATEGY_KEYS } from '@vmgs/core';
import { sseEventSchema } from '@vmgs/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import { MOCK_PASSWORD, MOCK_USERNAME, createMockClient, seededRandom } from './mockClient';

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
});

describe('mock quote stream', () => {
  it('sends a quote at once and then one per interval, all valid SSE quote events', () => {
    vi.useFakeTimers();
    const api = client();
    const quotes: unknown[] = [];
    const stop = api.subscribeQuotes((q) => quotes.push(q));
    expect(quotes).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    expect(quotes).toHaveLength(4);
    for (const data of quotes) {
      expect(sseEventSchema.safeParse({ event: 'quote', data }).success).toBe(true);
    }
    stop();
  });

  it('stops after unsubscribe', () => {
    vi.useFakeTimers();
    const api = client();
    const quotes: unknown[] = [];
    const stop = api.subscribeQuotes((q) => quotes.push(q));
    stop();
    vi.advanceTimersByTime(5000);
    expect(quotes).toHaveLength(1);
  });

  it('is deterministic for a seed and keeps ask at or above bid', () => {
    vi.useFakeTimers();
    const run = () => {
      const quotes: { bid: number; ask: number }[] = [];
      const stop = client({ seed: 42 }).subscribeQuotes((q) => quotes.push(q));
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
