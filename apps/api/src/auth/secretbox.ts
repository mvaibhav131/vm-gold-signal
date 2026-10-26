import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM for the TOTP secret (01 section 8). The blob is version, iv, cipher text, tag. `context` is
 * authenticated but not stored: a blob made for one purpose does not open for another, and nothing can be changed
 * in it without the opening failing.
 */
export function seal(key: Buffer, plaintext: string, context: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, encrypted, cipher.getAuthTag()]);
}

/** The text that `seal` sealed, or null when the blob is not intact, not for this context or not for this key. */
export function open(key: Buffer, blob: Buffer, context: string): string | null {
  if (blob.length < 1 + IV_BYTES + TAG_BYTES || blob[0] !== VERSION) return null;
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const encrypted = blob.subarray(1 + IV_BYTES, blob.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export const TOTP_CONTEXT = 'vmgs:auth_owner.totp_secret';
