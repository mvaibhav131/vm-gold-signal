import { describe, expect, it } from 'vitest';

import { DEFAULT_PURGE_POLICY } from './policy';
import type { Admission, AdmissionRule, AuthStore } from './store';

const T0 = Date.UTC(2026, 9, 26, 6, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;
const SECRET = Buffer.from('sealed-secret');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

export interface AuthHarness {
  readonly store: AuthStore;
  /** What the audit holds, oldest first. */
  audit(): Promise<
    { type: string; success: boolean; ipHash: string | null; at: number; detail: unknown }[]
  >;
  attemptCount(): Promise<number>;
}

/** The contract of `AuthStore`: the memory store and the Postgres store must both keep it. */
export function authStoreContract(name: string, make: () => Promise<AuthHarness>): void {
  async function withOwner(): Promise<AuthHarness> {
    const harness = await make();
    await harness.store.createOwner('owner', 'hash-1', T0);
    return harness;
  }

  const session = (id: string, at = T0, expiresAt = T0 + DAY) => ({
    idHash: id.repeat(64).slice(0, 64),
    at,
    expiresAt,
    ipHash: 'ip',
    userAgentHash: 'ua',
  });

  const STATE = { passwordHash: 'hash-1', totpEnabled: false, totpSecretEnc: null };

  /** Makes a session for the owner of the tests (made here when it is not there yet). */
  async function create(store: AuthStore, row: ReturnType<typeof session>): Promise<boolean> {
    await store.createOwner('owner', 'hash-1', T0);
    return store.createSession(row, STATE);
  }

  const OPEN: AdmissionRule = () => ({ allowed: true });

  /** One admission; returns what the rule was shown and what the store answered. */
  async function admit(
    store: AuthStore,
    ip: string,
    at: number,
    options: {
      since?: number;
      clientLimit?: number;
      totalLimit?: number;
      knownSince?: number;
      rule?: AdmissionRule;
    } = {},
  ) {
    let shown: { client: readonly number[]; total: readonly number[]; known: boolean } = {
      client: [],
      total: [],
      known: false,
    };
    const rule = options.rule ?? OPEN;
    const admission = await store.admit(
      ip,
      at,
      {
        since: options.since ?? T0 - MIN,
        clientLimit: options.clientLimit ?? 10,
        totalLimit: options.totalLimit ?? 10,
        knownSince: options.knownSince ?? T0 - 30 * DAY,
      },
      (client, total, known) => {
        shown = { client, total, known };
        return rule(client, total, known);
      },
    );
    return { admission, ...shown };
  }

  const idOf = (admission: Admission): number => {
    if (!admission.allowed) throw new Error('the try was not admitted');
    return admission.attemptId;
  };

  describe(`${name}: the owner`, () => {
    it('is not there before it is made, and is made once', async () => {
      const { store } = await make();
      expect(await store.owner()).toBeNull();
      expect(await store.createOwner('owner', 'hash-1', T0)).toBe(true);
      expect(await store.createOwner('somebody', 'hash-2', T0 + 1)).toBe(false);
      expect(await store.owner()).toEqual({
        username: 'owner',
        passwordHash: 'hash-1',
        totpSecretEnc: null,
        totpEnabled: false,
        recoveryCodeHashes: [],
      });
    });

    it('changes the password hash', async () => {
      const { store } = await withOwner();
      await store.setPasswordHash('hash-2', T0 + MIN);
      expect((await store.owner())?.passwordHash).toBe('hash-2');
    });

    it('replaces the password and ends every other session in one step, and keeps the session that asked', async () => {
      const { store } = await withOwner();
      for (const id of ['1', '2', '3']) await create(store, session(id));
      expect(await store.replacePassword('hash-2', 'hash-1', '2'.repeat(64), T0 + MIN)).toBe(2);
      expect((await store.owner())?.passwordHash).toBe('hash-2');
      expect((await store.sessions(T0 + MIN)).map((row) => row.idHash[0])).toEqual(['2']);
    });

    it('does nothing when the password is no longer the one that was checked', async () => {
      const { store } = await withOwner();
      await create(store, session('1'));
      await create(store, session('2'));
      await store.setPasswordHash('hash-reset', T0 + MIN); // a reset on the server came first
      expect(
        await store.replacePassword('hash-2', 'hash-1', '1'.repeat(64), T0 + 2 * MIN),
      ).toBeNull();
      expect((await store.owner())?.passwordHash).toBe('hash-reset');
      expect(await store.sessions(T0 + 2 * MIN)).toHaveLength(2);
    });

    it('does nothing for a session that is revoked, expired or unknown', async () => {
      const { store } = await withOwner();
      await create(store, session('1'));
      await create(store, session('2', T0, T0 + 5));
      await create(store, session('3'));
      await create(store, session('4', T0, T0 + MIN)); // expires at the very moment of the change
      await store.revoke('3'.repeat(64), T0 + MIN);
      for (const id of ['2', '3', '4', '9']) {
        expect(
          await store.replacePassword('hash-2', 'hash-1', id.repeat(64), T0 + MIN),
          id,
        ).toBeNull();
      }
      expect((await store.owner())?.passwordHash).toBe('hash-1');
      expect(await store.sessions(T0 + MIN)).toHaveLength(1);
    });

    it('lets one of two parallel replacements win', async () => {
      const { store } = await withOwner();
      await create(store, session('1'));
      const both = await Promise.all([
        store.replacePassword('hash-a', 'hash-1', '1'.repeat(64), T0 + MIN),
        store.replacePassword('hash-b', 'hash-1', '1'.repeat(64), T0 + MIN),
      ]);
      expect(both.filter((result) => result !== null)).toHaveLength(1);
      expect(['hash-a', 'hash-b']).toContain((await store.owner())?.passwordHash);
    });
  });

  describe(`${name}: the second step`, () => {
    it('keeps a pending secret, turns on with recovery codes, and turns off clean', async () => {
      const { store } = await withOwner();
      expect(await store.enableTotp([HASH_A], SECRET)).toBe(false); // nothing to turn on yet
      expect(await store.setPendingTotp(SECRET)).toBe(true);
      expect(await store.owner()).toMatchObject({ totpEnabled: false });
      expect((await store.owner())?.totpSecretEnc?.equals(SECRET)).toBe(true);

      expect(await store.enableTotp([HASH_A, HASH_B], SECRET)).toBe(true);
      expect(await store.owner()).toMatchObject({
        totpEnabled: true,
        recoveryCodeHashes: [HASH_A, HASH_B],
      });
      expect(await store.enableTotp([HASH_A], SECRET)).toBe(false);
      expect(await store.setPendingTotp(Buffer.from('other'))).toBe(false);
      expect((await store.owner())?.totpSecretEnc?.equals(SECRET)).toBe(true);

      await store.disableTotp();
      expect(await store.owner()).toMatchObject({
        totpEnabled: false,
        totpSecretEnc: null,
        recoveryCodeHashes: [],
      });
    });

    it('replaces a pending secret that was never confirmed, and turns on only for the secret that was proved', async () => {
      const { store } = await withOwner();
      await store.setPendingTotp(SECRET);
      expect(await store.setPendingTotp(Buffer.from('second'))).toBe(true);
      expect((await store.owner())?.totpSecretEnc?.toString()).toBe('second');
      // a code was proved for the first secret, but a second setup replaced it: the second one is not turned on
      expect(await store.enableTotp([HASH_A], SECRET)).toBe(false);
      expect((await store.owner())?.totpEnabled).toBe(false);
      expect(await store.enableTotp([HASH_A], Buffer.from('second'))).toBe(true);
    });

    it('uses a recovery code up once, even when two requests bring it at the same time', async () => {
      const { store } = await withOwner();
      await store.setPendingTotp(SECRET);
      await store.enableTotp([HASH_A, HASH_B], SECRET);
      const both = await Promise.all([
        store.useRecoveryCode(HASH_A),
        store.useRecoveryCode(HASH_A),
      ]);
      expect(both.filter(Boolean)).toHaveLength(1);
      expect((await store.owner())?.recoveryCodeHashes).toEqual([HASH_B]);
      expect(await store.useRecoveryCode('c'.repeat(64))).toBe(false);
    });
  });

  describe(`${name}: sessions`, () => {
    it('is made only while the owner is as the login found it', async () => {
      const harness = await make();
      const { store } = harness;
      const row = session('1');
      expect(await store.createSession(row, STATE)).toBe(false); // no owner at all
      await store.createOwner('owner', 'hash-1', T0);
      expect(
        await store.createSession(row, {
          passwordHash: 'other-hash',
          totpEnabled: false,
          totpSecretEnc: null,
        }),
      ).toBe(false);
      expect(
        await store.createSession(row, {
          passwordHash: 'hash-1',
          totpEnabled: true,
          totpSecretEnc: null,
        }),
      ).toBe(false);
      expect(await store.sessions(T0)).toEqual([]);
      expect(await store.createSession(row, STATE)).toBe(true);
      expect(await store.sessions(T0)).toHaveLength(1);
    });

    it('is refused when the second step was turned off and on again with a new secret in between', async () => {
      const { store } = await withOwner();
      await store.setPendingTotp(SECRET);
      await store.enableTotp([HASH_A], SECRET);
      const old = { passwordHash: 'hash-1', totpEnabled: true, totpSecretEnc: SECRET };
      expect(await store.createSession(session('1'), old)).toBe(true);
      // the same state, down to the bytes of the secret, is the same state
      expect(
        await store.createSession(session('2'), { ...old, totpSecretEnc: Buffer.from(SECRET) }),
      ).toBe(true);
      // a rotation: off, then on with another secret. The flag is the same again, the secret is not
      await store.disableTotp();
      await store.setPendingTotp(Buffer.from('rotated'));
      await store.enableTotp([HASH_B], Buffer.from('rotated'));
      expect((await store.owner())?.totpEnabled).toBe(true);
      expect(await store.createSession(session('3'), old)).toBe(false);
      expect(
        await store.createSession(session('3'), { ...old, totpSecretEnc: Buffer.from('rotated') }),
      ).toBe(true);
    });

    it('never outlives a password change that races it: the new session is refused or ended', async () => {
      const { store } = await withOwner();
      await create(store, session('1')); // the session that changes the password
      const [made, changed] = await Promise.all([
        store.createSession(session('2'), STATE), // a login that checked the old password
        store.replacePassword('hash-2', 'hash-1', '1'.repeat(64), T0 + MIN),
      ]);
      expect(changed).not.toBeNull();
      const left = (await store.sessions(T0 + MIN)).map((row) => row.idHash[0]);
      expect(left).toEqual(['1']); // whether `made` was refused or made and then ended
      expect(typeof made).toBe('boolean');
    });

    it('finds a session while it is valid, and not before it is made, after it expires or once revoked', async () => {
      const { store } = await make();
      await create(store, session('1', T0, T0 + DAY));
      expect(await store.session('1'.repeat(64), T0)).toEqual({
        idHash: '1'.repeat(64),
        createdAt: T0,
        lastSeenAt: T0,
        expiresAt: T0 + DAY,
      });
      expect(await store.session('1'.repeat(64), T0 + DAY - 1)).not.toBeNull();
      expect(await store.session('1'.repeat(64), T0 + DAY)).toBeNull();
      expect(await store.session('2'.repeat(64), T0)).toBeNull();

      await store.revoke('1'.repeat(64), T0 + MIN);
      expect(await store.session('1'.repeat(64), T0 + MIN)).toBeNull();
    });

    it('moves the end of a session when it is used, and does not bring a revoked one back', async () => {
      const { store } = await make();
      await create(store, session('1'));
      await store.touchSession('1'.repeat(64), T0 + 3 * MIN, T0 + 2 * DAY);
      expect(await store.session('1'.repeat(64), T0 + 3 * MIN)).toMatchObject({
        lastSeenAt: T0 + 3 * MIN,
        expiresAt: T0 + 2 * DAY,
      });
      await store.revoke('1'.repeat(64), T0 + 4 * MIN);
      await store.touchSession('1'.repeat(64), T0 + 5 * MIN, T0 + 3 * DAY);
      expect(await store.session('1'.repeat(64), T0 + 5 * MIN)).toBeNull();
    });

    it('lists the valid sessions, newest first', async () => {
      const { store } = await make();
      await create(store, session('1', T0));
      await create(store, session('2', T0 + MIN));
      await create(store, session('3', T0 + 2 * MIN, T0 + 2 * MIN + 5)); // ends soon
      await create(store, session('4', T0 + 3 * MIN));
      await store.revoke('4'.repeat(64), T0 + 4 * MIN);
      const listed = await store.sessions(T0 + 10 * MIN);
      expect(listed.map((row) => row.idHash[0])).toEqual(['2', '1']);
    });

    it('revokes by the first 16 characters, only a valid session, once', async () => {
      const { store } = await make();
      await create(store, session('a'));
      await create(store, session('b', T0, T0 + 5));
      await create(store, session('d', T0, T0 + MIN)); // expires at the very moment
      expect(await store.revokeByPublicId('a'.repeat(16), T0 + MIN)).toBe('a'.repeat(64));
      expect(await store.revokeByPublicId('a'.repeat(16), T0 + MIN)).toBeNull();
      expect(await store.revokeByPublicId('b'.repeat(16), T0 + MIN)).toBeNull(); // expired
      expect(await store.revokeByPublicId('d'.repeat(16), T0 + MIN)).toBeNull(); // expires now
      expect(await store.revokeByPublicId('c'.repeat(16), T0 + MIN)).toBeNull();
      expect(await store.session('a'.repeat(64), T0 + MIN)).toBeNull();
    });

    it('revokes nothing when two valid sessions share the 16 characters', async () => {
      const { store } = await make();
      await create(store, session('a'));
      await store.createSession(
        { ...session('a'), idHash: `${'a'.repeat(16)}${'b'.repeat(48)}` },
        STATE,
      );
      expect(await store.revokeByPublicId('a'.repeat(16), T0 + MIN)).toBeNull();
      expect(await store.sessions(T0 + MIN)).toHaveLength(2);
    });

    it('revokes every valid session except one', async () => {
      const { store } = await make();
      for (const id of ['1', '2', '3']) await create(store, session(id));
      await create(store, session('4', T0, T0 + MIN)); // expires at the very moment: nothing left to end
      expect(await store.revokeAllExcept('2'.repeat(64), T0 + MIN)).toBe(2);
      expect((await store.sessions(T0 + MIN)).map((row) => row.idHash[0])).toEqual(['2']);
      expect(await store.revokeAllExcept(null, T0 + 2 * MIN)).toBe(1);
      expect(await store.sessions(T0 + 2 * MIN)).toEqual([]);
    });
  });

  describe(`${name}: login attempts`, () => {
    it('counts a try as a failure from the moment it is admitted, and a success ends the count', async () => {
      const { store } = await make();
      const first = await admit(store, 'ip-1', T0);
      expect(first.client).toEqual([]);
      expect((await admit(store, 'ip-1', T0 + MIN)).client).toEqual([T0]);
      await store.succeedAttempt(idOf(first.admission));
      // the first try succeeded, so the second one (which came after it) is the only failure left
      expect((await admit(store, 'ip-1', T0 + 2 * MIN)).client).toEqual([T0 + MIN]);
    });

    it('counts a failure that has the same millisecond as the success before it', async () => {
      const { store } = await make();
      const first = await admit(store, 'ip-1', T0);
      await store.succeedAttempt(idOf(first.admission));
      await admit(store, 'ip-1', T0);
      expect((await admit(store, 'ip-1', T0)).client).toEqual([T0]);
    });

    it('shows the newest failures, oldest first, inside the window, of the client asked', async () => {
      const { store } = await make();
      for (let i = 0; i < 6; i += 1) await admit(store, 'ip-1', T0 + i * MIN);
      await admit(store, 'ip-2', T0 + 10 * MIN);
      const late = T0 + 20 * MIN;
      expect(
        (await admit(store, 'ip-1', late, { since: T0 + 90_000, clientLimit: 3 })).client,
      ).toEqual([T0 + 3 * MIN, T0 + 4 * MIN, T0 + 5 * MIN]);
      expect((await admit(store, 'ip-2', late)).client).toEqual([T0 + 10 * MIN]);
      expect((await admit(store, 'ip-3', late)).client).toEqual([]);
    });

    it('counts only the failures inside the window, and not one exactly at its start', async () => {
      const { store } = await make();
      await admit(store, 'ip-1', T0);
      await admit(store, 'ip-1', T0 + MIN);
      await admit(store, 'ip-1', T0 + 2 * MIN);
      const shown = await admit(store, 'ip-1', T0 + 3 * MIN, { since: T0 + MIN });
      expect(shown.client).toEqual([T0 + 2 * MIN]);
    });

    it('forgives the failures a client had before its own success, and no client is forgiven by another', async () => {
      const { store } = await make();
      await admit(store, 'ip-1', T0); // a failure of ip-1
      const entered = await admit(store, 'ip-1', T0 + 1);
      await store.succeedAttempt(idOf(entered.admission));
      const other = await admit(store, 'ip-2', T0 + 2);
      await store.succeedAttempt(idOf(other.admission));
      await admit(store, 'ip-3', T0 + 3); // a failure of ip-3, before the success of ip-4 below
      const fourth = await admit(store, 'ip-4', T0 + 4);
      await store.succeedAttempt(idOf(fourth.admission));
      expect((await admit(store, 'ip-1', T0 + 5)).client).toEqual([]);
      expect((await admit(store, 'ip-3', T0 + 6)).client).toEqual([T0 + 3]);
    });

    it('shows the failures of everybody together, and a success of one client does not clear the others', async () => {
      const { store } = await make();
      const a = await admit(store, 'ip-1', T0);
      await admit(store, 'ip-2', T0 + MIN);
      await admit(store, 'ip-3', T0 + 2 * MIN);
      await store.succeedAttempt(idOf(a.admission));
      const at = T0 + 3 * MIN;
      expect((await admit(store, 'ip-4', at)).total).toEqual([T0 + MIN, T0 + 2 * MIN]);
      expect((await admit(store, 'ip-4', at + 1, { totalLimit: 2 })).total).toEqual([
        T0 + 2 * MIN,
        at,
      ]);
      expect((await admit(store, 'ip-4', at + 2, { since: T0 + MIN })).total).toEqual([
        T0 + 2 * MIN,
        at,
        at + 1,
      ]);
    });

    it('tells whether the client has got in before, inside the time the caller names', async () => {
      const { store } = await make();
      const first = await admit(store, 'ip-1', T0);
      expect(first.known).toBe(false);
      await store.succeedAttempt(idOf(first.admission));
      expect((await admit(store, 'ip-1', T0 + MIN)).known).toBe(true);
      expect((await admit(store, 'ip-1', T0 + MIN, { knownSince: T0 + 1 })).known).toBe(false); // too long ago
      expect((await admit(store, 'ip-1', T0 + MIN, { knownSince: T0 })).known).toBe(false); // exactly at the start
      expect((await admit(store, 'ip-2', T0 + MIN)).known).toBe(false); // another client
    });

    it('reads no failures of everybody when the limit is zero (a try that needs a session)', async () => {
      const { store } = await make();
      await admit(store, 'ip-1', T0);
      await admit(store, 'ip-2', T0 + 1);
      expect((await admit(store, 'ip-3', T0 + 2, { totalLimit: 0 })).total).toEqual([]);
      expect((await admit(store, 'ip-3', T0 + 3)).total).toHaveLength(3);
    });

    it('forgets the failed tries of everybody and keeps the ones that got in (those clients stay known)', async () => {
      const harness = await make();
      const { store } = harness;
      const first = await admit(store, 'ip-1', T0);
      await store.succeedAttempt(idOf(first.admission));
      await admit(store, 'ip-1', T0 + 1);
      await admit(store, 'ip-2', T0 + 2);
      await admit(store, 'ip-3', T0 + 3);
      expect(await store.clearFailures()).toBe(3);
      expect(await harness.attemptCount()).toBe(1);
      const after = await admit(store, 'ip-1', T0 + MIN);
      expect(after.known).toBe(true);
      expect(after.client).toEqual([]);
      expect((await admit(store, 'ip-4', T0 + MIN)).total).toEqual([T0 + MIN]); // only the new try
      expect(await store.clearFailures()).toBe(2);
      expect(await store.clearFailures()).toBe(0);
    });

    it('writes nothing when the rule refuses a try, and says for how long', async () => {
      const harness = await make();
      const refuse: AdmissionRule = () => ({ allowed: false, retryAfterMs: 4000 });
      const result = await admit(harness.store, 'ip-1', T0, { rule: refuse });
      expect(result.admission).toEqual({ allowed: false, retryAfterMs: 4000 });
      expect(await harness.attemptCount()).toBe(0);
    });

    it('is one step: of twenty tries at the same time, as many get in as the rule lets in', async () => {
      const harness = await make();
      const fiveOnly: AdmissionRule = (client) =>
        client.length >= 5 ? { allowed: false, retryAfterMs: 1000 } : { allowed: true };
      const results = await Promise.all(
        Array.from({ length: 20 }, () => admit(harness.store, 'ip-1', T0, { rule: fiveOnly })),
      );
      expect(results.filter((result) => result.admission.allowed)).toHaveLength(5);
      expect(await harness.attemptCount()).toBe(5);
    });
  });
  describe(`${name}: audit and purge`, () => {
    it('writes the audit with what happened, to whom and when', async () => {
      const harness = await make();
      await harness.store.audit({ type: 'LOGIN', success: false, ipHash: 'ip-1' }, T0);
      await harness.store.audit(
        { type: 'PASSWORD_CHANGED', success: true, ipHash: null, detail: { sessionsEnded: 2 } },
        T0 + MIN,
      );
      expect(await harness.audit()).toEqual([
        { type: 'LOGIN', success: false, ipHash: 'ip-1', at: T0, detail: {} },
        {
          type: 'PASSWORD_CHANGED',
          success: true,
          ipHash: null,
          at: T0 + MIN,
          detail: { sessionsEnded: 2 },
        },
      ]);
    });

    it('removes what is past its keeping time and nothing else', async () => {
      const harness = await make();
      const { store } = harness;
      const now = T0 + 400 * DAY;
      await create(store, session('1', now - 3 * DAY, now - 2 * DAY)); // expired two days ago
      await create(store, session('2', now - 3 * DAY, now - 3 * DAY + MIN)); // expired three days ago
      await create(store, session('3', now - 20 * DAY, now + DAY)); // revoked 10 days ago, below
      await store.revoke('3'.repeat(64), now - 10 * DAY);
      await create(store, session('4', now - 2 * DAY, now + DAY)); // revoked yesterday
      await store.revoke('4'.repeat(64), now - DAY);
      await create(store, session('5', now - DAY, now + DAY)); // valid

      await admit(store, 'ip', now - 40 * DAY, { since: now - 60 * DAY });
      await admit(store, 'ip', now - DAY, { since: now - 60 * DAY });
      await store.audit({ type: 'LOGIN', success: true, ipHash: null }, now - 400 * DAY);
      await store.audit({ type: 'LOGIN', success: true, ipHash: null }, now - 100 * DAY); // audit is kept a year
      await store.audit({ type: 'LOGIN', success: true, ipHash: null }, now - DAY);

      const counts = await store.purge(now, DEFAULT_PURGE_POLICY);
      // two of the expired sessions are older than a day, and the one revoked 10 days ago is older than 7
      expect(counts).toEqual({ sessions: 3, loginAttempts: 1, audit: 1 });
      expect((await store.sessions(now)).map((row) => row.idHash[0])).toEqual(['5']);
      expect(await harness.attemptCount()).toBe(1);
      expect(await harness.audit()).toHaveLength(2);
      expect(await store.purge(now, DEFAULT_PURGE_POLICY)).toEqual({
        sessions: 0,
        loginAttempts: 0,
        audit: 0,
      });
    });
  });
}
