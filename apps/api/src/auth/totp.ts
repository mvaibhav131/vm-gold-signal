import { generateSecret, generateURI, verify } from 'otplib';

export const TOTP_ISSUER = 'VM Gold Signal';

export function newTotpSecret(): string {
  return generateSecret();
}

/** The link an authenticator app reads (it is also drawn as a QR code by the app of the owner's choice). */
export function totpUri(secret: string, username: string): string {
  return generateURI({ issuer: TOTP_ISSUER, label: username, secret });
}

const PERIOD_S = 30;

/** The step (30 seconds since 1970) a code was made for, or null when the code is not right now or one step either side. */
export async function totpStep(
  secret: string,
  code: string,
  nowMs: number,
): Promise<number | null> {
  const epoch = Math.floor(nowMs / 1000);
  try {
    const result = await verify({ secret, token: code, epoch, epochTolerance: PERIOD_S });
    // `delta` is how many steps the code is from now (-1, 0 or 1)
    return result.valid ? Math.floor(epoch / PERIOD_S) + result.delta : null;
  } catch {
    return null;
  }
}

/**
 * A code works once. The step of the last code that was accepted is kept, and a code for that step or an earlier one
 * is refused, so that a code read over the owner's shoulder is no good a second later. The check and the update are one
 * synchronous step: two requests with the same code cannot both pass. It lives in the memory of the one API process
 * (a restart forgets it, which reopens the window for at most 90 seconds).
 */
export class TotpReplayGuard {
  private last = -1;

  accept(step: number): boolean {
    if (step <= this.last) return false;
    this.last = step;
    return true;
  }
}
