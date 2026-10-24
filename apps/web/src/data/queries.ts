import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  BreakdownDimension,
  HeadlinesQuery,
  MarketMovesQuery,
  NewsEventsQuery,
  OverviewQuery,
  QuoteData,
  SignalHistoryQuery,
} from '@vmgs/contracts';
import type { StatsScope, StrategyKey } from '@vmgs/core';

import { useApi } from '../api/context';

/** One place for every query key, so the stream bridge and the screens address the same cache entries. */
export const KEYS = {
  settings: ['settings'],
  snapshot: ['snapshot'],
  strategies: ['strategies'],
  quote: ['quote'],
  openSignals: ['signals', 'open'],
  recentSignals: ['signals', 'recent'],
  signalHistory: ['signals', 'history'],
  signalDetail: ['signals', 'detail'],
  signalSnapshot: ['signals', 'snapshot'],
  overviewToday: ['overview', 'today'],
  overviewMonth: ['overview', 'month'],
  /** Every number of the Analytics screen (04_API_and_Notifications section 2). */
  analytics: ['analytics'],
  newsState: ['news', 'state'],
  headlines: ['news', 'headlines'],
  newsEvents: ['news', 'events'],
  marketMoves: ['news', 'moves'],
  /** Health, incidents, storage and latency of the System screen. */
  system: ['system'],
  sessions: ['auth', 'sessions'],
  strategyConfig: ['strategies', 'config'],
  candles: ['candles'],
} as const;

/** The newest quote of the stream (SSE `quote` event), or null before the first one arrives. */
export function useQuote(): QuoteData | null {
  const query = useQuery<QuoteData | null>({
    queryKey: KEYS.quote,
    queryFn: () => null,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return query.data ?? null;
}

export function useSnapshot() {
  const api = useApi();
  return useQuery({
    queryKey: KEYS.snapshot,
    queryFn: () => api.getSnapshot(),
    refetchInterval: 5000,
  });
}

export function useStrategies() {
  const api = useApi();
  return useQuery({ queryKey: KEYS.strategies, queryFn: () => api.getStrategies() });
}

export function useSettings() {
  const api = useApi();
  return useQuery({
    queryKey: KEYS.settings,
    queryFn: () => api.getSettings(),
    staleTime: Infinity,
  });
}

/** The time zone every time on screen is shown in (settings `displayTz`, default IST). */
export function useDisplayTz(): string {
  return useSettings().data?.displayTz ?? 'Asia/Kolkata';
}

export function useOpenSignals() {
  const api = useApi();
  return useQuery({
    queryKey: KEYS.openSignals,
    queryFn: () => api.getOpenSignals(),
    refetchInterval: 15_000,
  });
}

export function useRecentSignals(limit: number) {
  const api = useApi();
  return useQuery({
    queryKey: [...KEYS.recentSignals, limit],
    queryFn: () => api.getSignals({ limit }),
    refetchInterval: 60_000,
  });
}

/** What the history screen filters and sorts by (everything of the query except the paging). */
export type HistoryFilters = Omit<SignalHistoryQuery, 'limit' | 'cursor'>;

/** The history list, one page at a time (cursor pagination). Another filter or sort starts again from the first page. */
export function useSignalHistory(filters: HistoryFilters, pageSize: number) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: [...KEYS.signalHistory, filters, pageSize],
    queryFn: ({ pageParam }) =>
      api.getSignals({ ...filters, limit: pageSize, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });
}

/**
 * One signal with its events, result and review. An open signal is reloaded every 15 s and a
 * preliminary review every 30 s, so the final review appears by itself.
 */
export function useSignalDetail(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: [...KEYS.signalDetail, id],
    queryFn: () => api.getSignalDetail(id),
    refetchInterval: (query) => {
      const detail = query.state.data;
      if (!detail) return false;
      if (detail.state !== null) return 15_000;
      return detail.autopsy?.status === 'PRELIMINARY' ? 30_000 : false;
    },
  });
}

/** The raw feature snapshot. It is only fetched when the owner opens it (`enabled`). */
export function useSignalSnapshot(id: string, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: [...KEYS.signalSnapshot, id],
    queryFn: () => api.getSignalSnapshot(id),
    enabled,
    staleTime: Infinity,
  });
}

export function useNewsState() {
  const api = useApi();
  return useQuery({
    queryKey: KEYS.newsState,
    queryFn: () => api.getNewsState(),
    refetchInterval: 30_000,
  });
}

export function useTopHeadlines(limit: number) {
  const api = useApi();
  return useQuery({
    queryKey: [...KEYS.headlines, limit],
    queryFn: () => api.getHeadlines({ limit }),
    refetchInterval: 60_000,
  });
}

// ---------------------------------------------------------------------------------------------
// The News screen

/** What the headline list is filtered by (everything of the query except the paging). */
export type HeadlineFilters = Omit<HeadlinesQuery, 'limit' | 'cursor'>;

/** The calendar of a range. The range is part of the key, so it changes the entry only when the day changes. */
export function useNewsEvents(query: NewsEventsQuery) {
  const api = useApi();
  return useQuery({
    queryKey: [...KEYS.newsEvents, query],
    queryFn: () => api.getNewsEvents(query),
    refetchInterval: 60_000,
  });
}

/** The headlines, one page at a time (cursor pagination). Another filter starts again from the first page. */
export function useHeadlineFeed(filters: HeadlineFilters, pageSize: number) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: [...KEYS.headlines, 'feed', filters, pageSize],
    queryFn: ({ pageParam }) =>
      api.getHeadlines({
        ...filters,
        limit: pageSize,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });
}

export function useMarketMoves(query: MarketMovesQuery) {
  const api = useApi();
  return useQuery({
    queryKey: [...KEYS.marketMoves, query],
    queryFn: () => api.getMarketMoves(query),
    refetchInterval: 60_000,
  });
}

// ---------------------------------------------------------------------------------------------
// The System screen

export function useSystemHealth() {
  const api = useApi();
  return useQuery({
    queryKey: [...KEYS.system, 'health'],
    queryFn: () => api.getSystemHealth(),
    refetchInterval: 15_000,
  });
}

export function useSystemIncidents() {
  const api = useApi();
  return useQuery({
    queryKey: [...KEYS.system, 'incidents'],
    queryFn: () => api.getSystemIncidents(),
    refetchInterval: 30_000,
  });
}

export function useSystemLatency() {
  const api = useApi();
  return useQuery({
    queryKey: [...KEYS.system, 'latency'],
    queryFn: () => api.getSystemLatency(),
    refetchInterval: 30_000,
  });
}

export function useSystemStorage() {
  const api = useApi();
  return useQuery({
    queryKey: [...KEYS.system, 'storage'],
    queryFn: () => api.getSystemStorage(),
    refetchInterval: 60_000,
  });
}

/** The config of a strategy, only fetched when the owner opens it (`enabled`). It cannot change: a change is a new version. */
export function useStrategyConfig(key: StrategyKey, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: [...KEYS.strategyConfig, key],
    queryFn: () => api.getStrategyConfig(key),
    enabled,
    staleTime: Infinity,
  });
}

export function useSessions() {
  const api = useApi();
  return useQuery({ queryKey: KEYS.sessions, queryFn: () => api.getSessions() });
}

// The Analytics screen. Every query carries its scope in the key, so switching the scope loads the
// other numbers and shows the old ones of that scope again at once. They change only when a signal
// closes (the stream bridge reloads them), so they are refreshed slowly.
const ANALYTICS_REFRESH_MS = 120_000;

export function useAnalyticsOverview(scope: StatsScope) {
  const api = useApi();
  const query: OverviewQuery = { scope };
  return useQuery({
    queryKey: [...KEYS.analytics, 'overview', scope],
    queryFn: () => api.getOverview(query),
    refetchInterval: ANALYTICS_REFRESH_MS,
  });
}

export function useMonthly(scope: StatsScope) {
  const api = useApi();
  return useQuery({
    queryKey: [...KEYS.analytics, 'monthly', scope],
    queryFn: () => api.getMonthly({ scope, months: 12 }),
    refetchInterval: ANALYTICS_REFRESH_MS,
  });
}

export function useEquity(scope: StatsScope) {
  const api = useApi();
  return useQuery({
    queryKey: [...KEYS.analytics, 'equity', scope],
    queryFn: () => api.getEquity({ scope }),
    refetchInterval: ANALYTICS_REFRESH_MS,
  });
}

/** One dimension of the breakdown, loaded when its tab is open (`enabled`). */
export function useBreakdown(scope: StatsScope, by: BreakdownDimension, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...KEYS.analytics, 'breakdown', scope, by],
    queryFn: () => api.getBreakdown({ scope, by }),
    enabled,
    refetchInterval: ANALYTICS_REFRESH_MS,
  });
}

export function useFailures(scope: StatsScope) {
  const api = useApi();
  return useQuery({
    queryKey: [...KEYS.analytics, 'failures', scope],
    queryFn: () => api.getFailures({ scope }),
    refetchInterval: ANALYTICS_REFRESH_MS,
  });
}

export function useGroupEffectiveness(scope: StatsScope) {
  const api = useApi();
  return useQuery({
    queryKey: [...KEYS.analytics, 'groups', scope],
    queryFn: () => api.getGroupEffectiveness({ scope }),
    refetchInterval: ANALYTICS_REFRESH_MS,
  });
}

export function useCalibration(scope: StatsScope) {
  const api = useApi();
  return useQuery({
    queryKey: [...KEYS.analytics, 'calibration', scope],
    queryFn: () => api.getCalibration({ scope }),
    refetchInterval: ANALYTICS_REFRESH_MS,
  });
}

/** Forward results only: drift compares them with the backtest, whatever scope is selected. */
export function useDrift() {
  const api = useApi();
  return useQuery({
    queryKey: [...KEYS.analytics, 'drift'],
    queryFn: () => api.getDrift(),
    refetchInterval: ANALYTICS_REFRESH_MS,
  });
}

export function useNewsImpact() {
  const api = useApi();
  return useQuery({
    queryKey: [...KEYS.analytics, 'news-impact'],
    queryFn: () => api.getNewsImpact(),
    staleTime: Infinity,
  });
}
