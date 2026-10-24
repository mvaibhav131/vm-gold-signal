import { STRATEGY_KEYS, sessionAt, type StatsScope, type StrategyKey } from '@vmgs/core';
import {
  breakdownQuerySchema,
  calibrationQuerySchema,
  candlesQuerySchema,
  candlesResponseSchema,
  equityQuerySchema,
  failuresQuerySchema,
  groupEffectivenessQuerySchema,
  headlinesQuerySchema,
  loginRequestSchema,
  marketMovesQuerySchema,
  marketSnapshotSchema,
  meResponseSchema,
  monthlyQuerySchema,
  newsEventsQuerySchema,
  notificationTestRequestSchema,
  notificationTestResponseSchema,
  openSignalsResponseSchema,
  overviewQuerySchema,
  passwordChangeRequestSchema,
  settingsPatchSchema,
  strategyInfoSchema,
  strategyPatchSchema,
  totpCodeRequestSchema,
  totpEnableResponseSchema,
  totpSetupResponseSchema,
  type BreakdownQuery,
  type BreakdownResponse,
  type CalibrationQuery,
  type CalibrationResponse,
  type CandlesQuery,
  type CandlesResponse,
  type DriftResponse,
  type EquityQuery,
  type EquityResponse,
  type FailuresQuery,
  type FailuresResponse,
  type FeatureSnapshotResponse,
  type GroupEffectivenessQuery,
  type GroupEffectivenessResponse,
  type HeadlinesQuery,
  type HeadlinesResponse,
  type LoginRequest,
  type MarketMovesQuery,
  type MarketMovesResponse,
  type MarketSnapshot,
  type MeResponse,
  type MonthlyQuery,
  type MonthlyResponse,
  type NewsEventsQuery,
  type NewsEventsResponse,
  type NewsImpactResponse,
  type NewsStateResponse,
  type NotificationTestRequest,
  type NotificationTestResponse,
  type OpenSignalsResponse,
  type OverviewQuery,
  type OverviewResponse,
  type PasswordChangeRequest,
  type QuoteData,
  type SessionsResponse,
  type Settings,
  type SettingsPatch,
  type SignalDetail,
  type SignalHistoryPage,
  type SignalHistoryQuery,
  type SseEvent,
  type StrategyConfigResponse,
  type StrategyInfo,
  type StrategyPatch,
  type SystemHealth,
  type SystemIncidentsResponse,
  type SystemLatency,
  type SystemStorage,
  type TotpCodeRequest,
  type TotpEnableResponse,
  type TotpSetupResponse,
} from '@vmgs/contracts';

import { ApiError, type ApiClient } from '../api/client';
import { midOf } from '../format/format';
import {
  breakdownOf,
  calibrationOf,
  driftOf,
  equityOf,
  failuresOf,
  forwardRecordsOf,
  groupEffectivenessOf,
  inRange,
  monthlyOf,
  newsImpactOf,
  type AnalyticsRecord,
} from './analytics';
import { buildBacktest } from './backtest';
import { headlinesAt, marketMovesAt, newsEventsAt, newsStateAt } from './news';
import { allRows, detailOfOpen, overviewFor, queryHistory, summarize } from './history';
import {
  CURRENT_SESSION_ID,
  applySettingsPatch,
  loadPreferences,
  savePreferences,
  sessionsAt,
  type Preferences,
} from './preferences';
import { SCENARIOS, scenarioById, type Scenario } from './scenarios';
import { buildSimSignal, currentPrice, unrealisedR, type SimSignal } from './signals';
import {
  healthAt,
  incidentsAt,
  latencyAt,
  storageAt,
  strategyConfigFor,
  strategyStatusOf,
  strategyVersion,
  type SystemInput,
} from './system';
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
/** The code of the second step in the preview, once the owner has turned it on. */
export const MOCK_TOTP_CODE = '123456';
const MOCK_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const MOCK_RECOVERY_CODES = [
  'k7m2-q9x4',
  'p3d8-v6n1',
  'h5t2-z8c7',
  'w4r9-b2j6',
  'f8y3-m5s1',
  'c6g7-t4e9',
  'n2a5-x7u3',
  'd9l4-r8k2',
];

const SESSION_KEY = 'vmgs-mock-session';
const SCENARIO_KEY = 'vmgs-mock-scenario';
const SESSION_HOURS = 12;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

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
  // The owner's choices on the System screen survive a reload of the page (they are saved in the storage).
  let prefs: Preferences = loadPreferences(storage, MOCK_PASSWORD);
  let testSentAtMs: number | null = null;

  function setPrefs(next: Preferences): void {
    prefs = next;
    savePreferences(storage, prefs);
  }

  function systemInput(): SystemInput {
    return {
      nowMs: now().getTime(),
      feedState: lastQuote.feedState,
      feedAgeMs: lastQuote.ageMs,
      warning: scenario.systemWarning === true,
      testSentAtMs,
    };
  }

  /** A strategy as the list shows it: the owner's switches, the newest signal and its evidence. */
  function strategyInfo(key: StrategyKey): StrategyInfo {
    const newest = [...open.map((sim) => sim.signal), ...allTrades().map((trade) => trade.signal)]
      .filter((signal) => signal.strategyKey === key)
      .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt))[0];
    return strategyInfoSchema.parse({
      key,
      version: strategyVersion(key),
      status: strategyStatusOf(key),
      enabled: prefs.enabled[key],
      alerts: prefs.settings.strategyAlerts[key] === 'on',
      lastSignalAt: newest?.generatedAt ?? null,
      evidence: newest?.evidence ?? null,
    });
  }

  /** The session of this browser: its expiry, or null when there is none (the real API answers 401). */
  function sessionExpiry(): string {
    const expiresAt = storage.getItem(SESSION_KEY);
    if (expiresAt === null || Date.parse(expiresAt) <= now().getTime()) {
      throw new ApiError(401, 'unauthenticated', 'There is no valid session.');
    }
    return expiresAt;
  }

  /** A made-up id for a test message: `test:` and a uuid. */
  function testEventKey(): string {
    const hex = (length: number) =>
      Array.from({ length }, () => Math.floor(random() * 16).toString(16)).join('');
    return `test:${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
  }

  function allTrades(): readonly Trade[] {
    return freshLoss ? [...trades, freshLoss] : trades;
  }

  // The backtest does not depend on the preview state: it is built once, when first asked for.
  let backtest: AnalyticsRecord[] | null = null;
  function backtestRecords(): readonly AnalyticsRecord[] {
    backtest ??= buildBacktest(trades[0]?.generatedMs ?? activatedAt);
    return backtest;
  }

  /** The results of one scope, of one strategy if given. */
  function recordsOf(scope: StatsScope, strategy?: StrategyKey): readonly AnalyticsRecord[] {
    const all =
      scope === 'FORWARD'
        ? forwardRecordsOf(open, allTrades(), now().getTime())
        : backtestRecords();
    return strategy === undefined ? all : all.filter(({ row }) => row.strategyKey === strategy);
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
    get preview() {
      return { username: MOCK_USERNAME, password: prefs.password, totp: MOCK_TOTP_CODE };
    },
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
        parsed.data.password !== prefs.password ||
        (prefs.totpEnabled && parsed.data.totp !== MOCK_TOTP_CODE)
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
        totpEnabled: prefs.totpEnabled,
        sessionExpiresAt: expiresAt,
      });
    },

    async getSettings(): Promise<Settings> {
      await wait();
      return prefs.settings;
    },

    async updateSettings(patch: SettingsPatch): Promise<Settings> {
      await wait();
      setPrefs({
        ...prefs,
        settings: applySettingsPatch(prefs.settings, settingsPatchSchema.parse(patch)),
      });
      return prefs.settings;
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
      return STRATEGY_KEYS.map(strategyInfo);
    },

    async getStrategyConfig(key: StrategyKey): Promise<StrategyConfigResponse> {
      await wait();
      return strategyConfigFor(key);
    },

    async updateStrategy(key: StrategyKey, patch: StrategyPatch): Promise<StrategyInfo> {
      await wait();
      const parsed = strategyPatchSchema.parse(patch);
      // The alert switch of a strategy is `strategyAlerts.<key>` of the settings: one switch, two ways to reach it.
      setPrefs({
        ...prefs,
        enabled: {
          ...prefs.enabled,
          ...(parsed.enabled === undefined ? {} : { [key]: parsed.enabled }),
        },
        settings:
          parsed.alerts === undefined
            ? prefs.settings
            : applySettingsPatch(prefs.settings, {
                strategyAlerts: { [key]: parsed.alerts ? 'on' : 'off' },
              }),
      });
      return strategyInfo(key);
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
      // The dashboard counters (today, this month) are fixed numbers, see `overviewFor`.
      const dashboardCounters =
        parsed.scope === 'FORWARD' &&
        parsed.strategy === undefined &&
        parsed.from !== undefined &&
        parsed.to !== undefined;
      if (dashboardCounters) {
        const days = (Date.parse(parsed.to ?? '') - Date.parse(parsed.from ?? '')) / DAY_MS;
        return overviewFor(days, open.length);
      }
      const rows = inRange(recordsOf(parsed.scope, parsed.strategy), parsed).map(({ row }) => row);
      return summarize(rows);
    },

    async getMonthly(query: MonthlyQuery): Promise<MonthlyResponse> {
      await wait();
      const parsed = monthlyQuerySchema.parse(query);
      return monthlyOf(recordsOf(parsed.scope, parsed.strategy), parsed.months);
    },

    async getBreakdown(query: BreakdownQuery): Promise<BreakdownResponse> {
      await wait();
      const parsed = breakdownQuerySchema.parse(query);
      return breakdownOf(recordsOf(parsed.scope, parsed.strategy), parsed.by, parsed);
    },

    async getFailures(query: FailuresQuery): Promise<FailuresResponse> {
      await wait();
      const parsed = failuresQuerySchema.parse(query);
      return failuresOf(recordsOf(parsed.scope), parsed);
    },

    async getGroupEffectiveness(
      query: GroupEffectivenessQuery,
    ): Promise<GroupEffectivenessResponse> {
      await wait();
      const parsed = groupEffectivenessQuerySchema.parse(query);
      return groupEffectivenessOf(recordsOf(parsed.scope), parsed.strategy);
    },

    async getCalibration(query: CalibrationQuery): Promise<CalibrationResponse> {
      await wait();
      const parsed = calibrationQuerySchema.parse(query);
      return calibrationOf(recordsOf(parsed.scope));
    },

    async getEquity(query: EquityQuery): Promise<EquityResponse> {
      await wait();
      const parsed = equityQuerySchema.parse(query);
      return equityOf(recordsOf(parsed.scope), parsed);
    },

    async getDrift(): Promise<DriftResponse> {
      await wait();
      // The evidence of a strategy is its backtest interval, as on its signals.
      const evidence = Object.fromEntries(
        breakdownOf(backtestRecords(), 'strategy').items.map((item) => [item.key, item.ci95]),
      );
      return driftOf(recordsOf('FORWARD'), evidence);
    },

    async getNewsImpact(): Promise<NewsImpactResponse> {
      await wait();
      return newsImpactOf();
    },

    async getNewsState(): Promise<NewsStateResponse> {
      await wait();
      return newsStateAt(scenario.news, now().getTime());
    },

    async getNewsEvents(query: NewsEventsQuery): Promise<NewsEventsResponse> {
      await wait();
      return newsEventsAt(scenario.news, now().getTime(), newsEventsQuerySchema.parse(query));
    },

    async getHeadlines(query: HeadlinesQuery): Promise<HeadlinesResponse> {
      await wait();
      const parsed = headlinesQuerySchema.parse(query);
      return headlinesAt(now().getTime(), parsed, scenario.news);
    },

    async getMarketMoves(query: MarketMovesQuery): Promise<MarketMovesResponse> {
      await wait();
      return marketMovesAt(now().getTime(), marketMovesQuerySchema.parse(query));
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

    async getSystemHealth(): Promise<SystemHealth> {
      await wait();
      return healthAt(systemInput());
    },

    async getSystemIncidents(): Promise<SystemIncidentsResponse> {
      await wait();
      return incidentsAt(systemInput());
    },

    async getSystemStorage(): Promise<SystemStorage> {
      await wait();
      return storageAt(now().getTime(), scenario.systemWarning === true);
    },

    async getSystemLatency(): Promise<SystemLatency> {
      await wait();
      return latencyAt(scenario.systemWarning === true);
    },

    async sendTestNotification(
      request: NotificationTestRequest,
    ): Promise<NotificationTestResponse> {
      await wait();
      const parsed = notificationTestRequestSchema.parse(request);
      if (parsed.channel === 'webpush') {
        throw new ApiError(409, 'no_push_subscription', 'No device is subscribed to Web Push yet.');
      }
      testSentAtMs = now().getTime();
      return notificationTestResponseSchema.parse({ eventKey: testEventKey() });
    },

    async changePassword(request: PasswordChangeRequest): Promise<void> {
      await wait();
      const parsed = passwordChangeRequestSchema.parse(request);
      if (parsed.current !== prefs.password) {
        throw new ApiError(403, 'wrong_password', 'The current password is not right.');
      }
      // The real API revokes every other session when the password changes.
      setPrefs({
        ...prefs,
        password: parsed.next,
        revokedSessions: ['sess-phone', 'sess-laptop'],
      });
    },

    async setupTotp(): Promise<TotpSetupResponse> {
      await wait();
      if (prefs.totpEnabled) {
        throw new ApiError(409, 'totp_already_enabled', 'The second step is already on.');
      }
      return totpSetupResponseSchema.parse({
        secret: MOCK_TOTP_SECRET,
        otpauthUrl: `otpauth://totp/VM%20Gold%20Signal:${MOCK_USERNAME}?secret=${MOCK_TOTP_SECRET}&issuer=VM%20Gold%20Signal`,
      });
    },

    async enableTotp(request: TotpCodeRequest): Promise<TotpEnableResponse> {
      await wait();
      const parsed = totpCodeRequestSchema.parse(request);
      if (parsed.code !== MOCK_TOTP_CODE) {
        throw new ApiError(400, 'invalid_code', 'This code is not right.');
      }
      setPrefs({ ...prefs, totpEnabled: true });
      return totpEnableResponseSchema.parse({ recoveryCodes: MOCK_RECOVERY_CODES });
    },

    async disableTotp(request: TotpCodeRequest): Promise<void> {
      await wait();
      const parsed = totpCodeRequestSchema.parse(request);
      if (parsed.code !== MOCK_TOTP_CODE) {
        throw new ApiError(400, 'invalid_code', 'This code is not right.');
      }
      setPrefs({ ...prefs, totpEnabled: false });
    },

    async getSessions(): Promise<SessionsResponse> {
      await wait();
      return sessionsAt(now().getTime(), sessionExpiry(), prefs.revokedSessions);
    },

    async revokeSession(id: string): Promise<void> {
      await wait();
      const sessions = sessionsAt(now().getTime(), sessionExpiry(), prefs.revokedSessions);
      if (!sessions.items.some((session) => session.id === id)) {
        throw new ApiError(404, 'not_found', 'There is no session with this id.');
      }
      // Revoking the session you are using is a logout.
      if (id === CURRENT_SESSION_ID) storage.removeItem(SESSION_KEY);
      else setPrefs({ ...prefs, revokedSessions: [...prefs.revokedSessions, id] });
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
