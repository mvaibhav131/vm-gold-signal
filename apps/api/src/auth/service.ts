import type {
  LoginRequest,
  MeResponse,
  PasswordChangeRequest,
  SessionsResponse,
  TotpEnableResponse,
  TotpSetupResponse,
} from '@vmgs/contracts';

import { ProblemError } from '../http/problem';
import { clientKey } from './client';
import type { SecretHasher } from './hasher';
import { type AuthKeys, hmacHex, safeEqual } from './keys';
import { BusyError, Limiter } from './limiter';
import { DEFAULT_SESSION_POLICY, sessionExpiry, type SessionPolicy } from './policy';
import { newRecoveryCodes, recoveryCodeHash } from './recovery';
import { TOTP_CONTEXT, open, seal } from './secretbox';
import type { AuditEvent, AuthStore, OwnerRow, OwnerState } from './store';
import { DEFAULT_THROTTLE, decideThrottle, type ThrottlePolicy } from './throttle';
import {
  PUBLIC_ID_SHAPE,
  isSessionToken,
  newSessionToken,
  publicSessionId,
  sessionIdHash,
} from './tokens';
import { TotpReplayGuard, newTotpSecret, totpStep, totpUri } from './totp';

export interface AuthServiceDeps {
  readonly store: AuthStore;
  readonly hasher: SecretHasher;
  readonly keys: AuthKeys;
  readonly now: () => number;
  readonly session?: SessionPolicy;
  readonly throttle?: ThrottlePolicy;
}

/** Who sent a request. The address is hashed with a key before anything is stored. */
export interface ClientInfo {
  readonly ip: string;
  readonly userAgent: string | undefined;
}

/** The session of a request. `id` is what the sessions list shows (the first 16 characters of the stored hash). */
export interface AuthSession {
  readonly idHash: string;
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface Authenticated {
  readonly session: AuthSession;
  /** Set when the session was extended: the cookie is sent again with this lifetime (seconds). */
  readonly cookieMaxAgeS: number | null;
}

export interface LoggedIn {
  readonly token: string;
  readonly session: AuthSession;
  readonly cookieMaxAgeS: number;
}

const THROTTLED = 'Too many failed attempts. Try again later.';
const SIX_DIGITS = /^\d{6}$/;
const MAX_AUDITED_THROTTLES = 1000;

function rateLimited(retryAfterMs: number): ProblemError {
  return new ProblemError(429, 'rate_limited', THROTTLED, {
    'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
  });
}

/**
 * The rules of 01 section 8 and 04 section 2 (Auth), without any HTTP. One owner, opaque sessions kept as hashes,
 * one answer for every failed login, attempts counted in the database before they are judged, and a second step that
 * is optional and works once per code.
 */
export class AuthService {
  private readonly store: AuthStore;
  private readonly hasher: SecretHasher;
  private readonly keys: AuthKeys;
  private readonly now: () => number;
  private readonly sessionPolicy: SessionPolicy;
  private readonly throttle: ThrottlePolicy;
  private readonly replay = new TotpReplayGuard();
  /** The tries that read the counts and write themselves down: bounded, so that a flood cannot queue up at the database. */
  private readonly admissions = new Limiter(8, 64);
  /** When a throttled client was last written to the audit: one line per client and window, not one per request. */
  private readonly auditedThrottle = new Map<string, number>();

  constructor(deps: AuthServiceDeps) {
    this.store = deps.store;
    this.hasher = deps.hasher;
    this.keys = deps.keys;
    this.now = deps.now;
    this.sessionPolicy = deps.session ?? DEFAULT_SESSION_POLICY;
    this.throttle = deps.throttle ?? DEFAULT_THROTTLE;
  }

  /**
   * Made ready before the first request: the hash that a login for a user that does not exist is checked against. Made
   * on the first such login it would cost that one login a second hash, and tell that nobody has been made yet.
   */
  async warmUp(): Promise<void> {
    await this.hasher.dummy();
  }

  private ipHash(client: ClientInfo): string {
    return hmacHex(this.keys.ip, clientKey(client.ip));
  }

  private async audit(event: AuditEvent): Promise<void> {
    await this.store.audit(event, this.now());
  }

  // ---- the session of a request ------------------------------------------------------------------------------

  /** The session of a cookie value, or null. A session that is in use for a while is extended (sliding expiry). */
  async authenticate(token: string | undefined): Promise<Authenticated | null> {
    if (!isSessionToken(token)) return null;
    const idHash = sessionIdHash(token);
    const now = this.now();
    const row = await this.store.session(idHash, now);
    if (row === null) return null;
    let expiresAt = row.expiresAt;
    let cookieMaxAgeS: number | null = null;
    if (now - row.lastSeenAt >= this.sessionPolicy.touchEveryMs) {
      expiresAt = sessionExpiry(row.createdAt, now, this.sessionPolicy);
      await this.store.touchSession(idHash, now, expiresAt);
      cookieMaxAgeS = Math.max(1, Math.floor((expiresAt - now) / 1000));
    }
    return {
      session: { idHash, id: publicSessionId(idHash), createdAt: row.createdAt, expiresAt },
      cookieMaxAgeS,
    };
  }

  /** A new session, if the owner is still as the login found it (a change that came meanwhile refuses it: null). */
  private async newSession(
    client: ClientInfo,
    now: number,
    expected: OwnerState,
  ): Promise<LoggedIn | null> {
    const token = newSessionToken();
    const idHash = sessionIdHash(token);
    const expiresAt = sessionExpiry(now, now, this.sessionPolicy);
    const created = await this.store.createSession(
      {
        idHash,
        at: now,
        expiresAt,
        ipHash: this.ipHash(client),
        userAgentHash:
          client.userAgent === undefined ? null : hmacHex(this.keys.userAgent, client.userAgent),
      },
      expected,
    );
    if (!created) return null;
    return {
      token,
      session: { idHash, id: publicSessionId(idHash), createdAt: now, expiresAt },
      cookieMaxAgeS: Math.floor((expiresAt - now) / 1000),
    };
  }

  // ---- attempts ---------------------------------------------------------------------------------------------------

  /**
   * Every try of a secret (login, current password, code of the second step) passes here. It refuses the try when
   * the client has failed too often, or, for a login of a client that has never got in, when everybody together has
   * (`scope` is `session` for a try that needs a session: that one is not stopped by the failures of others);
   * otherwise it writes the try down as a failure at once. The caller turns it into a success when it is one.
   */
  private async admit(
    client: ClientInfo,
    scope: 'login' | 'session',
  ): Promise<{ ipHash: string; attemptId: number }> {
    const now = this.now();
    const ipHash = this.ipHash(client);
    const total = scope === 'login' ? this.throttle.maxFailuresTotal : 0;
    const admission = await this.guarded(() =>
      this.admissions.run(() =>
        this.store.admit(
          ipHash,
          now,
          {
            since: now - this.throttle.windowMs,
            clientLimit: this.throttle.maxFailuresPerClient,
            totalLimit: total,
            knownSince: now - this.throttle.knownMs,
          },
          (own, all, known) => decideThrottle(own, all, now, this.throttle, known),
        ),
      ),
    );
    if (!admission.allowed) {
      await this.auditThrottled(ipHash, now);
      throw rateLimited(admission.retryAfterMs);
    }
    return { ipHash, attemptId: admission.attemptId };
  }

  /** At most a thousand clients at a time are remembered (and so audited): an address is free for a flood to make up. */
  private async auditThrottled(ipHash: string, now: number): Promise<void> {
    const last = this.auditedThrottle.get(ipHash);
    if (last !== undefined && now - last < this.throttle.windowMs) return;
    for (const [key, at] of this.auditedThrottle) {
      if (now - at >= this.throttle.windowMs) this.auditedThrottle.delete(key);
    }
    if (this.auditedThrottle.size >= MAX_AUDITED_THROTTLES) return;
    this.auditedThrottle.set(ipHash, now);
    await this.store.audit({ type: 'LOGIN_THROTTLED', success: false, ipHash }, now);
  }

  /** Runs password checks, and turns a full queue of them into the answer for a client that asks too much. */
  private async guarded<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (error instanceof BusyError) throw rateLimited(5000);
      throw error;
    }
  }

  // ---- login and logout -----------------------------------------------------------------------------------------

  /** The second step of a login: the code of the app (once per step) or a recovery code (once). */
  private async secondStep(
    owner: OwnerRow,
    code: string | undefined,
    now: number,
  ): Promise<{ ok: boolean; step: number | null; recoveryHash: string | null }> {
    if (!owner.totpEnabled) return { ok: true, step: null, recoveryHash: null };
    const text = code ?? '';
    // Both ways are always worked out, so that the time taken does not tell which one was tried.
    const secret =
      owner.totpSecretEnc === null ? null : open(this.keys.totp, owner.totpSecretEnc, TOTP_CONTEXT);
    const step =
      secret !== null && SIX_DIGITS.test(text) ? await totpStep(secret, text, now) : null;
    const hash = recoveryCodeHash(this.keys.recovery, text);
    const recoveryHash =
      hash !== null && owner.recoveryCodeHashes.some((stored) => safeEqual(stored, hash))
        ? hash
        : null;
    return { ok: step !== null || recoveryHash !== null, step, recoveryHash };
  }

  /**
   * Logs in. Every failure is the same 401 (04 section 2): a wrong user name, a wrong password, a missing or wrong
   * code. The password is checked even for a wrong user name, against a hash of the same cost.
   */
  async login(input: LoginRequest, client: ClientInfo): Promise<LoggedIn> {
    const { ipHash, attemptId } = await this.admit(client, 'login');
    const now = this.now();
    const owner = await this.store.owner();
    const passwordOk = await this.guarded(async () =>
      this.hasher.verify(owner?.passwordHash ?? (await this.hasher.dummy()), input.password),
    );
    const userOk = owner !== null && safeEqual(input.username, owner.username);
    const second =
      owner === null
        ? { ok: false, step: null, recoveryHash: null }
        : await this.secondStep(owner, input.totp, now);

    let ok = passwordOk && userOk && second.ok;
    // the codes are used up only by a login that is right in everything else
    if (ok && second.step !== null) ok = this.replay.accept(second.step);
    if (ok && second.recoveryHash !== null)
      ok = await this.store.useRecoveryCode(second.recoveryHash);
    // The session is made only if the owner is still as it was when the password was checked: a password change or a
    // second step that came while the hash was being worked out refuses it, so no session outlives such a change.
    const session =
      ok && owner !== null
        ? await this.newSession(client, now, {
            passwordHash: owner.passwordHash,
            totpEnabled: owner.totpEnabled,
            totpSecretEnc: owner.totpSecretEnc,
          })
        : null;
    if (session === null) {
      await this.audit({ type: 'LOGIN', success: false, ipHash });
      throw new ProblemError(401, 'invalid_credentials', 'Login failed.');
    }

    await this.store.succeedAttempt(attemptId);
    await this.audit({ type: 'LOGIN', success: true, ipHash });
    if (second.recoveryHash !== null) {
      await this.audit({ type: 'RECOVERY_CODE_USED', success: true, ipHash });
    }
    return session;
  }

  async logout(session: AuthSession, client: ClientInfo): Promise<void> {
    await this.store.revoke(session.idHash, this.now());
    await this.audit({ type: 'LOGOUT', success: true, ipHash: this.ipHash(client) });
  }

  /** Ends a session by its cookie value (the one a new login replaces). It never fails for a value that is not a session. */
  async endToken(token: string | undefined): Promise<void> {
    if (isSessionToken(token)) await this.store.revoke(sessionIdHash(token), this.now());
  }

  async me(session: AuthSession): Promise<MeResponse> {
    const owner = await this.requireOwner();
    return {
      username: owner.username,
      totpEnabled: owner.totpEnabled,
      sessionExpiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  private async requireOwner(): Promise<OwnerRow> {
    const owner = await this.store.owner();
    // a session without an owner cannot exist; fail closed if it somehow does
    if (owner === null)
      throw new ProblemError(401, 'unauthenticated', 'There is no valid session.');
    return owner;
  }

  // ---- password ---------------------------------------------------------------------------------------------------

  /** Changes the password and ends every other session. A wrong current password counts as a failed attempt. */
  async changePassword(
    session: AuthSession,
    request: PasswordChangeRequest,
    client: ClientInfo,
  ): Promise<void> {
    const { ipHash, attemptId } = await this.admit(client, 'session');
    const owner = await this.requireOwner();
    const ok = await this.guarded(() => this.hasher.verify(owner.passwordHash, request.current));
    if (!ok) {
      await this.audit({ type: 'PASSWORD_REJECTED', success: false, ipHash });
      throw new ProblemError(403, 'wrong_password', 'The current password is not right.');
    }
    await this.store.succeedAttempt(attemptId);
    if (request.next === request.current) {
      throw new ProblemError(
        400,
        'password_unchanged',
        'The new password must be different from the current one.',
      );
    }
    const hashed = await this.guarded(() => this.hasher.hash(request.next));
    // One step, and only if the password is still the one that was checked and this session is still valid: a reset
    // on the server, or another change, that came while the hash was being worked out is not overwritten.
    const ended = await this.store.replacePassword(
      hashed,
      owner.passwordHash,
      session.idHash,
      this.now(),
    );
    if (ended === null) {
      throw new ProblemError(
        409,
        'conflict',
        'The account changed while this request was running. Log in again and try again.',
      );
    }
    await this.audit({
      type: 'PASSWORD_CHANGED',
      success: true,
      ipHash,
      detail: { sessionsEnded: ended },
    });
  }

  // ---- second step ------------------------------------------------------------------------------------------------

  /** Starts the setup: a new secret, kept sealed but not yet on. It is shown once; `enable` proves it was copied right. */
  async totpSetup(client: ClientInfo): Promise<TotpSetupResponse> {
    const owner = await this.requireOwner();
    if (owner.totpEnabled) {
      throw new ProblemError(409, 'totp_already_enabled', 'The second step is already on.');
    }
    const secret = newTotpSecret();
    if (!(await this.store.setPendingTotp(seal(this.keys.totp, secret, TOTP_CONTEXT)))) {
      throw new ProblemError(409, 'totp_already_enabled', 'The second step is already on.');
    }
    await this.audit({ type: 'TOTP_SETUP', success: true, ipHash: this.ipHash(client) });
    return { secret, otpauthUrl: totpUri(secret, owner.username) };
  }

  /** The step of a code for the secret of the owner, after the attempt is admitted; refuses a wrong code with 400. */
  private async checkedStep(owner: OwnerRow, code: string, client: ClientInfo): Promise<number> {
    const { ipHash, attemptId } = await this.admit(client, 'session');
    const secret =
      owner.totpSecretEnc === null ? null : open(this.keys.totp, owner.totpSecretEnc, TOTP_CONTEXT);
    const step = secret === null ? null : await totpStep(secret, code, this.now());
    if (step === null || !this.replay.accept(step)) {
      await this.audit({ type: 'TOTP_REJECTED', success: false, ipHash });
      throw new ProblemError(400, 'invalid_code', 'This code is not right.');
    }
    await this.store.succeedAttempt(attemptId);
    return step;
  }

  /** Turns the second step on, once the owner shows a code from the app. Answers the recovery codes, once. */
  async totpEnable(code: string, client: ClientInfo): Promise<TotpEnableResponse> {
    const owner = await this.requireOwner();
    if (owner.totpEnabled) {
      throw new ProblemError(409, 'totp_already_enabled', 'The second step is already on.');
    }
    if (owner.totpSecretEnc === null) {
      throw new ProblemError(409, 'totp_not_set_up', 'Start the setup first.');
    }
    await this.checkedStep(owner, code, client);
    const recoveryCodes = newRecoveryCodes();
    const hashes = recoveryCodes.map((text) => recoveryCodeHash(this.keys.recovery, text) ?? '');
    // only for the secret that was just proved: a second setup that came meanwhile replaced it
    if (!(await this.store.enableTotp(hashes, owner.totpSecretEnc))) {
      throw new ProblemError(
        409,
        'conflict',
        'The second step changed while this request was running. Start the setup again.',
      );
    }
    await this.audit({ type: 'TOTP_ENABLED', success: true, ipHash: this.ipHash(client) });
    return { recoveryCodes };
  }

  async totpDisable(code: string, client: ClientInfo): Promise<void> {
    const owner = await this.requireOwner();
    if (!owner.totpEnabled) {
      throw new ProblemError(409, 'totp_not_enabled', 'The second step is not on.');
    }
    await this.checkedStep(owner, code, client);
    await this.store.disableTotp();
    await this.audit({ type: 'TOTP_DISABLED', success: true, ipHash: this.ipHash(client) });
  }

  // ---- sessions ---------------------------------------------------------------------------------------------------

  /** The valid sessions, this one first. */
  async sessions(current: AuthSession): Promise<SessionsResponse> {
    const rows = await this.store.sessions(this.now());
    const items = rows.map((row) => ({
      id: publicSessionId(row.idHash),
      createdAt: new Date(row.createdAt).toISOString(),
      lastSeenAt: new Date(row.lastSeenAt).toISOString(),
      expiresAt: new Date(row.expiresAt).toISOString(),
      current: row.idHash === current.idHash,
    }));
    return {
      items: [...items.filter((item) => item.current), ...items.filter((item) => !item.current)],
    };
  }

  /** Ends the session with this public id. `current` tells the caller that it was the one in use (a logout). */
  async revokeSession(
    current: AuthSession,
    publicId: string,
    client: ClientInfo,
  ): Promise<{ current: boolean }> {
    if (!PUBLIC_ID_SHAPE.test(publicId)) {
      throw new ProblemError(404, 'not_found', 'There is no session with this id.');
    }
    const idHash = await this.store.revokeByPublicId(publicId, this.now());
    if (idHash === null) {
      throw new ProblemError(404, 'not_found', 'There is no session with this id.');
    }
    await this.audit({
      type: 'SESSION_REVOKED',
      success: true,
      ipHash: this.ipHash(client),
      detail: { current: idHash === current.idHash },
    });
    return { current: idHash === current.idHash };
  }
}
