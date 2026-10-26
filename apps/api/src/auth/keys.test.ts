import { describe, expect, it } from 'vitest';

import { deriveKeys, hmacHex, parseMasterKey, safeEqual, sha256Hex } from './keys';
import { TOTP_CONTEXT, open, seal } from './secretbox';

const MASTER_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const MASTER_B64 = Buffer.from(MASTER_HEX, 'hex').toString('base64');

describe('parseMasterKey', () => {
  it('reads 32 bytes as hex or as base64, to the same key', () => {
    expect(parseMasterKey(MASTER_HEX).toString('hex')).toBe(MASTER_HEX);
    expect(parseMasterKey(MASTER_B64).toString('hex')).toBe(MASTER_HEX);
  });

  it('refuses any other length', () => {
    expect(() => parseMasterKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseMasterKey('')).toThrow(/32 bytes/);
  });
});

describe('deriveKeys', () => {
  const keys = deriveKeys(parseMasterKey(MASTER_HEX));

  it('makes four 32 byte keys that differ from each other and from the master', () => {
    const all = [keys.ip, keys.userAgent, keys.totp, keys.recovery].map((key) =>
      key.toString('hex'),
    );
    expect(new Set([...all, MASTER_HEX]).size).toBe(5);
    for (const key of all) expect(key).toHaveLength(64);
  });

  it('is the same for the same master and different for another', () => {
    expect(deriveKeys(parseMasterKey(MASTER_HEX)).totp.equals(keys.totp)).toBe(true);
    const other = deriveKeys(Buffer.alloc(32, 7));
    expect(other.totp.equals(keys.totp)).toBe(false);
  });
});

describe('hashing helpers', () => {
  it('hmacHex depends on the key and the text', () => {
    const a = Buffer.alloc(32, 1);
    const b = Buffer.alloc(32, 2);
    expect(hmacHex(a, 'x')).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacHex(a, 'x')).toBe(hmacHex(a, 'x'));
    expect(hmacHex(a, 'x')).not.toBe(hmacHex(b, 'x'));
    expect(hmacHex(a, 'x')).not.toBe(hmacHex(a, 'y'));
  });

  it('sha256Hex is SHA-256', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('safeEqual compares text of any length', () => {
    expect(safeEqual('owner', 'owner')).toBe(true);
    expect(safeEqual('owner', 'Owner')).toBe(false);
    expect(safeEqual('owner', 'owner ')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('a', 'a'.repeat(10_000))).toBe(false);
  });
});

describe('seal and open (AES-256-GCM)', () => {
  const key = deriveKeys(parseMasterKey(MASTER_HEX)).totp;
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

  it('gives the text back', () => {
    expect(open(key, seal(key, secret, TOTP_CONTEXT), TOTP_CONTEXT)).toBe(secret);
  });

  it('does not show the text, and is different every time (a fresh iv)', () => {
    const one = seal(key, secret, TOTP_CONTEXT);
    const two = seal(key, secret, TOTP_CONTEXT);
    expect(one.toString('utf8')).not.toContain(secret);
    expect(one.equals(two)).toBe(false);
    expect(one[0]).toBe(1); // version
  });

  it('refuses a blob that was changed anywhere, cut short, or made for another key or context', () => {
    const blob = seal(key, secret, TOTP_CONTEXT);
    for (let i = 0; i < blob.length; i += 1) {
      const changed = Buffer.from(blob);
      changed[i] = (changed[i] ?? 0) ^ 1;
      expect(open(key, changed, TOTP_CONTEXT), `byte ${String(i)}`).toBeNull();
    }
    expect(open(key, blob.subarray(0, blob.length - 1), TOTP_CONTEXT)).toBeNull();
    expect(open(key, Buffer.alloc(5), TOTP_CONTEXT)).toBeNull();
    expect(open(Buffer.alloc(32, 9), blob, TOTP_CONTEXT)).toBeNull();
    expect(open(key, blob, 'vmgs:something.else')).toBeNull();
  });
});
