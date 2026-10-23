import type {
  LoginRequest,
  MarketSnapshot,
  MeResponse,
  QuoteData,
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
  login(request: LoginRequest): Promise<void>;
  logout(): Promise<void>;
  /** The signed-in owner, or null when there is no valid session. */
  me(): Promise<MeResponse | null>;
  getSnapshot(): Promise<MarketSnapshot>;
  getStrategies(): Promise<StrategyInfo[]>;
  /** Streams quotes (the SSE `quote` event). Returns the unsubscribe function. */
  subscribeQuotes(listener: (quote: QuoteData) => void): () => void;
}

export async function loadApiClient(): Promise<ApiClient> {
  if (import.meta.env.VITE_DATA_SOURCE === 'live') {
    throw new Error('The live API is wired in phase U5. Use the mock data source until then.');
  }
  // Loaded on demand, so a live build can leave the mock data out of the bundle (phase U5).
  const { createMockClient } = await import('../mocks/mockClient');
  return createMockClient();
}
