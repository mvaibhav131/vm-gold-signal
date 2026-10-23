import { STRATEGY_KEYS, type StrategyKey } from '@vmgs/core';
import {
  loginRequestSchema,
  marketSnapshotSchema,
  meResponseSchema,
  strategyInfoSchema,
  type LoginRequest,
  type MarketSnapshot,
  type MeResponse,
  type QuoteData,
  type StrategyInfo,
} from '@vmgs/contracts';

import { ApiError, type ApiClient } from '../api/client';

/** Credentials of the preview. They only exist in the mock; the live API never sees them. */
export const MOCK_USERNAME = 'owner';
export const MOCK_PASSWORD = 'preview';

const SESSION_KEY = 'vmgs-mock-session';
const SESSION_HOURS = 12;
const START_MID = 4017.285;

/** Strategies A, B and C alert by default; D and E stay in shadow mode until their backtest report. */
const ALERTS_ON: readonly StrategyKey[] = ['trend_pullback', 'sweep_reversal', 'squeeze_retest'];

/** Small deterministic generator: the preview shows the same prices on every run. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface MockClientOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  now?: () => Date;
  seed?: number;
  /** Delay of every call, to feel like a network. Tests pass 0. */
  latencyMs?: number;
  quoteIntervalMs?: number;
}

export function createMockClient(options: MockClientOptions = {}): ApiClient {
  const storage = options.storage ?? window.sessionStorage;
  const now = options.now ?? (() => new Date());
  const latencyMs = options.latencyMs ?? 120;
  const quoteIntervalMs = options.quoteIntervalMs ?? 1000;
  const random = seededRandom(options.seed ?? 20261023);

  let mid = START_MID;
  let lastQuote = nextQuote();

  function nextQuote(): QuoteData {
    mid = round3(Math.min(4060, Math.max(3980, mid + (random() - 0.5) * 0.6)));
    const spread = 0.15 + Math.round(random() * 10) / 100;
    const bid = round3(mid - spread / 2);
    const ask = round3(bid + spread);
    return {
      bid,
      ask,
      spread: round3(ask - bid),
      ageMs: 300 + Math.floor(random() * 400),
      feedState: 'LIVE',
    };
  }

  function wait(): Promise<void> {
    return latencyMs === 0
      ? Promise.resolve()
      : new Promise((resolve) => {
          setTimeout(resolve, latencyMs);
        });
  }

  return {
    kind: 'mock',
    preview: { username: MOCK_USERNAME, password: MOCK_PASSWORD },

    async login(request: LoginRequest) {
      await wait();
      const parsed = loginRequestSchema.safeParse(request);
      // One answer for every failure, as the real API gives (04_API_and_Notifications section 2).
      if (
        !parsed.success ||
        parsed.data.username !== MOCK_USERNAME ||
        parsed.data.password !== MOCK_PASSWORD
      ) {
        throw new ApiError(401, 'invalid_credentials', 'Login failed.');
      }
      const expiresAt = new Date(now().getTime() + SESSION_HOURS * 3_600_000).toISOString();
      storage.setItem(SESSION_KEY, expiresAt);
    },

    async logout() {
      await wait();
      storage.removeItem(SESSION_KEY);
    },

    async me(): Promise<MeResponse | null> {
      await wait();
      const expiresAt = storage.getItem(SESSION_KEY);
      if (expiresAt === null || Date.parse(expiresAt) <= now().getTime()) {
        storage.removeItem(SESSION_KEY);
        return null;
      }
      return meResponseSchema.parse({
        username: MOCK_USERNAME,
        totpEnabled: false,
        sessionExpiresAt: expiresAt,
      });
    },

    async getSnapshot(): Promise<MarketSnapshot> {
      await wait();
      const at = now().toISOString();
      return marketSnapshotSchema.parse({
        symbol: 'XAUUSD',
        bid: lastQuote.bid,
        ask: lastQuote.ask,
        mid: round3((lastQuote.bid + lastQuote.ask) / 2),
        spread: lastQuote.spread,
        sourceAt: at,
        receivedAt: at,
        ageMs: lastQuote.ageMs,
        feedState: 'LIVE',
        session: 'LONDON',
        regime: 'TREND_UP',
        mode: 'SIMULATED',
        engine: {
          status: 'RUNNING',
          openCount: 0,
          openRiskR: 0,
          warmup: { ready: true, progressPct: 100 },
          waitReasons: [{ code: 'NO_SETUP', label: 'No setup right now' }],
          evaluatedAt: at,
        },
      });
    },

    async getStrategies(): Promise<StrategyInfo[]> {
      await wait();
      return STRATEGY_KEYS.map((key) =>
        strategyInfoSchema.parse({
          key,
          version: '0.1.0',
          status: 'FORWARD_TESTING',
          enabled: true,
          alerts: ALERTS_ON.includes(key),
          lastSignalAt: null,
          evidence: null,
        }),
      );
    },

    subscribeQuotes(listener) {
      listener(lastQuote);
      const timer = setInterval(() => {
        lastQuote = nextQuote();
        listener(lastQuote);
      }, quoteIntervalMs);
      return () => {
        clearInterval(timer);
      };
    },
  };
}
