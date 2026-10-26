import {
  calibrationResponseSchema,
  candlesResponseSchema,
  driftResponseSchema,
  equityResponseSchema,
  failuresResponseSchema,
  featureSnapshotResponseSchema,
  groupEffectivenessResponseSchema,
  headlinesResponseSchema,
  marketMovesResponseSchema,
  marketSnapshotSchema,
  meResponseSchema,
  monthlyResponseSchema,
  breakdownResponseSchema,
  newsEventsResponseSchema,
  newsImpactResponseSchema,
  newsStateResponseSchema,
  notificationTestResponseSchema,
  openSignalsResponseSchema,
  overviewResponseSchema,
  pushStatusResponseSchema,
  sessionsResponseSchema,
  settingsSchema,
  signalDetailSchema,
  signalHistoryPageSchema,
  sseEventSchema,
  strategiesResponseSchema,
  strategyConfigResponseSchema,
  strategyInfoSchema,
  systemHealthSchema,
  systemIncidentsResponseSchema,
  systemLatencySchema,
  systemStorageSchema,
  totpEnableResponseSchema,
  totpSetupResponseSchema,
  type SseEvent,
} from '@vmgs/contracts';
import type { z } from 'zod';

import { ApiError, type ApiClient } from './client';

/** The part of `fetch` that the client uses, so that a test (or a server without DOM types) can give another. */
export interface FetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly credentials: 'same-origin';
  readonly cache: 'no-store';
}
export interface FetchReply {
  readonly status: number;
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchReply>;

/** The part of `EventSource` that the client uses. */
export interface EventSourceLike {
  /** 0 connecting, 1 open, 2 closed (the standard values). */
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

export interface HttpClientOptions {
  /** Empty (the default) is the origin of the page: Caddy serves the web app and the API on one origin. */
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly eventSource?: EventSourceFactory;
  /** The waits before the stream is opened again after the server refused it (a browser does not do that by itself). */
  readonly streamRetryMs?: { readonly first: number; readonly max: number };
  /** Told about an event of the stream that does not match its contract (it is dropped, never shown). */
  readonly onProtocolProblem?: (message: string) => void;
}

const API = '/api/v1';
const CLOSED = 2;

/** Every event name of the stream; the test of this file checks the list against the schema of the contract. */
export const STREAM_EVENT_NAMES = [
  'quote',
  'signal',
  'signal_update',
  'engine',
  'news',
  'health',
  'resync',
] as const satisfies readonly SseEvent['event'][];

type Query = object | undefined;

/** `a=1&b=x,y`: a list is one comma-separated value, a missing or empty value is left out. */
export function queryString(query: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    const text = Array.isArray(value) ? value.join(',') : String(value);
    if (text !== '') params.set(key, text);
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/** The problem+json of an answer as an `ApiError`; an answer that is no problem+json is still an error with its status. */
function problemOf(status: number, text: string): ApiError {
  try {
    const json = JSON.parse(text) as unknown;
    if (typeof json === 'object' && json !== null) {
      const { code, detail, title } = json as Record<string, unknown>;
      return new ApiError(
        status,
        typeof code === 'string' ? code : 'http_error',
        typeof detail === 'string' ? detail : typeof title === 'string' ? title : `HTTP ${status}`,
      );
    }
  } catch {
    // not JSON: the status says what it can
  }
  return new ApiError(status, 'http_error', `The server answered ${status}.`);
}

/** The fields of an answer that do not match, never their values. */
function fieldsOf(error: z.ZodError): string {
  return [...new Set(error.issues.map((issue) => issue.path.join('.') || '(answer)'))].join(', ');
}

function defaultFetch(): FetchLike {
  return (url, init) => fetch(url, init);
}

function defaultEventSource(): EventSourceFactory {
  return (url) => {
    if (typeof EventSource === 'undefined') throw new Error('This browser has no EventSource.');
    return new EventSource(url);
  };
}

/**
 * The client of the live API (phase U5): every screen talks to `ApiClient`, and this is the implementation that goes
 * to the server. Each answer is parsed with its schema of `packages/contracts`, so an answer that does not match is an
 * error here, never a wrong number on a screen. The session is the cookie of the browser; a change also sends
 * `X-VMGS-CSRF: 1` (the browser adds `Origin` itself).
 */
export function createHttpClient(options: HttpClientOptions = {}): ApiClient {
  const base = options.baseUrl ?? '';
  const send = options.fetch ?? defaultFetch();
  const openSource = options.eventSource ?? defaultEventSource();
  const retry = options.streamRetryMs ?? { first: 1000, max: 30_000 };

  async function call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    spec: { query?: Query; body?: unknown } = {},
  ): Promise<string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (method !== 'GET') headers['x-vmgs-csrf'] = '1';
    let body: string | undefined;
    if (spec.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(spec.body);
    }
    let reply: FetchReply;
    try {
      reply = await send(`${base}${API}${path}${queryString(spec.query)}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      throw new ApiError(0, 'network_error', 'The server could not be reached.');
    }
    const text = await reply.text().catch(() => '');
    if (reply.status >= 400) throw problemOf(reply.status, text);
    return text;
  }

  function parse<T>(schema: z.ZodType<T>, text: string): T {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(502, 'invalid_response', 'The answer of the server is not JSON.');
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      throw new ApiError(
        502,
        'invalid_response',
        `The answer of the server does not match its contract: ${fieldsOf(result.error)}.`,
      );
    }
    return result.data;
  }

  const get = async <T>(path: string, schema: z.ZodType<T>, query?: Query): Promise<T> =>
    parse(schema, await call('GET', path, { query }));
  const post = async <T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> =>
    parse(schema, await call('POST', path, { body }));
  const patch = async <T>(path: string, schema: z.ZodType<T>, body: unknown): Promise<T> =>
    parse(schema, await call('PATCH', path, { body }));
  /** An answer of 204: nothing to read. */
  const change = async (
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<void> => {
    await call(method, path, { body });
  };
  const id = encodeURIComponent;

  function subscribe(listener: (event: SseEvent) => void): () => void {
    let source: EventSourceLike | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let failures = 0;
    // A source made again by this code (after a refusal) has no `Last-Event-ID`: its first `open` says `resync`.
    let remade = false;

    const deliver = (name: string, data: unknown): void => {
      if (stopped) return;
      let json: unknown;
      try {
        json = typeof data === 'string' ? JSON.parse(data) : undefined;
      } catch {
        json = undefined;
      }
      const result = sseEventSchema.safeParse({ event: name, data: json });
      if (result.success) listener(result.data);
      else options.onProtocolProblem?.(`an event of the stream is not valid: ${name}`);
    };

    const open = (): void => {
      if (stopped) return;
      const current = openSource(`${base}${API}/stream`);
      source = current;
      for (const name of STREAM_EVENT_NAMES) {
        current.addEventListener(name, (message) => {
          deliver(name, message.data);
        });
      }
      current.addEventListener('open', () => {
        failures = 0;
        if (remade) {
          remade = false;
          listener({ event: 'resync', data: {} });
        }
      });
      current.addEventListener('error', () => {
        // While the browser is still connecting it tries again by itself, with `Last-Event-ID`: the server replays.
        if (stopped || current.readyState !== CLOSED) return;
        current.close();
        failures += 1;
        const wait = Math.min(retry.max, retry.first * 2 ** (failures - 1));
        timer = setTimeout(() => {
          timer = null;
          remade = true;
          open();
        }, wait);
      });
    };
    open();

    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      source?.close();
      source = null;
    };
  }

  return {
    kind: 'live',

    login: (request) => change('POST', '/auth/login', request),
    async logout() {
      try {
        await change('POST', '/auth/logout');
      } catch (error) {
        // no session any more is what a logout wants
        if (!(error instanceof ApiError && error.status === 401)) throw error;
      }
    },
    async me() {
      try {
        return await get('/auth/me', meResponseSchema);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },

    getSettings: () => get('/settings', settingsSchema),
    getSnapshot: () => get('/market/snapshot', marketSnapshotSchema),
    getStrategies: async () => (await get('/strategies', strategiesResponseSchema)).items,
    getCandles: (query) => get('/market/candles', candlesResponseSchema, query),
    getOpenSignals: () => get('/signals/open', openSignalsResponseSchema),
    getSignals: (query) => get('/signals', signalHistoryPageSchema, query),
    getSignalDetail: (signalId) => get(`/signals/${id(signalId)}`, signalDetailSchema),
    getSignalSnapshot: (signalId) =>
      get(`/signals/${id(signalId)}/snapshot`, featureSnapshotResponseSchema),

    getOverview: (query) => get('/analytics/overview', overviewResponseSchema, query),
    getMonthly: (query) => get('/analytics/monthly', monthlyResponseSchema, query),
    getBreakdown: (query) => get('/analytics/breakdown', breakdownResponseSchema, query),
    getFailures: (query) => get('/analytics/failures', failuresResponseSchema, query),
    getGroupEffectiveness: (query) =>
      get('/analytics/groups', groupEffectivenessResponseSchema, query),
    getCalibration: (query) =>
      get('/analytics/score-calibration', calibrationResponseSchema, query),
    getEquity: (query) => get('/analytics/equity', equityResponseSchema, query),
    getDrift: () => get('/analytics/drift', driftResponseSchema),
    getNewsImpact: () => get('/analytics/news-impact', newsImpactResponseSchema),

    getNewsState: () => get('/news/state', newsStateResponseSchema),
    getNewsEvents: (query) => get('/news/events', newsEventsResponseSchema, query),
    getHeadlines: (query) => get('/news/headlines', headlinesResponseSchema, query),
    getMarketMoves: (query) => get('/news/moves', marketMovesResponseSchema, query),

    pauseEngine: (request) => change('POST', '/engine/pause', request),
    resumeEngine: () => change('POST', '/engine/resume'),

    getSystemHealth: () => get('/system/health', systemHealthSchema),
    getSystemIncidents: () => get('/system/incidents', systemIncidentsResponseSchema),
    getSystemStorage: () => get('/system/storage', systemStorageSchema),
    getSystemLatency: () => get('/system/latency', systemLatencySchema),
    updateSettings: (request) => patch('/settings', settingsSchema, request),
    getStrategyConfig: (key) => get(`/strategies/${id(key)}/config`, strategyConfigResponseSchema),
    updateStrategy: (key, request) => patch(`/strategies/${id(key)}`, strategyInfoSchema, request),
    sendTestNotification: (request) =>
      post('/notifications/test', notificationTestResponseSchema, request),
    getPushStatus: () => get('/push/status', pushStatusResponseSchema),
    subscribePush: (request) => change('POST', '/push/subscribe', request),
    unsubscribePush: (request) => change('DELETE', '/push/subscribe', request),

    changePassword: (request) => change('POST', '/auth/password', request),
    setupTotp: () => post('/auth/totp/setup', totpSetupResponseSchema),
    enableTotp: (request) => post('/auth/totp/enable', totpEnableResponseSchema, request),
    disableTotp: (request) => change('POST', '/auth/totp/disable', request),
    getSessions: () => get('/auth/sessions', sessionsResponseSchema),
    revokeSession: (sessionId) => change('DELETE', `/auth/sessions/${id(sessionId)}`),

    subscribe,
  };
}
