import type { SystemHealth } from '@vmgs/contracts';
import type { FeedState } from '@vmgs/core';

import { formatSpan } from '../format/time';

export type HealthLevel = 'OK' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';

/**
 * The limits behind the words OK, DEGRADED and DOWN. They follow the engine's own rules: a tick
 * older than 10 s blocks signals (gate DATA_FRESH), a skew of 5 s or more blocks them (CLOCK_OK),
 * and a worker that has not answered for 60 s is not ready (04_API_and_Notifications, Health).
 */
export const LIMITS = {
  feedAgeOkMs: 10_000,
  feedAgeDegradedMs: 60_000,
  heartbeatOkMs: 60_000,
  heartbeatDegradedMs: 180_000,
  eventLoopOkMs: 100,
  eventLoopDegradedMs: 500,
  skewOkMs: 2000,
  skewDegradedMs: 5000,
  /** A nightly job that has not run for a day and a half has missed a night. */
  nightlyMaxAgeMs: 36 * 3_600_000,
} as const;

export interface HealthCheck {
  readonly key: string;
  readonly label: string;
  /** What was measured, in words. */
  readonly value: string;
  /** Null for a number that is shown for information only. */
  readonly level: HealthLevel | null;
}

/** `0.4 s` under 10 seconds, otherwise `18 s`, `5 min`, `2 h 10 min`. */
export function formatTickAge(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : formatSpan(ms / 1000);
}

const ago = (iso: string, nowMs: number) =>
  `${formatSpan(Math.max(0, nowMs - Date.parse(iso)) / 1000)} ago`;

/** Within `okMs` is OK, within `degradedMs` is DEGRADED, longer is DOWN. */
function byLimit(value: number, okMs: number, degradedMs: number): HealthLevel {
  if (value <= okMs) return 'OK';
  return value <= degradedMs ? 'DEGRADED' : 'DOWN';
}

const FEED_LABELS: Readonly<Record<FeedState, string>> = {
  LIVE: 'Live',
  STALE: 'Stale',
  DISCONNECTED: 'Disconnected',
  MARKET_CLOSED: 'Market closed',
  WARMING_UP: 'Warming up',
};

function feedCheck(health: SystemHealth, feedState: FeedState | undefined): HealthCheck {
  const age = health.feedAgeMs;
  const base = { key: 'feed', label: 'Price feed' } as const;
  // A closed market has no ticks: that is not a fault.
  if (feedState === 'MARKET_CLOSED') {
    return { ...base, value: 'Market closed, no ticks expected', level: 'OK' };
  }
  if (feedState === 'DISCONNECTED') {
    return {
      ...base,
      value: `Disconnected${age === null ? '' : `, last tick ${formatTickAge(age)} ago`}`,
      level: 'DOWN',
    };
  }
  const lead = feedState === undefined ? '' : `${FEED_LABELS[feedState]}, `;
  if (age === null) {
    return {
      ...base,
      value: feedState === undefined ? 'No tick received yet' : `${lead}no tick received yet`,
      level: 'UNKNOWN',
    };
  }
  let level = byLimit(age, LIMITS.feedAgeOkMs, LIMITS.feedAgeDegradedMs);
  // A feed that says it is stale or warming up is not fine, whatever the age of the last tick.
  if (level === 'OK' && (feedState === 'STALE' || feedState === 'WARMING_UP')) level = 'DEGRADED';
  return {
    ...base,
    value: `${lead === '' ? 'Newest tick' : `${lead}newest tick`} ${formatTickAge(age)} ago`,
    level,
  };
}

function nightlyCheck(
  key: string,
  label: string,
  iso: string | null,
  nowMs: number,
  none: string,
): HealthCheck {
  if (iso === null) return { key, label, value: none, level: 'UNKNOWN' };
  const level = nowMs - Date.parse(iso) <= LIMITS.nightlyMaxAgeMs ? 'OK' : 'DEGRADED';
  return { key, label, value: ago(iso, nowMs), level };
}

/** The nine rows of the Health tab, each with a value in words and a level (or none for a number that is only informative). */
export function healthChecks(
  health: SystemHealth,
  feedState: FeedState | undefined,
  nowMs: number,
): HealthCheck[] {
  const heartbeat = health.workerHeartbeatAt;
  const skew = health.clockSkewMs;
  const send = health.telegram.lastSendAt;
  const telegram: HealthCheck =
    health.telegram.lastError !== null
      ? {
          key: 'telegram',
          label: 'Telegram',
          value: `${health.telegram.lastError}${send === null ? '' : `. Last send ${ago(send, nowMs)}`}`,
          level: 'DEGRADED',
        }
      : send === null
        ? { key: 'telegram', label: 'Telegram', value: 'No message sent yet', level: 'UNKNOWN' }
        : {
            key: 'telegram',
            label: 'Telegram',
            value: `Last send ${ago(send, nowMs)}`,
            level: 'OK',
          };

  return [
    feedCheck(health, feedState),
    {
      key: 'ticks',
      label: 'Ticks per second',
      value:
        health.ticksPerSecond === null
          ? 'Not known'
          : `${health.ticksPerSecond.toFixed(1)} per second`,
      level: null,
    },
    heartbeat === null
      ? { key: 'worker', label: 'Worker', value: 'No heartbeat received yet', level: 'UNKNOWN' }
      : {
          key: 'worker',
          label: 'Worker',
          value: `Heartbeat ${ago(heartbeat, nowMs)}`,
          level: byLimit(
            nowMs - Date.parse(heartbeat),
            LIMITS.heartbeatOkMs,
            LIMITS.heartbeatDegradedMs,
          ),
        },
    health.eventLoopLagMs === null
      ? { key: 'loop', label: 'Event-loop lag', value: 'Not measured yet', level: 'UNKNOWN' }
      : {
          key: 'loop',
          label: 'Event-loop lag',
          value: `${String(Math.round(health.eventLoopLagMs))} ms`,
          level: byLimit(health.eventLoopLagMs, LIMITS.eventLoopOkMs, LIMITS.eventLoopDegradedMs),
        },
    {
      key: 'db',
      label: 'Database',
      value: health.dbReachable ? 'Reachable' : 'Not reachable',
      level: health.dbReachable ? 'OK' : 'DOWN',
    },
    telegram,
    skew === null
      ? { key: 'clock', label: 'Clock skew', value: 'Not measured yet', level: 'UNKNOWN' }
      : {
          key: 'clock',
          label: 'Clock skew',
          value: `${skew > 0 ? '+' : ''}${String(Math.round(skew))} ms against the feed time`,
          level: byLimit(Math.abs(skew), LIMITS.skewOkMs, LIMITS.skewDegradedMs),
        },
    nightlyCheck('backup', 'Last backup', health.lastBackupAt, nowMs, 'No backup yet'),
    nightlyCheck('maintenance', 'Last maintenance', health.lastMaintenanceAt, nowMs, 'No run yet'),
  ];
}

/** How many checks are not fine, and how many are not known yet. Informational rows do not count. */
export function summarizeChecks(checks: readonly HealthCheck[]): {
  attention: number;
  unknown: number;
} {
  return {
    attention: checks.filter((check) => check.level === 'DEGRADED' || check.level === 'DOWN')
      .length,
    unknown: checks.filter((check) => check.level === 'UNKNOWN').length,
  };
}

const KB = 1000;
const MB = KB * 1000;
const GB = MB * 1000;

/** Sizes in the decimal units of a disk (`1.14 GB`, `612 MB`, `3.5 MB`): the way the storage budget is quoted. */
export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) {
    const mb = bytes / MB;
    return `${mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1)} MB`;
  }
  if (bytes >= KB) return `${String(Math.round(bytes / KB))} kB`;
  return `${String(bytes)} B`;
}

export type BudgetLevel = 'OK' | 'FILLING' | 'FULL';

/** From 80% the maintenance job starts to act (shorter tick retention, a Telegram warning); from 100% the soft limit is passed. */
export function budgetLevel(pct: number): BudgetLevel {
  if (pct >= 100) return 'FULL';
  return pct >= 80 ? 'FILLING' : 'OK';
}
