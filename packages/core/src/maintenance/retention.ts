/** The retention of 01_HLD section 7, in days: the nightly job deletes what is older. What is not here is kept. */
export const RETENTION_DAYS = {
  /** Raw ticks: daily partitions, a whole old day is dropped. The size guard may shorten this (see `TICK_RETENTION_LADDER`). */
  ticks: 14,
  candles1m: 180,
  /** After this a signal's feature snapshot is replaced by a marker (the signal itself is kept for ever). */
  snapshots: 365,
  outboxSent: 30,
  /** Failed, dead and expired messages. */
  outboxFailed: 90,
  rejections: 30,
  feedIncidents: 90,
  maintenanceRuns: 90,
  loginAttempts: 30,
  securityAudit: 365,
  headlines: 30,
  /** Twelve months. */
  marketEvents: 365,
} as const;

export const DAY_MS = 86_400_000;

/** The instant before which something is older than `days` days at `now` (what is exactly that old is kept). */
export const cutoffOf = (now: number, days: number): number => now - days * DAY_MS;
