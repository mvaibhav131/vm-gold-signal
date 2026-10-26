import type { PurgePolicy } from './policy';
import type { ThrottleDecision } from './throttle';

export interface OwnerRow {
  readonly username: string;
  readonly passwordHash: string;
  /** The TOTP secret, sealed with AES-256-GCM; set while the second step is being set up or is on. */
  readonly totpSecretEnc: Buffer | null;
  readonly totpEnabled: boolean;
  /** HMACs of the recovery codes that are still unused. */
  readonly recoveryCodeHashes: readonly string[];
}

export interface SessionRow {
  readonly idHash: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
}

export interface NewSession {
  readonly idHash: string;
  readonly at: number;
  readonly expiresAt: number;
  readonly ipHash: string | null;
  readonly userAgentHash: string | null;
}

/** What the security audit records (01 section 8). Never a password, a code, a token or a user name that was typed. */
export const AUDIT_EVENTS = [
  'OWNER_CREATED',
  'LOGIN',
  'LOGIN_THROTTLED',
  'LOGOUT',
  'PASSWORD_CHANGED',
  'PASSWORD_REJECTED',
  'TOTP_SETUP',
  'TOTP_ENABLED',
  'TOTP_DISABLED',
  'TOTP_REJECTED',
  'RECOVERY_CODE_USED',
  'SESSION_REVOKED',
  'SESSIONS_REVOKED_ALL',
  'THROTTLE_RESET',
] as const;
export type AuditEventType = (typeof AUDIT_EVENTS)[number];

export interface AuditEvent {
  readonly type: AuditEventType;
  readonly success: boolean;
  readonly ipHash: string | null;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

export interface PurgeCounts {
  readonly sessions: number;
  readonly loginAttempts: number;
  readonly audit: number;
}

export interface AdmissionWindow {
  /** Only failures after this time count. */
  readonly since: number;
  /** How many of the newest failures of the client the rule is given at most. */
  readonly clientLimit: number;
  /** How many of the newest failures of everybody the rule is given at most (0: none are read). */
  readonly totalLimit: number;
  /** A client that got in at some time after this is a known client. */
  readonly knownSince: number;
}

/**
 * Given the times (oldest first) of the newest failures of the client and of everybody, and whether the client has
 * got in before (a known client), lets a try in or not.
 */
export type AdmissionRule = (
  client: readonly number[],
  total: readonly number[],
  known: boolean,
) => ThrottleDecision;

export type Admission =
  | { readonly allowed: true; readonly attemptId: number }
  | { readonly allowed: false; readonly retryAfterMs: number };

/**
 * The state of the owner that a login was decided on: it must still be the state when the session is made. The sealed
 * secret is part of it (not only whether the second step is on), so that a second step that was turned off and on again
 * with a new secret while the login was being checked refuses the login that checked the old one.
 */
export interface OwnerState {
  readonly passwordHash: string;
  readonly totpEnabled: boolean;
  readonly totpSecretEnc: Buffer | null;
}

/**
 * Everything the authentication keeps in the database (`auth_owner`, `auth_sessions`, `login_attempts`,
 * `security_audit_events`). Times are epoch milliseconds and always come from the caller, so that the clock is
 * injected and the tests control it. The Postgres and the memory implementation pass the same contract tests.
 */
export interface AuthStore {
  owner(): Promise<OwnerRow | null>;
  /** False when there is an owner already: there is exactly one, and nothing creates a second. */
  createOwner(username: string, passwordHash: string, at: number): Promise<boolean>;
  /** Sets the password hash whatever it was (the command on the server). Ending the sessions is a separate step. */
  setPasswordHash(passwordHash: string, at: number): Promise<void>;
  /**
   * Replaces the password hash and ends every other session in one step, but only if the password is still the one
   * the request checked (`expectedHash`) and the session that asks is still valid. The owner row is locked first and the
   * asking session second (the order every writer uses), and the session stays locked until the commit, so a revocation
   * of it cannot come in between. Returns how many sessions it ended, or null when the state had changed (a reset or
   * another change came first): nothing was done then.
   */
  replacePassword(
    passwordHash: string,
    expectedHash: string,
    sessionIdHash: string,
    at: number,
  ): Promise<number | null>;

  /** Keeps a secret that is not yet on. False when the second step is on already. */
  setPendingTotp(secretEnc: Buffer): Promise<boolean>;
  /**
   * Turns the second step on with its recovery codes, but only for the secret that was proved (`expectedSecretEnc`):
   * a second setup in between replaced it. False when it is on already or the secret is not that one.
   */
  enableTotp(recoveryCodeHashes: readonly string[], expectedSecretEnc: Buffer): Promise<boolean>;
  disableTotp(): Promise<void>;
  /** Uses a recovery code up. False when it was not there (or has just been used by somebody else). */
  useRecoveryCode(hash: string): Promise<boolean>;

  /**
   * Starts a session, but only if the owner is still in the state the login was decided on (`expected`): a password
   * change or a switch of the second step that came while the password was being checked refuses it. False then.
   */
  createSession(session: NewSession, expected: OwnerState): Promise<boolean>;
  /** The session when it is not revoked and has not expired. */
  session(idHash: string, now: number): Promise<SessionRow | null>;
  touchSession(idHash: string, at: number, expiresAt: number): Promise<void>;
  /** The sessions that are valid now, newest first. */
  sessions(now: number): Promise<SessionRow[]>;
  /** Revokes a valid session by the first 16 characters of its hash; returns the full hash, or null if none. */
  revokeByPublicId(publicId: string, now: number): Promise<string | null>;
  revoke(idHash: string, now: number): Promise<void>;
  /** Every valid session except one. Returns how many it ended. */
  revokeAllExcept(idHash: string | null, now: number): Promise<number>;

  /**
   * Admits a try of a secret, or refuses it. In one step that nothing else can get into (Postgres: a transaction under
   * an advisory lock), it reads the newest failures of this client and of everybody inside the window (and after the
   * client's last success), whether the client has got in before, asks `rule`, and, when the rule lets the try in,
   * writes it down as a failure at once. The caller turns it into a success when it is one. One step, because a burst
   * of parallel tries would otherwise all read the same count before any of them wrote.
   */
  admit(
    ipHash: string,
    at: number,
    window: AdmissionWindow,
    rule: AdmissionRule,
  ): Promise<Admission>;
  succeedAttempt(id: number): Promise<void>;

  audit(event: AuditEvent, at: number): Promise<void>;
  purge(now: number, policy: PurgePolicy): Promise<PurgeCounts>;
  /** Forgets the failed tries of every client (the ones that got in stay: those clients stay known). Returns how many. */
  clearFailures(): Promise<number>;
}
