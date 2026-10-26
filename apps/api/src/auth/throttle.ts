export interface ThrottlePolicy {
  readonly windowMs: number;
  /** Failures of one client (an IPv4 address or an IPv6 /64) in the window, after its last success. */
  readonly maxFailuresPerClient: number;
  /**
   * Failures of everybody in the window, which stop every client that has never got in. Guessing from many addresses
   * cannot go faster than this (the per-client limit alone would let it grow with the number of addresses). A client
   * that has got in before (the owner's phone, the owner's home) is not stopped by it, only by its own limit: otherwise
   * a swarm that scans the internet for logins, or one that keeps 40 failures in every window on purpose, would keep
   * the owner out for good. A change that needs a session (password, second step) is not stopped by it either.
   */
  readonly maxFailuresTotal: number;
  /** A client is known when it got in at some time in this long. */
  readonly knownMs: number;
}

export const DEFAULT_THROTTLE: ThrottlePolicy = {
  windowMs: 15 * 60_000,
  maxFailuresPerClient: 5,
  maxFailuresTotal: 40,
  knownMs: 30 * 86_400_000,
};

export type ThrottleDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number };

/**
 * `client` and `total` are the times of the newest failures (at most the limit of each, oldest first) that are still
 * inside the window. At the limit the oldest of them leaving the window is what lets the next attempt in. `total`
 * is left out when the caller says so (an empty list) and does not count for a client that is `known`.
 */
export function decideThrottle(
  client: readonly number[],
  total: readonly number[],
  now: number,
  policy: ThrottlePolicy = DEFAULT_THROTTLE,
  known = false,
): ThrottleDecision {
  const frees: number[] = [];
  const clientOldest = client[0];
  if (client.length >= policy.maxFailuresPerClient && clientOldest !== undefined) {
    frees.push(clientOldest + policy.windowMs);
  }
  const totalOldest = total[0];
  if (!known && total.length >= policy.maxFailuresTotal && totalOldest !== undefined) {
    frees.push(totalOldest + policy.windowMs);
  }
  if (frees.length === 0) return { allowed: true };
  return { allowed: false, retryAfterMs: Math.max(1000, Math.max(...frees) - now) };
}
