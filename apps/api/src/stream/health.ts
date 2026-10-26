import type { MarketFacts, MarketReader } from '../market/reader';
import { snapshotOf } from '../market/snapshot';
import { ProblemError } from '../http/problem';
import { heartbeatIsCurrent } from '../system/logic';
import type { HealthFacts, SystemReader } from '../system/reader';
import type { Health, HealthPort } from './publisher';

const HOUR_MS = 3_600_000;

/** A nightly backup is fresh for a day and a half, and a missed night is a warning; three are a failure. */
export const BACKUP_OK_MS = 36 * HOUR_MS;
export const BACKUP_DOWN_MS = 72 * HOUR_MS;

type Level = Health[string];

/**
 * One word for each part of the system, for the `health` event (04 section 3): the same facts as `GET /system/health`
 * and `GET /market/snapshot`, so that a screen that listens and a screen that asks agree. A part that cannot be judged
 * is `UNKNOWN`, never `OK`.
 */
export function healthMapOf(health: HealthFacts, market: MarketFacts, now: number): Health {
  const workerAlive = heartbeatIsCurrent(health.workerHeartbeatAt, now);

  let feed: Level = 'UNKNOWN';
  try {
    switch (snapshotOf(market, now).feedState) {
      case 'LIVE':
      case 'MARKET_CLOSED':
        feed = 'OK';
        break;
      case 'STALE':
      case 'WARMING_UP':
        feed = 'DEGRADED';
        break;
      case 'DISCONNECTED':
        feed = 'DOWN';
        break;
    }
  } catch (error) {
    // no quote yet: nothing can be said about the feed
    if (!(error instanceof ProblemError)) throw error;
  }

  const backupAge = health.backupAt === null ? null : now - health.backupAt;
  let backup: Level = 'UNKNOWN';
  if (backupAge !== null) {
    backup = backupAge <= BACKUP_OK_MS ? 'OK' : backupAge <= BACKUP_DOWN_MS ? 'DEGRADED' : 'DOWN';
  }

  let telegram: Level = 'UNKNOWN';
  if (health.telegramLastError !== null) telegram = 'DEGRADED';
  else if (health.telegramLastSendAt !== null) telegram = 'OK';

  let worker: Level = 'UNKNOWN';
  if (health.workerHeartbeatAt !== null) worker = workerAlive ? 'OK' : 'DOWN';

  return {
    database: health.dbReachable ? 'OK' : 'DOWN',
    worker,
    feed,
    telegram,
    backup,
  };
}

export function healthPortOf(market: MarketReader, system: SystemReader): HealthPort {
  return {
    async read(now) {
      const [health, facts] = await Promise.all([system.health(now), market.facts(now)]);
      return healthMapOf(health, facts, now);
    },
  };
}
