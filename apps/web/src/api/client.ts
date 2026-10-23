import type {
  CandlesQuery,
  CandlesResponse,
  HeadlinesQuery,
  HeadlinesResponse,
  LoginRequest,
  MarketSnapshot,
  MeResponse,
  NewsStateResponse,
  OpenSignalsResponse,
  OverviewQuery,
  OverviewResponse,
  Settings,
  SignalHistoryPage,
  SignalHistoryQuery,
  SseEvent,
  StrategyInfo,
} from '@vmgs/contracts';

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
  readonly preview?: { readonly username: string; readonly password: string };
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
  getOverview(query: OverviewQuery): Promise<OverviewResponse>;
  getNewsState(): Promise<NewsStateResponse>;
  getHeadlines(query: HeadlinesQuery): Promise<HeadlinesResponse>;
  /** Owner pause (POST /engine/pause). Without `minutes` it lasts until the owner resumes. */
  pauseEngine(request: { minutes?: number }): Promise<void>;
  resumeEngine(): Promise<void>;
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
