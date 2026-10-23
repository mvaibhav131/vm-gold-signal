import { useQuery } from '@tanstack/react-query';
import type { QuoteData } from '@vmgs/contracts';

import { useApi } from '../api/context';

/** One place for every query key, so the stream bridge and the screens address the same cache entries. */
export const KEYS = {
  settings: ['settings'],
  snapshot: ['snapshot'],
  strategies: ['strategies'],
  quote: ['quote'],
  openSignals: ['signals', 'open'],
  recentSignals: ['signals', 'recent'],
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
