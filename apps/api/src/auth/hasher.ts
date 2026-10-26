import { randomBytes } from 'node:crypto';

import { hash, verify } from '@node-rs/argon2';

import type { Limiter } from './limiter';

export interface ArgonParams {
  /** KiB. */
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

/** Argon2id with 32 MiB, 3 passes, 1 lane: above the OWASP minimum, and about 50 ms on the VM. */
export const PRODUCTION_ARGON: ArgonParams = { memoryCost: 32_768, timeCost: 3, parallelism: 1 };

/** The same minimum as the contract (`passwordChangeRequestSchema`). */
export const SECRET_MIN_LENGTH = 12;

/** Argon2id hashes of the owner's secret, through a `Limiter` so that the memory they use is bounded. */
export class SecretHasher {
  private readonly params: ArgonParams;
  private readonly limiter: Limiter;
  private dummyHash: Promise<string> | null = null;

  constructor(params: ArgonParams, limiter: Limiter) {
    this.params = params;
    this.limiter = limiter;
  }

  hash(secret: string): Promise<string> {
    return this.limiter.run(() => hash(secret, { ...this.params }));
  }

  /** False for a wrong secret and for a text that is not a hash at all. */
  verify(hashed: string, secret: string): Promise<boolean> {
    return this.limiter.run(async () => {
      try {
        return await verify(hashed, secret);
      } catch {
        return false;
      }
    });
  }

  /**
   * A hash nobody knows the secret of, made with the same parameters. A login for a user that does not exist
   * checks against it, so that it takes as long as one for a user that does.
   */
  dummy(): Promise<string> {
    this.dummyHash ??= this.hash(randomBytes(32).toString('base64'));
    return this.dummyHash;
  }
}
