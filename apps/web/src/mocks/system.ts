import {
  systemHealthSchema,
  systemIncidentsResponseSchema,
  systemLatencySchema,
  systemStorageSchema,
  strategyConfigResponseSchema,
  type FeedIncident,
  type StrategyConfigResponse,
  type SystemHealth,
  type SystemIncidentsResponse,
  type SystemLatency,
  type SystemStorage,
} from '@vmgs/contracts';
import type { FeedState, StrategyKey, StrategyStatus } from '@vmgs/core';

const SECOND_MS = 1000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** What the health numbers of the preview depend on: the preview state, the quote and the last test message. */
export interface SystemInput {
  readonly nowMs: number;
  readonly feedState: FeedState;
  /** Age of the newest tick in milliseconds. */
  readonly feedAgeMs: number;
  /** The "system warning" preview state: Telegram failing, clock skew, a full database, an old backup. */
  readonly warning: boolean;
  /** When the owner last sent a test message (the preview sends it at once), or null. */
  readonly testSentAtMs: number | null;
}

const ago = (nowMs: number, ms: number) => new Date(nowMs - ms).toISOString();

export function healthAt(input: SystemInput): SystemHealth {
  const { nowMs, feedState, feedAgeMs, warning, testSentAtMs } = input;
  const ticksPerSecond =
    feedState === 'DISCONNECTED'
      ? null
      : feedState === 'LIVE' || feedState === 'WARMING_UP'
        ? 2.4
        : 0;
  const baseSendMs = nowMs - (warning ? 230 : 47) * MINUTE_MS;
  // In the warning state Telegram keeps failing, so a test message does not get through.
  const lastSendMs =
    warning || testSentAtMs === null ? baseSendMs : Math.max(baseSendMs, testSentAtMs);
  return systemHealthSchema.parse({
    feedAgeMs,
    ticksPerSecond,
    workerHeartbeatAt: ago(nowMs, 8 * SECOND_MS),
    eventLoopLagMs: warning ? 180 : 12,
    dbReachable: true,
    telegram: {
      lastSendAt: new Date(lastSendMs).toISOString(),
      lastError: warning ? 'Telegram answered 502 Bad Gateway; retrying in 45 s' : null,
    },
    clockSkewMs: warning ? 3400 : 40,
    lastBackupAt: ago(nowMs, (warning ? 41 : 9) * HOUR_MS),
    lastMaintenanceAt: ago(nowMs, 11 * HOUR_MS),
  });
}

interface ClosedIncident {
  readonly kind: 'DISCONNECT' | 'STALE' | 'GAP' | 'CLOCK_SKEW' | 'SPREAD_SPIKE' | 'MARKET_STATE';
  readonly hoursAgo: number;
  readonly durationS: number;
  readonly detail: string;
}

/** Oldest first; the ids follow the order. */
const CLOSED: readonly ClosedIncident[] = [
  {
    kind: 'DISCONNECT',
    hoursAgo: 400,
    durationS: 14,
    detail: 'Connection lost, reconnected after 14 s',
  },
  { kind: 'STALE', hoursAgo: 310, durationS: 31, detail: 'No tick for 31 s' },
  {
    kind: 'GAP',
    hoursAgo: 260,
    durationS: 180,
    detail: 'Gap of 3 min back-filled from the REST candles',
  },
  {
    kind: 'CLOCK_SKEW',
    hoursAgo: 190,
    durationS: 420,
    detail: 'Skew of 5.3 s against the feed time, corrected by NTP',
  },
  {
    kind: 'DISCONNECT',
    hoursAgo: 130,
    durationS: 9,
    detail: 'Connection lost, reconnected after 9 s',
  },
  { kind: 'STALE', hoursAgo: 80, durationS: 18, detail: 'No tick for 18 s' },
  {
    kind: 'MARKET_STATE',
    hoursAgo: 52,
    durationS: 48 * 3600,
    detail: 'Market closed for the weekend',
  },
  {
    kind: 'SPREAD_SPIKE',
    hoursAgo: 31,
    durationS: 40,
    detail: 'Spread of 1.9 USD for 40 s at the daily rollover',
  },
  {
    kind: 'GAP',
    hoursAgo: 20,
    durationS: 240,
    detail: 'Gap of 4 min back-filled from the REST candles',
  },
];

/** The last 30 incidents, newest first. A feed that is stale or disconnected has an incident that is still open. */
export function incidentsAt(input: SystemInput): SystemIncidentsResponse {
  const { nowMs, feedState, feedAgeMs, warning } = input;
  const closed = CLOSED.map((incident, index): FeedIncident => {
    const startedMs = nowMs - incident.hoursAgo * HOUR_MS;
    return {
      id: index + 1,
      kind: incident.kind,
      startedAt: new Date(startedMs).toISOString(),
      endedAt: new Date(startedMs + incident.durationS * SECOND_MS).toISOString(),
      detail: incident.detail,
    };
  });
  const open: FeedIncident[] = [];
  if (feedState === 'STALE' || feedState === 'DISCONNECTED') {
    open.push({
      id: closed.length + 1,
      kind: feedState === 'STALE' ? 'STALE' : 'DISCONNECT',
      startedAt: new Date(nowMs - feedAgeMs).toISOString(),
      endedAt: null,
      detail:
        feedState === 'STALE'
          ? `No tick for ${String(Math.round(feedAgeMs / SECOND_MS))} s, new signals are blocked`
          : 'Connection lost, reconnecting',
    });
  }
  if (warning) {
    open.push({
      id: closed.length + open.length + 1,
      kind: 'CLOCK_SKEW',
      startedAt: ago(nowMs, 22 * MINUTE_MS),
      endedAt: null,
      detail: 'Skew of 3.4 s against the feed time, below the limit of 5 s',
    });
  }
  // newest first: the open incidents began last
  return systemIncidentsResponseSchema.parse({
    items: [...open.reverse(), ...closed.reverse()].slice(0, 30),
  });
}

const GIB = 1024 ** 3;
/** The soft limit of the database (01_HLD section 7). */
const DB_BUDGET_BYTES = 10 * GIB;
const OTHER_BYTES = 90_000_000;

const TABLE_SIZES: readonly (readonly [string, number])[] = [
  ['ticks', 612_000_000],
  ['candles_1m', 198_000_000],
  ['signal_feature_snapshots', 131_000_000],
  ['rejections', 62_000_000],
  ['news_items', 24_000_000],
  ['notification_outbox', 11_000_000],
  ['candles_5m_and_higher', 6_000_000],
  ['signals_events_and_outcomes', 3_000_000],
];

/** The retention rules of 01_HLD section 7, read-only. */
export const RETENTION_RULES: readonly { item: string; rule: string }[] = [
  { item: 'Raw ticks (XAUUSD)', rule: '14 days; daily partitions are dropped' },
  { item: '1m candles', rule: '180 days' },
  { item: '5m, 15m, 1h, 4h and 1d candles', rule: 'Kept' },
  { item: 'Signals, events, outcomes and reviews', rule: 'Kept forever' },
  {
    item: 'Signal feature snapshots',
    rule: 'Kept in full for 365 days, then trimmed to the essential fields',
  },
  { item: 'Statistics rollups', rule: 'Kept forever' },
  { item: 'Notification outbox', rule: 'Sent: 30 days. Failed or dead: 90 days' },
  { item: 'Gate rejections (the WAIT reasons)', rule: '30 days' },
  { item: 'Feed incidents and maintenance runs', rule: '90 days' },
  { item: 'Sessions and login attempts', rule: 'Expired sessions daily, login attempts 30 days' },
  { item: 'Security audit events', rule: '365 days' },
  { item: 'Macro calendar events', rule: 'Kept' },
  {
    item: 'Headlines',
    rule: '30 days; a headline shown with a signal or a move is copied into it and kept with it',
  },
  { item: 'Market moves', rule: '12 months' },
];

export function storageAt(nowMs: number, warning: boolean): SystemStorage {
  // A full database is a database whose ticks have not been pruned: only the ticks differ.
  const tables = TABLE_SIZES.map(([name, bytes]): { name: string; sizeBytes: number } => ({
    name,
    sizeBytes: name === 'ticks' && warning ? 8_275_000_000 : bytes,
  }));
  const dbSizeBytes = tables.reduce((sum, table) => sum + table.sizeBytes, 0) + OTHER_BYTES;
  return systemStorageSchema.parse({
    dbSizeBytes,
    tables: [...tables].sort((a, b) => b.sizeBytes - a.sizeBytes),
    retention: RETENTION_RULES,
    budgetPct: Math.round((dbSizeBytes / DB_BUDGET_BYTES) * 100),
    lastMaintenanceRun: {
      job: 'retention',
      finishedAt: ago(nowMs, 11 * HOUR_MS),
      rowsDeleted: warning ? 0 : 1_204_331,
    },
  });
}

export function latencyAt(warning: boolean): SystemLatency {
  return systemLatencySchema.parse({
    feedLag: { p50Ms: 180, p95Ms: 420, samples: 14_300 },
    candleToSignal: { p50Ms: 35, p95Ms: 90, samples: 41 },
    dbCommit: { p50Ms: 4, p95Ms: 18, samples: 52_000 },
    notifyDispatch: warning
      ? { p50Ms: 1200, p95Ms: 4200, samples: 38 }
      : { p50Ms: 650, p95Ms: 1900, samples: 38 },
  });
}

/** The settings every strategy has (02_Signal_Engine section 17); the preview shows the same excerpt for all. */
const SHARED_CONFIG = {
  timeframes: { entry: '5m', context: '15m', bias: '1h' },
  gates: {
    maxTickAgeSec: 10,
    maxSpreadUsd: 0.6,
    maxSpreadToStop: 0.12,
    stopAtr: [0.8, 2.0],
    tp1MaxAtr: 2.5,
    newsWindow: { before: 45, after: 20, impact: ['high'], currency: ['USD'] },
  },
  quality: { min: 65, minCoverage: 0.7 },
  policy: { throttles: 'none', dedupe: 'per_setup_instance' },
  advisory: { newsWindow: 'warn', rollover: 'warn', offHours: 'warn', nearLevel: 'warn' },
  risk: {
    simSlippageUsd: 0.05,
    entryValidSec: 180,
    maxChaseAtr: 0.15,
    exitProfile: 'EP1_PARTIAL',
    timeStopMin: 120,
  },
  stats: { minN: 30, lowSampleBelow: 100 },
} as const;

const SETUP_CONFIG: Readonly<Record<StrategyKey, Record<string, number | string>>> = {
  trend_pullback: {
    emaFast: 20,
    emaMid: 50,
    emaSlow: 200,
    minAdx: 22,
    retraceMin: 0.382,
    retraceMax: 0.618,
  },
  sweep_reversal: { sweepLookbackBars: 48, minWickRatio: 0.6, confirmBars: 2 },
  squeeze_retest: { squeezePercentile: 20, breakoutAtr: 0.8, retestBars: 6 },
  trendline_retest: { minTouches: 3, tolerancePct: 0.05 },
  pattern_breakout: { patterns: 'triangle, flag, double top, double bottom', minBars: 12 },
};

const VERSIONS: Readonly<Record<StrategyKey, string>> = {
  trend_pullback: '0.1.0',
  sweep_reversal: '0.1.0',
  squeeze_retest: '0.1.0',
  trendline_retest: '0.0.1',
  pattern_breakout: '0.0.1',
};

/** A, B and C are forward-tested; D and E have no backtest report yet. */
const STATUSES: Readonly<Record<StrategyKey, StrategyStatus>> = {
  trend_pullback: 'FORWARD_TESTING',
  sweep_reversal: 'FORWARD_TESTING',
  squeeze_retest: 'FORWARD_TESTING',
  trendline_retest: 'RESEARCH',
  pattern_breakout: 'RESEARCH',
};

export const strategyVersion = (key: StrategyKey): string => VERSIONS[key];
export const strategyStatusOf = (key: StrategyKey): StrategyStatus => STATUSES[key];

export function strategyConfigFor(key: StrategyKey): StrategyConfigResponse {
  return strategyConfigResponseSchema.parse({
    key,
    version: VERSIONS[key],
    config: { setup: SETUP_CONFIG[key], ...SHARED_CONFIG },
  });
}
