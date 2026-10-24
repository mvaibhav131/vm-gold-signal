import { STRATEGY_KEYS, sessionAt, type StrategyKey } from '@vmgs/core';
import {
  candlesQuerySchema,
  candlesResponseSchema,
  headlinesQuerySchema,
  loginRequestSchema,
  marketSnapshotSchema,
  meResponseSchema,
  openSignalsResponseSchema,
  overviewQuerySchema,
  settingsSchema,
  strategyInfoSchema,
  type CandlesQuery,
  type CandlesResponse,
  type FeatureSnapshotResponse,
  type HeadlinesQuery,
  type HeadlinesResponse,
  type LoginRequest,
  type MarketSnapshot,
  type MeResponse,
  type NewsStateResponse,
  type OpenSignalsResponse,
  type OverviewQuery,
  type OverviewResponse,
  type QuoteData,
  type Settings,
  type SignalDetail,
  type SignalHistoryPage,
  type SignalHistoryQuery,
  type SseEvent,
  type StrategyInfo,
} from '@vmgs/contracts';

import { ApiError, type ApiClient } from '../api/client';
import { midOf } from '../format/format';
import { headlinesAt, newsStateAt } from './news';
import { allRows, detailOfOpen, overviewFor, queryHistory } from './history';
import { SCENARIOS, scenarioById, type Scenario } from './scenarios';
import { buildSimSignal, currentPrice, unrealisedR, type SimSignal } from './signals';
import {
  buildFreshLoss,
  buildTrades,
  detailOfTrade,
  snapshotOfSignal,
  tradeCandles,
  tradeForWindow,
  type Trade,
} from './trades';
import { candlesResponse, priceAt, round3 } from './world';

/** Credentials of the preview. They only exist in the mock; the live API never sees them. */
export const MOCK_USERNAME = 'owner';
export const MOCK_PASSWORD = 'preview';

const SESSION_KEY = 'vmgs-mock-session';
const SCENARIO_KEY = 'vmgs-mock-scenario';
const SESSION_HOURS = 12;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Strategies A, B and C alert by default; D and E stay in shadow mode until their backtest report. */
const ALERTS_ON: readonly StrategyKey[] = ['trend_pullback', 'sweep_reversal', 'squeeze_retest'];

/** Small deterministic generator: the preview shows the same numbers on every run. */
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

export interface MockClientOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  now?: () => Date;
  seed?: number;
  /** Delay of every call, to feel like a network. Tests pass 0. */
  latencyMs?: number;
  quoteIntervalMs?: number;
  /** The real stream sends `signal_update` at most once per 5 s per open signal. */
  signalUpdateIntervalMs?: number;
  /** The state to start in. Defaults to `?scenario=` of the address bar, then the one the owner picked last. */
  scenario?: string;
}

interface PauseState {
  since: number;
  until: number | null;
}

function defaultSettings(): Settings {
  return settingsSchema.parse({
    displayTz: 'Asia/Kolkata',
    locale: 'en',
    alerts: {
      telegram: {
        enabled: true,
        minGrade: 'Moderate',
        kinds: ['SIGNAL_NEW', 'SIGNAL_TP1', 'SIGNAL_CLOSED', 'SIGNAL_CANCELLED', 'SYSTEM_DEGRADED'],
      },
      webpush: { enabled: false, minGrade: 'Strong' },
    },
    advisoryGates: { newsWindow: 'warn', rollover: 'warn', offHours: 'warn', nearLevel: 'warn' },
    strategyAlerts: Object.fromEntries(
      STRATEGY_KEYS.map((key) => [key, ALERTS_ON.includes(key) ? 'on' : 'off']),
    ),
    newsAlerts: {
      minImpact: 'HIGH',
      topics: {
        FED_RATES: 'on',
        USD_DOLLAR: 'on',
        INFLATION_JOBS: 'on',
        GEOPOLITICS_WAR: 'on',
        TRUMP_POLICY: 'on',
        CENTRAL_BANK_GOLD: 'on',
        GOLD_DIRECT: 'on',
        RISK_OFF: 'on',
      },
      marketMoves: 'on',
    },
  });
}

function startingScenario(
  options: MockClientOptions,
  storage: MockClientOptions['storage'],
): string {
  if (options.scenario) return scenarioById(options.scenario).id;
  const fromUrl =
    typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get('scenario');
  if (fromUrl) return scenarioById(fromUrl).id;
  return scenarioById(storage?.getItem(SCENARIO_KEY)).id;
}

export function createMockClient(options: MockClientOptions = {}): ApiClient {
  const storage = options.storage ?? window.sessionStorage;
  const now = options.now ?? (() => new Date());
  const latencyMs = options.latencyMs ?? 120;
  const quoteIntervalMs = options.quoteIntervalMs ?? 1000;
  const updateIntervalMs = options.signalUpdateIntervalMs ?? 5000;
  const random = seededRandom(options.seed ?? 20261023);
  const listeners = new Set<(event: SseEvent) => void>();

  let scenario: Scenario = scenarioById(startingScenario(options, storage));
  let activatedAt = now().getTime();
  let open: SimSignal[] = [];
  // The finished signals are fixed for the life of the client; a preview state can add one more.
  const trades: Trade[] = buildTrades(activatedAt);
  let freshLoss: Trade | null = null;
  let pause: PauseState | null = null;
  let frozen: QuoteData | null = null;
  let lastQuote: QuoteData;

  function allTrades(): readonly Trade[] {
    return freshLoss ? [...trades, freshLoss] : trades;
  }

  function activate(next: Scenario): void {
    scenario = next;
    activatedAt = now().getTime();
    open = next.signals.map((key) => buildSimSignal(key, activatedAt));
    freshLoss = next.freshLoss ? buildFreshLoss(activatedAt) : null;
    pause = next.paused ? { since: activatedAt - 12 * MINUTE_MS, until: null } : null;
    // A stale, disconnected or closed feed keeps the last tick it saw; only its age grows.
    frozen = null;
    frozen = nextQuote();
    lastQuote = feedIsMoving() ? frozen : nextQuote();
  }

  /** The feed is alive: quotes follow the simulated price. Otherwise the last tick stays and its age grows. */
  function feedIsMoving(): boolean {
    return scenario.tickAgeMs === null;
  }

  function nextQuote(): QuoteData {
    const at = now().getTime();
    if (!feedIsMoving() && frozen) {
      return { ...frozen, ageMs: (scenario.tickAgeMs ?? 0) + (at - activatedAt) };
    }
    const mid = round3(priceAt(at) + (random() - 0.5) * 0.2);
    const spread = 0.15 + Math.round(random() * 10) / 100;
    const bid = round3(mid - spread / 2);
    const ask = round3(bid + spread);
    return {
      bid,
      ask,
      spread: round3(ask - bid),
      ageMs: 300 + Math.floor(random() * 400),
      feedState: scenario.feedState,
    };
  }

  function emit(event: SseEvent): void {
    for (const listener of listeners) listener(event);
  }

  function engineSnapshot(): MarketSnapshot['engine'] {
    const at = now();
    if (pause?.until != null && at.getTime() >= pause.until) pause = null;
    const paused = pause !== null;
    return {
      status: paused ? 'PAUSED' : 'RUNNING',
      ...(pause ? { pausedSince: new Date(pause.since).toISOString() } : {}),
      openCount: open.length,
      // Every simulated signal risks 1R.
      openRiskR: open.length,
      warmup: { ...scenario.warmup, missingTimeframes: [...scenario.warmup.missingTimeframes] },
      waitReasons: paused
        ? [{ code: 'PAUSED', label: 'Paused by you: no new signals until you resume' }]
        : scenario.waitReasons.map((reason) => ({ ...reason })),
      evaluatedAt: at.toISOString(),
    };
  }

  function emitEngine(): void {
    const engine = engineSnapshot();
    emit({
      event: 'engine',
      data: {
        status: engine.status,
        waitReasons: engine.waitReasons,
        regime: scenario.regime,
        session: sessionAt(now().getTime()),
      },
    });
  }

  function track(sim: SimSignal): void {
    const r = unrealisedR(sim.signal, lastQuote);
    sim.mfeR = Math.max(sim.mfeR, r);
    sim.maeR = Math.min(sim.maeR, r);
  }

  function wait(): Promise<void> {
    return latencyMs === 0
      ? Promise.resolve()
      : new Promise((resolve) => {
          setTimeout(resolve, latencyMs);
        });
  }

  activate(scenario);

  return {
    kind: 'mock',
    preview: { username: MOCK_USERNAME, password: MOCK_PASSWORD },
    scenarios: {
      scenarios: SCENARIOS.map(({ id, label }) => ({ id, label })),
      current: () => scenario.id,
      set(id) {
        activate(scenarioById(id));
        storage.setItem(SCENARIO_KEY, scenario.id);
        // The real API sends `resync` when the client must reload its state over REST.
        emit({ event: 'resync', data: {} });
      },
    },

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

    async getSettings(): Promise<Settings> {
      await wait();
      return defaultSettings();
    },

    async getSnapshot(): Promise<MarketSnapshot> {
      await wait();
      const at = now().getTime();
      const sourceMs = at - lastQuote.ageMs;
      return marketSnapshotSchema.parse({
        symbol: 'XAUUSD',
        bid: lastQuote.bid,
        ask: lastQuote.ask,
        mid: midOf(lastQuote.bid, lastQuote.ask),
        spread: lastQuote.spread,
        sourceAt: new Date(sourceMs).toISOString(),
        receivedAt: new Date(sourceMs + 250).toISOString(),
        ageMs: lastQuote.ageMs,
        feedState: lastQuote.feedState,
        session: sessionAt(at),
        regime: scenario.regime,
        mode: 'SIMULATED',
        engine: engineSnapshot(),
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

    async getCandles(query: CandlesQuery): Promise<CandlesResponse> {
      await wait();
      const parsed = candlesQuerySchema.parse(query);
      const nowMs = now().getTime();
      const beforeMs = parsed.before === undefined ? null : Date.parse(parsed.before);
      // The chart of a finished trade asks for the candles around it (`before` its end).
      const trade = beforeMs === null ? undefined : tradeForWindow(allTrades(), beforeMs);
      if (trade && beforeMs !== null) {
        const candles = tradeCandles(trade, nowMs)
          .filter((candle) => Date.parse(candle.t) < beforeMs)
          .slice(-parsed.limit);
        return candlesResponseSchema.parse({
          candles,
          overlays: {},
          levels: [],
          objects: trade.signal.chartObjects,
        });
      }
      return candlesResponseSchema.parse(
        candlesResponse(
          {
            tf: parsed.tf,
            limit: parsed.limit,
            overlays: parsed.overlays,
            objects: parsed.objects,
          },
          beforeMs ?? nowMs,
        ),
      );
    },

    async getOpenSignals(): Promise<OpenSignalsResponse> {
      await wait();
      const at = now().getTime();
      return openSignalsResponseSchema.parse({
        items: [...open]
          .sort((a, b) => b.signal.seq - a.signal.seq)
          .map((sim) => ({
            signal: sim.signal,
            live: {
              status: sim.status,
              currentPrice: currentPrice(sim.signal, lastQuote),
              unrealisedR: unrealisedR(sim.signal, lastQuote),
              mfeR: Math.round(sim.mfeR * 100) / 100,
              maeR: Math.round(sim.maeR * 100) / 100,
              stopLossCurrent: sim.stop,
              timeToTimeStopS: Math.max(
                0,
                Math.round((Date.parse(sim.signal.timeStopAt) - at) / 1000),
              ),
            },
          })),
        openCount: open.length,
        openRiskR: open.length,
      });
    },

    async getSignals(query: SignalHistoryQuery): Promise<SignalHistoryPage> {
      await wait();
      return queryHistory(allRows(open, allTrades(), now().getTime()), query);
    },

    async getSignalDetail(id: string): Promise<SignalDetail> {
      await wait();
      const at = now().getTime();
      const sim = open.find((candidate) => candidate.signal.id === id);
      if (sim) return detailOfOpen(sim, at);
      const trade = allTrades().find((candidate) => candidate.signal.id === id);
      if (trade) return detailOfTrade(trade, at);
      throw new ApiError(404, 'not_found', 'There is no signal with this id.');
    },

    async getSignalSnapshot(id: string): Promise<FeatureSnapshotResponse> {
      await wait();
      const sim = open.find((candidate) => candidate.signal.id === id);
      const trade = allTrades().find((candidate) => candidate.signal.id === id);
      const signal = sim?.signal ?? trade?.signal;
      if (!signal) throw new ApiError(404, 'not_found', 'There is no signal with this id.');
      const snapshot = snapshotOfSignal(signal, trade?.snapshotPruned ?? false);
      if (!snapshot) {
        throw new ApiError(404, 'snapshot_pruned', 'The snapshot was removed by retention.');
      }
      return snapshot;
    },

    async getOverview(query: OverviewQuery): Promise<OverviewResponse> {
      await wait();
      const parsed = overviewQuerySchema.parse(query);
      const days =
        parsed.from !== undefined && parsed.to !== undefined
          ? (Date.parse(parsed.to) - Date.parse(parsed.from)) / DAY_MS
          : 30;
      return overviewFor(days, open.length);
    },

    async getNewsState(): Promise<NewsStateResponse> {
      await wait();
      return newsStateAt(scenario.news, now().getTime());
    },

    async getHeadlines(query: HeadlinesQuery): Promise<HeadlinesResponse> {
      await wait();
      const parsed = headlinesQuerySchema.parse(query);
      return headlinesAt(now().getTime(), parsed.limit);
    },

    async pauseEngine(request) {
      await wait();
      const at = now().getTime();
      pause = {
        since: at,
        until: request.minutes === undefined ? null : at + request.minutes * MINUTE_MS,
      };
      emitEngine();
    },

    async resumeEngine() {
      await wait();
      pause = null;
      emitEngine();
    },

    subscribe(listener) {
      listeners.add(listener);
      listener({ event: 'quote', data: lastQuote });
      // Each subscriber gets its own quote and update timers; only state changes are broadcast.
      const quoteTimer = setInterval(() => {
        lastQuote = nextQuote();
        listener({ event: 'quote', data: lastQuote });
      }, quoteIntervalMs);
      const updateTimer = setInterval(() => {
        if (!feedIsMoving()) return;
        for (const sim of open) {
          track(sim);
          listener({
            event: 'signal_update',
            data: {
              id: sim.signal.id,
              status: sim.status,
              unrealisedR: unrealisedR(sim.signal, lastQuote),
              stop: sim.stop,
            },
          });
        }
      }, updateIntervalMs);
      return () => {
        listeners.delete(listener);
        clearInterval(quoteTimer);
        clearInterval(updateTimer);
      };
    },
  };
}
