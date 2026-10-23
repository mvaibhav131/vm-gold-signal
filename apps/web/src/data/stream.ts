import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  MarketSnapshot,
  NewsStateResponse,
  OpenSignalsResponse,
  SseEvent,
} from '@vmgs/contracts';
import { useEffect } from 'react';

import { useApi } from '../api/context';
import { KEYS } from './queries';

function invalidate(queryClient: QueryClient, ...keys: readonly (readonly unknown[])[]): void {
  for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
}

/** Applies one SSE event to the cached data (04_API_and_Notifications section 3). Exported for tests. */
export function applyStreamEvent(queryClient: QueryClient, event: SseEvent): void {
  switch (event.event) {
    case 'quote':
      queryClient.setQueryData(KEYS.quote, event.data);
      return;

    case 'signal':
      // The event carries only the id: the canonical rows come over REST.
      invalidate(
        queryClient,
        KEYS.openSignals,
        KEYS.recentSignals,
        KEYS.overviewToday,
        KEYS.overviewMonth,
        KEYS.snapshot,
      );
      return;

    case 'signal_update': {
      const { id, status, unrealisedR, stop } = event.data;
      if (status === 'CLOSED') {
        invalidate(queryClient, KEYS.openSignals, KEYS.recentSignals, KEYS.snapshot);
        return;
      }
      queryClient.setQueryData<OpenSignalsResponse>(
        KEYS.openSignals,
        (old) =>
          old && {
            ...old,
            items: old.items.map((item) =>
              item.signal.id === id
                ? { ...item, live: { ...item.live, status, unrealisedR, stopLossCurrent: stop } }
                : item,
            ),
          },
      );
      return;
    }

    case 'engine': {
      const before = queryClient.getQueryData<MarketSnapshot>(KEYS.snapshot);
      queryClient.setQueryData<MarketSnapshot>(
        KEYS.snapshot,
        (old) =>
          old && {
            ...old,
            regime: event.data.regime,
            session: event.data.session,
            engine: {
              ...old.engine,
              status: event.data.status,
              waitReasons: event.data.waitReasons,
            },
          },
      );
      // `pausedSince` is not in the event: reload the snapshot when the owner paused or resumed.
      if (before?.engine.status !== event.data.status) invalidate(queryClient, KEYS.snapshot);
      return;
    }

    case 'news':
      queryClient.setQueryData<NewsStateResponse>(
        KEYS.newsState,
        (old) => old && { ...old, state: event.data.state, next: event.data.next },
      );
      if (event.data.headline) invalidate(queryClient, KEYS.headlines);
      return;

    case 'health':
      return;

    case 'resync':
      // The server lost track of what this client has seen: reload everything over REST.
      void queryClient.invalidateQueries();
      return;
  }
}

/** Keeps the cache of the private screens up to date from the one SSE connection. */
export function useStreamBridge(): void {
  const api = useApi();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      api.subscribe((event) => {
        applyStreamEvent(queryClient, event);
      }),
    [api, queryClient],
  );
}
