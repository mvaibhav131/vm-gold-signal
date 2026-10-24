import type { FeedFacts, MarketGateInputs, SetupGateInputs } from './types';

/** A Wednesday afternoon in winter: London and New York both open (the overlap). */
export const NOW = Date.UTC(2026, 0, 14, 14, 0);
export const FIVE_MINUTES = 300_000;

/** `count` open times of 5m candles, the last one opening at `last`. */
export function openTimes(count: number, last = NOW): number[] {
  return Array.from({ length: count }, (_, i) => last - (count - 1 - i) * FIVE_MINUTES);
}

export const FEED_OK: FeedFacts = {
  connected: true,
  tickAgeMs: 2_000,
  providerStale: false,
  marketState: 'OPEN',
};

/** A market in which every market gate passes. */
export const MARKET_OK: MarketGateInputs = {
  feed: FEED_OK,
  candles: { '5m': 900, '15m': 1440, '1h': 600 },
  requiredTimeframes: ['5m', '15m', '1h'],
  clockSkewMs: 900,
  spread: 0.2,
  fiveMinuteOpenTimes: openTimes(20),
  decisionOpenTime: NOW,
};

/** A setup in which every setup gate passes: stop 1.5 ATR, target 1.5 ATR, spread 0.2 of a 0.36 limit. */
export const SETUP_OK: SetupGateInputs = {
  regime: 'TREND_UP',
  acceptedRegimes: ['TREND_UP', 'TREND_DOWN'],
  atr5: 2,
  stopDistance: 3,
  tp1Distance: 3,
  qualityScore: 72,
  qualityCoverage: 1,
};
