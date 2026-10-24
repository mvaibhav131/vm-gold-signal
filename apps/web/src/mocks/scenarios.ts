import type { FeedState, Regime, Timeframe } from '@vmgs/core';
import type { WaitReason } from '@vmgs/contracts';

import type { TemplateKey } from './signals';

/** One state of the simulated market, selectable in the preview (and by the e2e tests with `?scenario=`). */
export interface Scenario {
  readonly id: string;
  readonly label: string;
  readonly feedState: FeedState;
  readonly regime: Regime;
  readonly signals: readonly TemplateKey[];
  /** The owner paused the engine (`pausedSince` is 12 minutes before the scenario started). */
  readonly paused: boolean;
  readonly news: 'CLEAR' | 'IN_WINDOW';
  readonly warmup: {
    readonly ready: boolean;
    readonly progressPct: number;
    readonly missingTimeframes: readonly Timeframe[];
  };
  /** Age of the newest tick in milliseconds, or null while the quote stream is alive. */
  readonly tickAgeMs: number | null;
  readonly waitReasons: readonly WaitReason[];
  /** A loss closed 35 minutes before the scenario started: its review is still preliminary. */
  readonly freshLoss?: boolean;
}

const READY = { ready: true, progressPct: 100, missingTimeframes: [] } as const;
const NO_SETUP: readonly WaitReason[] = [{ code: 'NO_SETUP', label: 'No new setup right now' }];

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'two-open',
    label: 'Two open signals (BUY and an opposing SELL)',
    feedState: 'LIVE',
    regime: 'TREND_UP',
    signals: ['buy', 'sell'],
    paused: false,
    news: 'CLEAR',
    warmup: READY,
    tickAgeMs: null,
    waitReasons: NO_SETUP,
  },
  {
    id: 'open-buy',
    label: 'One open BUY signal',
    feedState: 'LIVE',
    regime: 'TREND_UP',
    signals: ['buy'],
    paused: false,
    news: 'CLEAR',
    warmup: READY,
    tickAgeMs: null,
    waitReasons: NO_SETUP,
  },
  {
    id: 'tp1-hit',
    label: 'BUY after TP1 (stop moved to entry)',
    feedState: 'LIVE',
    regime: 'TREND_UP',
    signals: ['buy-tp1'],
    paused: false,
    news: 'CLEAR',
    warmup: READY,
    tickAgeMs: null,
    waitReasons: NO_SETUP,
  },
  {
    id: 'wait',
    label: 'No signal (WAIT reasons)',
    feedState: 'LIVE',
    regime: 'RANGE',
    signals: [],
    paused: false,
    news: 'IN_WINDOW',
    warmup: READY,
    tickAgeMs: null,
    waitReasons: [
      { code: 'SPREAD_OK', label: 'Spread too high: 0.90 USD' },
      { code: 'NEWS_WINDOW', label: 'News window: CPI in 22 min' },
      { code: 'REGIME_OK', label: 'Regime: range, no strategy accepts it' },
    ],
  },
  {
    id: 'warming-up',
    label: 'Warming up (new install)',
    feedState: 'WARMING_UP',
    regime: 'UNCERTAIN',
    signals: [],
    paused: false,
    news: 'CLEAR',
    warmup: { ready: false, progressPct: 62, missingTimeframes: ['1h', '4h'] },
    tickAgeMs: null,
    waitReasons: [{ code: 'WARMUP_OK', label: 'Warming up: 1h and 4h candles are still missing' }],
  },
  {
    id: 'stale',
    label: 'Feed stale (open trade cannot be tracked)',
    feedState: 'STALE',
    regime: 'TREND_UP',
    signals: ['buy'],
    paused: false,
    news: 'CLEAR',
    warmup: READY,
    tickAgeMs: 18_400,
    waitReasons: [{ code: 'DATA_FRESH', label: 'No tick for 18 s: new signals are blocked' }],
  },
  {
    id: 'disconnected',
    label: 'Feed disconnected',
    feedState: 'DISCONNECTED',
    regime: 'TREND_UP',
    signals: ['buy'],
    paused: false,
    news: 'CLEAR',
    warmup: READY,
    tickAgeMs: 95_000,
    waitReasons: [{ code: 'DATA_FRESH', label: 'Feed disconnected: new signals are blocked' }],
  },
  {
    id: 'market-closed',
    label: 'Market closed (weekend)',
    feedState: 'MARKET_CLOSED',
    regime: 'UNCERTAIN',
    signals: [],
    paused: false,
    news: 'CLEAR',
    warmup: READY,
    tickAgeMs: 7_200_000,
    waitReasons: [{ code: 'MARKET_CLOSED', label: 'Market closed until the weekly reopening' }],
  },
  {
    id: 'review-pending',
    label: 'A loss just closed (its review is still preliminary)',
    feedState: 'LIVE',
    regime: 'RANGE',
    signals: [],
    paused: false,
    news: 'CLEAR',
    warmup: READY,
    tickAgeMs: null,
    waitReasons: NO_SETUP,
    freshLoss: true,
  },
  {
    id: 'paused',
    label: 'Paused by the owner',
    feedState: 'LIVE',
    regime: 'TREND_UP',
    signals: ['buy'],
    paused: true,
    news: 'CLEAR',
    warmup: READY,
    tickAgeMs: null,
    waitReasons: [{ code: 'PAUSED', label: 'Paused by you: no new signals until you resume' }],
  },
];

export const DEFAULT_SCENARIO = 'two-open';

export function scenarioById(id: string | null | undefined): Scenario {
  return SCENARIOS.find((scenario) => scenario.id === id) ?? scenarioById(DEFAULT_SCENARIO);
}
