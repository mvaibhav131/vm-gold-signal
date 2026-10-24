import type {
  BreakdownQuery,
  BreakdownResponse,
  CalibrationQuery,
  CalibrationResponse,
  CandlesQuery,
  CandlesResponse,
  DriftResponse,
  EquityQuery,
  EquityResponse,
  FailuresQuery,
  FailuresResponse,
  FeatureSnapshotResponse,
  GroupEffectivenessQuery,
  GroupEffectivenessResponse,
  HeadlinesQuery,
  HeadlinesResponse,
  LoginRequest,
  MarketMovesQuery,
  MarketMovesResponse,
  MarketSnapshot,
  MeResponse,
  MonthlyQuery,
  MonthlyResponse,
  NewsEventsQuery,
  NewsEventsResponse,
  NewsImpactResponse,
  NewsStateResponse,
  NotificationTestRequest,
  NotificationTestResponse,
  OpenSignalsResponse,
  OverviewQuery,
  OverviewResponse,
  PasswordChangeRequest,
  SessionsResponse,
  Settings,
  SettingsPatch,
  SignalDetail,
  SignalHistoryPage,
  SignalHistoryQuery,
  SseEvent,
  StrategyConfigResponse,
  StrategyInfo,
  StrategyPatch,
  SystemHealth,
  SystemIncidentsResponse,
  SystemLatency,
  SystemStorage,
  TotpCodeRequest,
  TotpEnableResponse,
  TotpSetupResponse,
} from '@vmgs/contracts';
import type { StrategyKey } from '@vmgs/core';

/** A failed API call. `code` is the stable machine value of the problem+json answer. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** One state of the simulated market the owner can switch to in the preview. */
export interface PreviewScenario {
  readonly id: string;
  readonly label: string;
}

/** Only the mock has these: they let the owner (and the e2e tests) look at every dashboard state. */
export interface PreviewControls {
  readonly scenarios: readonly PreviewScenario[];
  current(): string;
  set(id: string): void;
}

/**
 * Everything the screens need from the backend. Screens only talk to this interface, so the mock
 * implementation of phases U0 to U4 can be replaced by the live API and SSE (phase U5) one screen
 * at a time without touching the screens.
 */
export interface ApiClient {
  /** `mock` data is always shown with the SIMULATED badge. */
  readonly kind: 'mock' | 'live';
  /** Credentials shown on the login page of the preview. Only the mock has them. */
  readonly preview?: {
    readonly username: string;
    readonly password: string;
    /** The code of the second step, once the owner has turned it on in the preview. */
    readonly totp?: string;
  };
  /** Only the mock has these. */
  readonly scenarios?: PreviewControls;
  login(request: LoginRequest): Promise<void>;
  logout(): Promise<void>;
  /** The signed-in owner, or null when there is no valid session. */
  me(): Promise<MeResponse | null>;
  getSettings(): Promise<Settings>;
  getSnapshot(): Promise<MarketSnapshot>;
  getStrategies(): Promise<StrategyInfo[]>;
  getCandles(query: CandlesQuery): Promise<CandlesResponse>;
  getOpenSignals(): Promise<OpenSignalsResponse>;
  getSignals(query: SignalHistoryQuery): Promise<SignalHistoryPage>;
  /** GET /signals/:id. Fails with `ApiError` 404 `not_found` for an unknown id. */
  getSignalDetail(id: string): Promise<SignalDetail>;
  /** GET /signals/:id/snapshot. Fails with `ApiError` 404 `snapshot_pruned` after the retention window. */
  getSignalSnapshot(id: string): Promise<FeatureSnapshotResponse>;
  /** GET /analytics/overview. Without `from` and `to` it covers every signal of the scope. */
  getOverview(query: OverviewQuery): Promise<OverviewResponse>;
  getMonthly(query: MonthlyQuery): Promise<MonthlyResponse>;
  getBreakdown(query: BreakdownQuery): Promise<BreakdownResponse>;
  getFailures(query: FailuresQuery): Promise<FailuresResponse>;
  getGroupEffectiveness(query: GroupEffectivenessQuery): Promise<GroupEffectivenessResponse>;
  getCalibration(query: CalibrationQuery): Promise<CalibrationResponse>;
  getEquity(query: EquityQuery): Promise<EquityResponse>;
  /** Always forward results: drift is the comparison of the live results with the backtest. */
  getDrift(): Promise<DriftResponse>;
  getNewsImpact(): Promise<NewsImpactResponse>;
  getNewsState(): Promise<NewsStateResponse>;
  /** GET /news/events: the calendar, oldest first. */
  getNewsEvents(query: NewsEventsQuery): Promise<NewsEventsResponse>;
  getHeadlines(query: HeadlinesQuery): Promise<HeadlinesResponse>;
  /** GET /news/moves: detected market moves with their frozen headlines, newest first. */
  getMarketMoves(query: MarketMovesQuery): Promise<MarketMovesResponse>;
  /** Owner pause (POST /engine/pause). Without `minutes` it lasts until the owner resumes. */
  pauseEngine(request: { minutes?: number }): Promise<void>;
  resumeEngine(): Promise<void>;

  // System: health, storage and the owner's settings (04_API_and_Notifications section 2).
  getSystemHealth(): Promise<SystemHealth>;
  getSystemIncidents(): Promise<SystemIncidentsResponse>;
  getSystemStorage(): Promise<SystemStorage>;
  getSystemLatency(): Promise<SystemLatency>;
  /** PATCH /settings: any subset of the settings. Answers with all of them. */
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  /** GET /strategies/:key/config: read only. */
  getStrategyConfig(key: StrategyKey): Promise<StrategyConfigResponse>;
  /** PATCH /strategies/:key: the enable switch and the alert switch. */
  updateStrategy(key: StrategyKey, patch: StrategyPatch): Promise<StrategyInfo>;
  /** POST /notifications/test: queues a message that says it is a test. */
  sendTestNotification(request: NotificationTestRequest): Promise<NotificationTestResponse>;

  // Security
  /** POST /auth/password. Fails with `ApiError` 403 `wrong_password` when the current password is wrong. */
  changePassword(request: PasswordChangeRequest): Promise<void>;
  setupTotp(): Promise<TotpSetupResponse>;
  /** Fails with `ApiError` 400 `invalid_code` when the code is wrong. */
  enableTotp(request: TotpCodeRequest): Promise<TotpEnableResponse>;
  disableTotp(request: TotpCodeRequest): Promise<void>;
  getSessions(): Promise<SessionsResponse>;
  revokeSession(id: string): Promise<void>;

  /** The SSE stream (GET /stream): every event of 04_API_and_Notifications section 3. Returns the unsubscribe function. */
  subscribe(listener: (event: SseEvent) => void): () => void;
}

export async function loadApiClient(): Promise<ApiClient> {
  if (import.meta.env.VITE_DATA_SOURCE === 'live') {
    throw new Error('The live API is wired in phase U5. Use the mock data source until then.');
  }
  // Loaded on demand, so a live build can leave the mock data out of the bundle (phase U5).
  const { createMockClient } = await import('../mocks/mockClient');
  return createMockClient();
}
