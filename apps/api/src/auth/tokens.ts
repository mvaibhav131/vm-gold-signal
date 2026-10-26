import { randomBytes } from 'node:crypto';

import { sha256Hex } from './keys';

/** 32 random bytes as base64url (43 characters): the only thing the browser holds. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Whether a cookie value can be a session token at all; anything else is treated as no cookie. */
export function isSessionToken(value: string | undefined): value is string {
  return value !== undefined && TOKEN_SHAPE.test(value);
}

/**
 * What the database keeps (`auth_sessions.id_hash`). The token has 256 bits, so a plain SHA-256 is enough: a copy of
 * the table cannot be turned back into a cookie.
 */
export function sessionIdHash(token: string): string {
  return sha256Hex(`vmgs-session:${token}`);
}

/** What the sessions list shows and `DELETE /auth/sessions/:id` takes: the first 16 characters of the hash. */
export const PUBLIC_ID_LENGTH = 16;

export function publicSessionId(idHash: string): string {
  return idHash.slice(0, PUBLIC_ID_LENGTH);
}

export const PUBLIC_ID_SHAPE = /^[0-9a-f]{16}$/;
