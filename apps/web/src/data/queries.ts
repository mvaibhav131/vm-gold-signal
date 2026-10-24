import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { QuoteData, SignalHistoryQuery } from '@vmgs/contracts';

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
  newsState: ['news', 'state'],
  headlines: ['news', 'headlines'],
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
