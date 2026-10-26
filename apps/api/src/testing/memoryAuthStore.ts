import type { PurgePolicy } from '../auth/policy';
import {
  type Admission,
  type AdmissionRule,
  type AdmissionWindow,
  type AuditEvent,
  type AuthStore,
  type NewSession,
  type OwnerRow,
  type OwnerState,
  type PurgeCounts,
  type SessionRow,
} from '../auth/store';

interface StoredOwner {
  username: string;
  passwordHash: string;
  totpSecretEnc: Buffer | null;
  totpEnabled: boolean;
  recoveryCodeHashes: string[];
}

interface StoredSession extends SessionRow {
  revokedAt: number | null;
  ipHash: string | null;
  userAgentHash: string | null;
}

interface StoredAttempt {
  readonly id: number;
  readonly at: number;
  readonly ipHash: string;
  success: boolean;
}

export interface StoredAudit extends AuditEvent {
  readonly at: number;
}

/** The authentication store in memory: the fast tests of the routes run on it, and it passes the same contract tests as Postgres. */
export class MemoryAuthStore implements AuthStore {
  private ownerRow: StoredOwner | null = null;
  private readonly sessionRows = new Map<string, StoredSession>();
  private readonly attemptRows: StoredAttempt[] = [];
  private nextAttemptId = 1;
  readonly auditLog: StoredAudit[] = [];

  /** A look inside, for the tests. */
  get attempts(): readonly Readonly<StoredAttempt>[] {
    return this.attemptRows;
  }

  stored(idHash: string): Readonly<StoredSession> | undefined {
    return this.sessionRows.get(idHash);
  }

  owner(): Promise<OwnerRow | null> {
    const row = this.ownerRow;
    return Promise.resolve(
      row === null ? null : { ...row, recoveryCodeHashes: [...row.recoveryCodeHashes] },
    );
  }

  createOwner(username: string, passwordHash: string, _at: number): Promise<boolean> {
    if (this.ownerRow !== null) return Promise.resolve(false);
    this.ownerRow = {
      username,
      passwordHash,
      totpSecretEnc: null,
      totpEnabled: false,
      recoveryCodeHashes: [],
    };
    return Promise.resolve(true);
  }

  setPasswordHash(passwordHash: string, _at: number): Promise<void> {
    if (this.ownerRow !== null) this.ownerRow.passwordHash = passwordHash;
    return Promise.resolve();
  }

  /** One step in this single-threaded process: the check and the change have no `await` between them. */
  replacePassword(
    passwordHash: string,
    expectedHash: string,
    sessionIdHash: string,
    at: number,
  ): Promise<number | null> {
    const row = this.ownerRow;
    if (row?.passwordHash !== expectedHash) return Promise.resolve(null);
    if (!this.valid(this.sessionRows.get(sessionIdHash), at)) return Promise.resolve(null);
    row.passwordHash = passwordHash;
    let ended = 0;
    for (const session of this.sessionRows.values()) {
      if (session.idHash !== sessionIdHash && this.valid(session, at)) {
        this.sessionRows.set(session.idHash, { ...session, revokedAt: at });
        ended += 1;
      }
    }
    return Promise.resolve(ended);
  }

  setPendingTotp(secretEnc: Buffer): Promise<boolean> {
    if (this.ownerRow === null || this.ownerRow.totpEnabled) return Promise.resolve(false);
    this.ownerRow.totpSecretEnc = secretEnc;
    return Promise.resolve(true);
  }

  enableTotp(recoveryCodeHashes: readonly string[], expectedSecretEnc: Buffer): Promise<boolean> {
    const row = this.ownerRow;
    if (row === null || row.totpEnabled || !row.totpSecretEnc?.equals(expectedSecretEnc)) {
      return Promise.resolve(false);
    }
    row.totpEnabled = true;
    row.recoveryCodeHashes = [...recoveryCodeHashes];
    return Promise.resolve(true);
  }

  disableTotp(): Promise<void> {
    if (this.ownerRow !== null) {
      this.ownerRow.totpEnabled = false;
      this.ownerRow.totpSecretEnc = null;
      this.ownerRow.recoveryCodeHashes = [];
    }
    return Promise.resolve();
  }

  useRecoveryCode(hash: string): Promise<boolean> {
    const row = this.ownerRow;
    if (!row?.recoveryCodeHashes.includes(hash)) return Promise.resolve(false);
    row.recoveryCodeHashes = row.recoveryCodeHashes.filter((candidate) => candidate !== hash);
    return Promise.resolve(true);
  }

  createSession(session: NewSession, expected: OwnerState): Promise<boolean> {
    const row = this.ownerRow;
    const sameSecret =
      row?.totpSecretEnc === null || expected.totpSecretEnc === null
        ? row?.totpSecretEnc === expected.totpSecretEnc
        : row?.totpSecretEnc.equals(expected.totpSecretEnc);
    if (
      row?.passwordHash !== expected.passwordHash ||
      row.totpEnabled !== expected.totpEnabled ||
      sameSecret !== true
    ) {
      return Promise.resolve(false);
    }
    this.putSession(session);
    return Promise.resolve(true);
  }

  /** For the tests: a session row whatever the owner is (the API cannot make one without an owner). */
  putSession(session: NewSession): void {
    this.sessionRows.set(session.idHash, {
      idHash: session.idHash,
      createdAt: session.at,
      lastSeenAt: session.at,
      expiresAt: session.expiresAt,
      revokedAt: null,
      ipHash: session.ipHash,
      userAgentHash: session.userAgentHash,
    });
  }

  private valid(row: StoredSession | undefined, now: number): row is StoredSession {
    return row?.revokedAt === null && row.expiresAt > now;
  }

  session(idHash: string, now: number): Promise<SessionRow | null> {
    const row = this.sessionRows.get(idHash);
    return Promise.resolve(this.valid(row, now) ? view(row) : null);
  }

  touchSession(idHash: string, at: number, expiresAt: number): Promise<void> {
    const row = this.sessionRows.get(idHash);
    if (row?.revokedAt === null) {
      this.sessionRows.set(idHash, { ...row, lastSeenAt: at, expiresAt });
    }
    return Promise.resolve();
  }

  sessions(now: number): Promise<SessionRow[]> {
    return Promise.resolve(
      [...this.sessionRows.values()]
        .filter((row) => this.valid(row, now))
        .sort((a, b) => b.createdAt - a.createdAt || a.idHash.localeCompare(b.idHash))
        .map(view),
    );
  }

  revokeByPublicId(publicId: string, now: number): Promise<string | null> {
    // exactly one valid session may match; if more did, none is revoked (as in Postgres)
    const matches = [...this.sessionRows.values()].filter(
      (candidate) => this.valid(candidate, now) && candidate.idHash.startsWith(publicId),
    );
    const [row] = matches;
    if (row === undefined || matches.length !== 1) return Promise.resolve(null);
    this.sessionRows.set(row.idHash, { ...row, revokedAt: now });
    return Promise.resolve(row.idHash);
  }

  revoke(idHash: string, now: number): Promise<void> {
    const row = this.sessionRows.get(idHash);
    if (row?.revokedAt === null) {
      this.sessionRows.set(idHash, { ...row, revokedAt: now });
    }
    return Promise.resolve();
  }

  revokeAllExcept(idHash: string | null, now: number): Promise<number> {
    let ended = 0;
    for (const row of this.sessionRows.values()) {
      if (row.idHash !== idHash && this.valid(row, now)) {
        this.sessionRows.set(row.idHash, { ...row, revokedAt: now });
        ended += 1;
      }
    }
    return Promise.resolve(ended);
  }

  /** Counted and decided with no `await` in between, so that it is one step in this single-threaded process. */
  admit(
    ipHash: string,
    at: number,
    window: AdmissionWindow,
    rule: AdmissionRule,
  ): Promise<Admission> {
    const own = this.attemptRows.filter((attempt) => attempt.ipHash === ipHash);
    // "after its last success" is a matter of order, not of time: two tries can have the same millisecond
    const lastSuccessId = Math.max(0, ...own.filter((a) => a.success).map((a) => a.id));
    const client = newest(
      own.filter((a) => !a.success && a.at > window.since && a.id > lastSuccessId),
      window.clientLimit,
    );
    const total =
      window.totalLimit === 0
        ? []
        : newest(
            this.attemptRows.filter((a) => !a.success && a.at > window.since),
            window.totalLimit,
          );
    const known = own.some((a) => a.success && a.at > window.knownSince);
    const decision = rule(client, total, known);
    if (!decision.allowed) {
      return Promise.resolve({ allowed: false, retryAfterMs: decision.retryAfterMs });
    }
    const id = this.nextAttemptId;
    this.nextAttemptId += 1;
    this.attemptRows.push({ id, at, ipHash, success: false });
    return Promise.resolve({ allowed: true, attemptId: id });
  }

  succeedAttempt(id: number): Promise<void> {
    const row = this.attemptRows.find((attempt) => attempt.id === id);
    if (row !== undefined) row.success = true;
    return Promise.resolve();
  }

  audit(event: AuditEvent, at: number): Promise<void> {
    this.auditLog.push({ ...event, at });
    return Promise.resolve();
  }

  clearFailures(): Promise<number> {
    const before = this.attemptRows.length;
    const kept = this.attemptRows.filter((attempt) => attempt.success);
    this.attemptRows.splice(0, this.attemptRows.length, ...kept);
    return Promise.resolve(before - kept.length);
  }

  purge(now: number, policy: PurgePolicy): Promise<PurgeCounts> {
    let sessions = 0;
    for (const row of [...this.sessionRows.values()]) {
      const expired = row.expiresAt < now - policy.expiredSessionsMs;
      const revoked = row.revokedAt !== null && row.revokedAt < now - policy.revokedSessionsMs;
      if (expired || revoked) {
        this.sessionRows.delete(row.idHash);
        sessions += 1;
      }
    }
    const attemptsBefore = this.attemptRows.length;
    const keepAttempts = this.attemptRows.filter((a) => a.at >= now - policy.loginAttemptsMs);
    this.attemptRows.splice(0, this.attemptRows.length, ...keepAttempts);
    const auditBefore = this.auditLog.length;
    const keepAudit = this.auditLog.filter((e) => e.at >= now - policy.auditMs);
    this.auditLog.splice(0, this.auditLog.length, ...keepAudit);
    return Promise.resolve({
      sessions,
      loginAttempts: attemptsBefore - this.attemptRows.length,
      audit: auditBefore - this.auditLog.length,
    });
  }
}

function view(row: StoredSession): SessionRow {
  return {
    idHash: row.idHash,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
  };
}

/** The times of the newest `limit` attempts, oldest first. */
function newest(rows: readonly StoredAttempt[], limit: number): number[] {
  return rows
    .map((row) => row.at)
    .sort((a, b) => a - b)
    .slice(-limit);
}
