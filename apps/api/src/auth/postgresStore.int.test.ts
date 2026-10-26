import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from '@vmgs/db';

import { failureOf, query, type TestDatabase } from '../../../../packages/db/test/database';
import { migratedDatabase } from '../../../../packages/db/test/setup';
import { PostgresAuthStore } from './postgresStore';
import { authStoreContract } from './storeContract';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

/** A database of its own for each test of the contract, with the rights of the role `vmgs_api` (and no more). */
const databases: TestDatabase[] = [];
const pools: ReturnType<typeof createPool>[] = [];

async function freshStore() {
  const database = await migratedDatabase();
  databases.push(database);
  await query(database.url, "ALTER ROLE vmgs_api LOGIN PASSWORD 'api-pass'");
  const pool = createPool(database.urlFor('vmgs_api', 'api-pass'), { max: 4 });
  pools.push(pool);
  return { database, pool, store: new PostgresAuthStore(pool) };
}

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await Promise.all(databases.map((database) => database.drop()));
});

authStoreContract('PostgresAuthStore', async () => {
  const { database, store } = await freshStore();
  return {
    store,
    audit: async () => {
      const rows = await query<{
        event_type: string;
        success: boolean;
        ip_hash: string | null;
        at: Date;
        detail: unknown;
      }>(
        database.url,
        'SELECT event_type, success, ip_hash, at, detail FROM security_audit_events ORDER BY id',
      );
      return rows.map((row) => ({
        type: row.event_type,
        success: row.success,
        ipHash: row.ip_hash,
        at: row.at.getTime(),
        detail: row.detail,
      }));
    },
    attemptCount: async () => {
      const rows = await query<{ n: string }>(
        database.url,
        'SELECT count(*) AS n FROM login_attempts',
      );
      return Number(rows[0]?.n);
    },
  };
});

describe('PostgresAuthStore beyond the contract', () => {
  let database: TestDatabase;
  let store: PostgresAuthStore;

  beforeAll(async () => {
    ({ database, store } = await freshStore());
  });

  it('keeps one owner by the table itself, not only by the code', async () => {
    expect(await store.createOwner('owner', 'hash', Date.now())).toBe(true);
    expect(
      (
        await failureOf(
          database.url,
          "INSERT INTO auth_owner (id, username, password_hash) VALUES (2, 'x', 'y')",
        )
      )?.code,
    ).toBe('23514'); // check_violation: id = 1
  });

  it('stores only hashes: a session row has no token, and the owner row no secret in the clear', async () => {
    expect(
      await store.createSession(
        {
          idHash: 'f'.repeat(64),
          at: Date.now(),
          expiresAt: Date.now() + 1000,
          ipHash: 'ip',
          userAgentHash: null,
        },
        { passwordHash: 'hash', totpEnabled: false, totpSecretEnc: null },
      ),
    ).toBe(true);
    const columns = await query<{ column_name: string }>(
      database.url,
      `SELECT column_name FROM information_schema.columns
        WHERE table_name IN ('auth_sessions', 'auth_owner') ORDER BY column_name`,
    );
    const names = columns.map((column) => column.column_name);
    expect(names).not.toContain('token');
    expect(names).not.toContain('totp_secret');
    expect(names).toContain('totp_secret_enc');
  });

  it('waits for a revocation of the asking session that is under way, then refuses (the session is locked until the commit)', async () => {
    const owner = await store.owner();
    const hash = owner?.passwordHash ?? '';
    const id = 'e'.repeat(64);
    const state = { passwordHash: hash, totpEnabled: false, totpSecretEnc: null };
    const now = Date.now();
    expect(
      await store.createSession(
        { idHash: id, at: now, expiresAt: now + 86_400_000, ipHash: null, userAgentHash: null },
        state,
      ),
    ).toBe(true);

    // the owner revokes that session from another device: a transaction that has not committed yet
    const other = new pg.Client({ connectionString: database.url });
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query('UPDATE auth_sessions SET revoked_at = now() WHERE id_hash = $1', [id]);

      let finished = false;
      const change = store.replacePassword('a-new-hash', hash, id, now).then((result) => {
        finished = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(finished).toBe(false); // it is waiting for the lock of the session, not deciding on what it saw before

      await other.query('COMMIT');
      expect(await change).toBeNull();
    } finally {
      await other.end();
    }
    expect((await store.owner())?.passwordHash).toBe(hash);
  });

  it('makes a login that is starting wait for a password change that has the owner row, and ends that session', async () => {
    const owner = await store.owner();
    const hash = owner?.passwordHash ?? '';
    const now = Date.now();
    const keeper = 'd'.repeat(64);
    expect(
      await store.createSession(
        { idHash: keeper, at: now, expiresAt: now + 86_400_000, ipHash: null, userAgentHash: null },
        { passwordHash: hash, totpEnabled: false, totpSecretEnc: null },
      ),
    ).toBe(true);

    // a login that checked the old password and a change of it, at the same moment, many times over
    for (let round = 0; round < 10; round += 1) {
      const current = (await store.owner())?.passwordHash ?? '';
      const newcomer = round.toString(16).padEnd(64, 'c');
      const [made, changed] = await Promise.all([
        store.createSession(
          {
            idHash: newcomer,
            at: now,
            expiresAt: now + 86_400_000,
            ipHash: null,
            userAgentHash: null,
          },
          { passwordHash: current, totpEnabled: false, totpSecretEnc: null },
        ),
        store.replacePassword(`next-${String(round)}`, current, keeper, now),
      ]);
      expect(changed).not.toBeNull();
      // whichever came first, the session of the old password is not alive afterwards
      const alive = (await store.sessions(now)).map((row) => row.idHash);
      expect(alive, `round ${String(round)} (login ${String(made)})`).toEqual([keeper]);
    }
  });

  it('works with the rights of vmgs_api only: it can keep and purge everything the store writes', async () => {
    // a store on the owner connection would hide a missing grant; this one runs as the role of the API
    const now = Date.now();
    const admission = await store.admit(
      'ip',
      now,
      { since: now - 1000, clientLimit: 5, totalLimit: 5, knownSince: now - 1000 },
      () => ({ allowed: true }),
    );
    if (!admission.allowed) throw new Error('the try was refused');
    await store.succeedAttempt(admission.attemptId);
    await store.audit({ type: 'LOGOUT', success: true, ipHash: null }, now);
    const counts = await store.purge(now + 400 * 86_400_000, {
      expiredSessionsMs: 1,
      revokedSessionsMs: 1,
      loginAttemptsMs: 1,
      auditMs: 1,
    });
    expect(counts.loginAttempts).toBeGreaterThanOrEqual(1);
    expect(counts.audit).toBeGreaterThanOrEqual(1);
  });
});
