import { useEffect, useState } from 'react';

import type { QuoteData } from '@vmgs/contracts';

import { useApi } from './api/context';

/** The latest quote of the stream (SSE `quote` event), or null before the first one arrives. */
export function useQuote(): QuoteData | null {
  const api = useApi();
  const [quote, setQuote] = useState<QuoteData | null>(null);

  useEffect(() => api.subscribeQuotes(setQuote), [api]);

  return quote;
}

/** Sets the browser tab title; screen readers announce a changed title on navigation. */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · VM Gold Signal`;
  }, [title]);
}
