export interface SessionPolicy {
  /** A session ends this long after it was last used... */
  readonly idleMs: number;
  /** ...and in any case this long after the login. */
  readonly maxMs: number;
  /** The last use is written at most this often (every request would be a write). */
  readonly touchEveryMs: number;
}

const DAY_MS = 86_400_000;

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  idleMs: 7 * DAY_MS,
  maxMs: 30 * DAY_MS,
  touchEveryMs: 10 * 60_000,
};

export function sessionExpiry(createdAt: number, now: number, policy: SessionPolicy): number {
  return Math.min(createdAt + policy.maxMs, now + policy.idleMs);
}

/** What the purge job removes (06 section 4 and 01 section 7). */
export interface PurgePolicy {
  readonly expiredSessionsMs: number;
  readonly revokedSessionsMs: number;
  readonly loginAttemptsMs: number;
  readonly auditMs: number;
}

export const DEFAULT_PURGE_POLICY: PurgePolicy = {
  expiredSessionsMs: DAY_MS,
  revokedSessionsMs: 7 * DAY_MS,
  loginAttemptsMs: 30 * DAY_MS,
  auditMs: 365 * DAY_MS,
};
