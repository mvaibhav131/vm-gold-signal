import { randomInt } from 'node:crypto';

import { hmacHex } from './keys';

/** No `i`, `l`, `o`, `0` or `1`: the codes are read from a screen or a sheet of paper and typed by hand. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const RECOVERY_CODE_COUNT = 8;
const SHAPE = /^[a-z0-9]{4}-[a-z0-9]{4}$/;

function group(): string {
  let text = '';
  for (let i = 0; i < 4; i += 1) text += ALPHABET.charAt(randomInt(ALPHABET.length));
  return text;
}

/** Eight codes like `k7m2-q9x4`, each usable once when the authenticator app is not at hand. */
export function newRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) codes.add(`${group()}-${group()}`);
  return [...codes];
}

/** The code as the table keeps it, or null when the text is not shaped like a recovery code. */
export function recoveryCodeHash(key: Buffer, text: string): string | null {
  const code = text.trim().toLowerCase();
  return SHAPE.test(code) ? hmacHex(key, `recovery:${code}`) : null;
}
