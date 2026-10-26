import type { Pool } from 'pg';

import type { PurgePolicy } from './policy';
import type {
  Admission,
  AdmissionRule,
  AdmissionWindow,
  AuditEvent,
  AuthStore,
  NewSession,
  OwnerRow,
  OwnerState,
  PurgeCounts,
  SessionRow,
} from './store';

interface OwnerDb {
  username: string;
  password_hash: string;
  totp_secret_enc: Buffer | null;
  totp_enabled: boolean;
  recovery_code_hashes: string[];
}

interface SessionDb {
  id_hash: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
}

const SESSION_COLUMNS = 'id_hash, created_at, last_seen_at, expires_at';

function sessionOf(row: SessionDb): SessionRow {
  return {
    idHash: row.id_hash,
    createdAt: row.created_at.getTime(),
    lastSeenAt: row.last_seen_at.getTime(),
    expiresAt: row.expires_at.getTime(),
  };
}

/** The authentication store on Postgres, with the rights of the role `vmgs_api` (the worker has none on these tables). */
export class PostgresAuthStore implements AuthStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async owner(): Promise<OwnerRow | null> {
    const { rows } = await this.pool.query<OwnerDb>(
      `SELECT username, password_hash, totp_secret_enc, totp_enabled, recovery_code_hashes
         FROM auth_owner WHERE id = 1`,
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      username: row.username,
      passwordHash: row.password_hash,
      totpSecretEnc: row.totp_secret_enc,
      totpEnabled: row.totp_enabled,
      recoveryCodeHashes: row.recovery_code_hashes,
    };
  }

  async createOwner(username: string, passwordHash: string, at: number): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO auth_owner (id, username, password_hash, password_changed_at, created_at)
       VALUES (1, $1, $2, $3, $3) ON CONFLICT (id) DO NOTHING`,
      [username, passwordHash, new Date(at)],
    );
    return result.rowCount === 1;
  }

  async setPasswordHash(passwordHash: string, at: number): Promise<void> {
    await this.pool.query(
      'UPDATE auth_owner SET password_hash = $1, password_changed_at = $2 WHERE id = 1',
      [passwordHash, new Date(at)],
    );
  }

  async replacePassword(
    passwordHash: string,
    expectedHash: string,
    sessionIdHash: string,
    at: number,
  ): Promise<number | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Lock order, the same for every writer: the owner row, then the session row. A login holds the owner row FOR
      // SHARE while it makes its session, so this waits for it and then ends that session too.
      const owner = await client.query<{ password_hash: string }>(
        'SELECT password_hash FROM auth_owner WHERE id = 1 FOR UPDATE',
      );
      if (owner.rows[0]?.password_hash !== expectedHash) {
        await client.query('ROLLBACK');
        return null;
      }
      // FOR SHARE (not FOR KEY SHARE: a revocation only changes a non-key column) holds the asking session until the
      // commit. A revocation that is under way makes this wait, and the row no longer matches when it is let through.
      const asking = await client.query(
        `SELECT 1 FROM auth_sessions
          WHERE id_hash = $1 AND revoked_at IS NULL AND expires_at > $2::timestamptz FOR SHARE`,
        [sessionIdHash, new Date(at)],
      );
      if (asking.rowCount !== 1) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        'UPDATE auth_owner SET password_hash = $1, password_changed_at = $2::timestamptz WHERE id = 1',
        [passwordHash, new Date(at)],
      );
      const ended = await client.query(
        `UPDATE auth_sessions SET revoked_at = $1::timestamptz
          WHERE revoked_at IS NULL AND expires_at > $1::timestamptz AND id_hash <> $2`,
        [new Date(at), sessionIdHash],
      );
      await client.query('COMMIT');
      return ended.rowCount ?? 0;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async setPendingTotp(secretEnc: Buffer): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE auth_owner SET totp_secret_enc = $1 WHERE id = 1 AND NOT totp_enabled',
      [secretEnc],
    );
    return result.rowCount === 1;
  }

  async enableTotp(
    recoveryCodeHashes: readonly string[],
    expectedSecretEnc: Buffer,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE auth_owner SET totp_enabled = true, recovery_code_hashes = $1
        WHERE id = 1 AND NOT totp_enabled AND totp_secret_enc = $2`,
      [recoveryCodeHashes, expectedSecretEnc],
    );
    return result.rowCount === 1;
  }

  async disableTotp(): Promise<void> {
    await this.pool.query(
      `UPDATE auth_owner SET totp_enabled = false, totp_secret_enc = NULL, recovery_code_hashes = '{}'
        WHERE id = 1`,
    );
  }

  async useRecoveryCode(hash: string): Promise<boolean> {
    // one statement: of two requests with the same code only one finds it still in the array
    const result = await this.pool.query(
      `UPDATE auth_owner SET recovery_code_hashes = array_remove(recovery_code_hashes, $1::text)
        WHERE id = 1 AND $1::text = ANY (recovery_code_hashes)`,
      [hash],
    );
    return result.rowCount === 1;
  }

  async createSession(session: NewSession, expected: OwnerState): Promise<boolean> {
    // FOR SHARE: a password change that comes now waits for this statement, and then ends the session it made
    const result = await this.pool.query(
      `INSERT INTO auth_sessions (id_hash, created_at, last_seen_at, expires_at, ip_hash, ua_hash)
       SELECT $1, $2, $2, $3, $4, $5
        WHERE EXISTS (SELECT 1 FROM auth_owner
                       WHERE id = 1 AND password_hash = $6 AND totp_enabled = $7
                         AND totp_secret_enc IS NOT DISTINCT FROM $8::bytea FOR SHARE)`,
      [
        session.idHash,
        new Date(session.at),
        new Date(session.expiresAt),
        session.ipHash,
        session.userAgentHash,
        expected.passwordHash,
        expected.totpEnabled,
        expected.totpSecretEnc,
      ],
    );
    return result.rowCount === 1;
  }

  async session(idHash: string, now: number): Promise<SessionRow | null> {
    const { rows } = await this.pool.query<SessionDb>(
      `SELECT ${SESSION_COLUMNS} FROM auth_sessions
        WHERE id_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
      [idHash, new Date(now)],
    );
    const row = rows[0];
    return row === undefined ? null : sessionOf(row);
  }

  async touchSession(idHash: string, at: number, expiresAt: number): Promise<void> {
    await this.pool.query(
      `UPDATE auth_sessions SET last_seen_at = $2, expires_at = $3
        WHERE id_hash = $1 AND revoked_at IS NULL`,
      [idHash, new Date(at), new Date(expiresAt)],
    );
  }

  async sessions(now: number): Promise<SessionRow[]> {
    const { rows } = await this.pool.query<SessionDb>(
      `SELECT ${SESSION_COLUMNS} FROM auth_sessions
        WHERE revoked_at IS NULL AND expires_at > $1
        ORDER BY created_at DESC, id_hash`,
      [new Date(now)],
    );
    return rows.map(sessionOf);
  }

  async revokeByPublicId(publicId: string, now: number): Promise<string | null> {
    // exactly one valid session may match the 16 characters; if more did, none is revoked
    const { rows } = await this.pool.query<{ id_hash: string }>(
      `WITH matches AS (
         SELECT id_hash FROM auth_sessions
          WHERE left(id_hash, 16) = $1::text AND revoked_at IS NULL AND expires_at > $2
       )
       UPDATE auth_sessions SET revoked_at = $2
        WHERE id_hash IN (SELECT id_hash FROM matches) AND (SELECT count(*) FROM matches) = 1
        RETURNING id_hash`,
      [publicId, new Date(now)],
    );
    return rows[0]?.id_hash ?? null;
  }

  async revoke(idHash: string, now: number): Promise<void> {
    await this.pool.query(
      'UPDATE auth_sessions SET revoked_at = $2 WHERE id_hash = $1 AND revoked_at IS NULL',
      [idHash, new Date(now)],
    );
  }

  async revokeAllExcept(idHash: string | null, now: number): Promise<number> {
    const result = await this.pool.query(
      `UPDATE auth_sessions SET revoked_at = $2
        WHERE revoked_at IS NULL AND expires_at > $2 AND id_hash IS DISTINCT FROM $1::text`,
      [idHash, new Date(now)],
    );
    return result.rowCount ?? 0;
  }

  async admit(
    ipHash: string,
    at: number,
    window: AdmissionWindow,
    rule: AdmissionRule,
  ): Promise<Admission> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // One lock for every admission, held for these few statements only (never while a password is hashed): it is
      // what makes "read the counts, decide, write the try" one step, so that a burst cannot all read the same count.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('vmgs:login-admission', 0))",
      );
      // one after the other on this connection; "after its last success" is a matter of order (the id), not of time
      const own = await client.query<{ at: Date }>(
        `SELECT at FROM login_attempts
          WHERE ip_hash = $1 AND NOT success AND at > $2
            AND id > coalesce((SELECT max(id) FROM login_attempts WHERE ip_hash = $1 AND success), 0)
          ORDER BY at DESC, id DESC LIMIT $3`,
        [ipHash, new Date(window.since), window.clientLimit],
      );
      const all =
        window.totalLimit === 0
          ? { rows: [] as { at: Date }[] }
          : await client.query<{ at: Date }>(
              'SELECT at FROM login_attempts WHERE NOT success AND at > $1 ORDER BY at DESC, id DESC LIMIT $2',
              [new Date(window.since), window.totalLimit],
            );
      const known = await client.query(
        'SELECT 1 FROM login_attempts WHERE ip_hash = $1 AND success AND at > $2 LIMIT 1',
        [ipHash, new Date(window.knownSince)],
      );
      const decision = rule(
        own.rows.map((row) => row.at.getTime()).reverse(),
        all.rows.map((row) => row.at.getTime()).reverse(),
        known.rows.length > 0,
      );
      if (!decision.allowed) {
        await client.query('COMMIT');
        return { allowed: false, retryAfterMs: decision.retryAfterMs };
      }
      const inserted = await client.query<{ id: string }>(
        'INSERT INTO login_attempts (at, ip_hash, success) VALUES ($1, $2, false) RETURNING id',
        [new Date(at), ipHash],
      );
      await client.query('COMMIT');
      return { allowed: true, attemptId: Number(inserted.rows[0]?.id) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async succeedAttempt(id: number): Promise<void> {
    await this.pool.query('UPDATE login_attempts SET success = true WHERE id = $1', [id]);
  }

  async audit(event: AuditEvent, at: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO security_audit_events (at, event_type, success, ip_hash, detail)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [new Date(at), event.type, event.success, event.ipHash, JSON.stringify(event.detail ?? {})],
    );
  }

  async clearFailures(): Promise<number> {
    const result = await this.pool.query('DELETE FROM login_attempts WHERE NOT success');
    return result.rowCount ?? 0;
  }

  async purge(now: number, policy: PurgePolicy): Promise<PurgeCounts> {
    const sessions = await this.pool.query(
      `DELETE FROM auth_sessions WHERE expires_at < $1 OR revoked_at < $2`,
      [new Date(now - policy.expiredSessionsMs), new Date(now - policy.revokedSessionsMs)],
    );
    const attempts = await this.pool.query('DELETE FROM login_attempts WHERE at < $1', [
      new Date(now - policy.loginAttemptsMs),
    ]);
    const audit = await this.pool.query('DELETE FROM security_audit_events WHERE at < $1', [
      new Date(now - policy.auditMs),
    ]);
    return {
      sessions: sessions.rowCount ?? 0,
      loginAttempts: attempts.rowCount ?? 0,
      audit: audit.rowCount ?? 0,
    };
  }
}
