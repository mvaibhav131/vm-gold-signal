import { Alert, Text } from '@mantine/core';

import { useQuote, useSnapshot } from '../data/queries';

/**
 * The red banner across the page when the data is stale or the feed is down (05_UI_Spec section 4,
 * scenario E3). It is on every private screen: no screen can look healthy while the data is not.
 */
export function FeedBanner() {
  const quote = useQuote();
  const snapshot = useSnapshot();
  const feedState = quote?.feedState ?? snapshot.data?.feedState;
  const ageMs = quote?.ageMs ?? snapshot.data?.ageMs ?? 0;

  if (feedState !== 'STALE' && feedState !== 'DISCONNECTED') return null;

  const stale = feedState === 'STALE';
  return (
    <Alert
      color="negative"
      variant="light"
      title={stale ? 'DATA STALE' : 'FEED DISCONNECTED'}
      role="alert"
      mb="md"
      data-testid="feed-banner"
    >
      <Text size="sm">
        {stale
          ? `No tick for ${String(Math.round(ageMs / 1000))} s. `
          : 'The price feed is not connected. '}
        New signals are blocked and open trades cannot be tracked until fresh data returns.
      </Text>
    </Alert>
  );
}
