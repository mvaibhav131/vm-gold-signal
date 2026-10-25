import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/** The one-time code of `/link` lives for ten minutes (04_API_and_Notifications section 4, "Setup and security"). */
export const LINK_TTL_MS = 600_000;
/** Wrong guesses a code survives. Eight digits are 10^8 codes, so five guesses are not a way in. */
export const LINK_MAX_ATTEMPTS = 5;

/** What is kept of a code: a hash, never the code (`app_settings.telegramLink`). */
export interface PendingLink {
  readonly hash: string;
  readonly expiresAt: number;
  readonly attempts: number;
}

export function newLinkCode(random: (min: number, max: number) => number = randomInt): string {
  return String(random(0, 100_000_000)).padStart(8, '0');
}

export const formatLinkCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

const hashOf = (code: string): string =>
  createHash('sha256').update(`vmgs-telegram-link:${code}`).digest('hex');

export function issueLink(code: string, now: number): PendingLink {
  return { hash: hashOf(code), expiresAt: now + LINK_TTL_MS, attempts: 0 };
}

export type LinkCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'expired' | 'wrong';
      /** What to keep after this try: null means the code is spent and is forgotten. */
      readonly next: PendingLink | null;
    };

/** A code works once (the caller forgets it on success), before it expires, and not after too many wrong guesses. */
export function checkLink(pending: PendingLink, code: string, now: number): LinkCheck {
  if (now >= pending.expiresAt) return { ok: false, reason: 'expired', next: null };
  const given = Buffer.from(hashOf(code), 'hex');
  const kept = Buffer.from(pending.hash, 'hex');
  if (given.length === kept.length && timingSafeEqual(given, kept)) return { ok: true };
  const attempts = pending.attempts + 1;
  return {
    ok: false,
    reason: 'wrong',
    next: attempts >= LINK_MAX_ATTEMPTS ? null : { ...pending, attempts },
  };
}
