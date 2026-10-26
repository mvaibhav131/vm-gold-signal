import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * Four keys, all derived from `APP_ENCRYPTION_KEY` (32 random bytes) with HKDF and a label each, so that one secret in
 * the `.env` is enough and a key made for one purpose can never be used for another.
 */
export interface AuthKeys {
  /** Hides the address behind `ip_hash`: a keyed hash, because the address space is small enough to brute-force a plain one. */
  readonly ip: Buffer;
  readonly userAgent: Buffer;
  /** AES-256-GCM key of the TOTP secret. */
  readonly totp: Buffer;
  /** Hashes the recovery codes: they are short, so a plain hash would fall to an offline guess if the table leaked. */
  readonly recovery: Buffer;
}

/** 32 bytes as base64 (44 characters) or hex (64 characters), the two forms `APP_ENCRYPTION_KEY` may have. */
export function parseMasterKey(text: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(text)
    ? Buffer.from(text, 'hex')
    : Buffer.from(text, 'base64');
  if (key.length !== 32) throw new Error('the encryption key must be 32 bytes');
  return key;
}

function derive(master: Buffer, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, 'vmgs-auth-v1', label, 32));
}

export function deriveKeys(master: Buffer): AuthKeys {
  return {
    ip: derive(master, 'ip-hash'),
    userAgent: derive(master, 'user-agent-hash'),
    totp: derive(master, 'totp-secret'),
    recovery: derive(master, 'recovery-code'),
  };
}

export function hmacHex(key: Buffer, text: string): string {
  return createHmac('sha256', key).update(text).digest('hex');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Equal text, compared in constant time (both sides are hashed first, so the lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}
