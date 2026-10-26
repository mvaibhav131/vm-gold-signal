import { describe, expect, it } from 'vitest';

import { problemSchema } from '@vmgs/contracts';

import { OWNER, TEST_ARGON, makeHarness } from '../testing/harness';
import { SecretHasher } from './hasher';
import { Limiter } from './limiter';

const LOGIN = '/api/v1/auth/login';
const PASSWORD = '/api/v1/auth/password';
const MIN = 60_000;

/** A hasher that can be made to stop after it has checked or made a hash, so that a test can act in the middle of a request. */
class GatedHasher extends SecretHasher {
  verifyGate: Promise<void> | null = null;
  hashGate: Promise<void> | null = null;
  hashed = 0;

  constructor() {
    super(TEST_ARGON, new Limiter(8, 64));
  }

  override async verify(hashed: string, secret: string): Promise<boolean> {
    const result = await super.verify(hashed, secret);
    if (this.verifyGate !== null) await this.verifyGate;
    return result;
  }

  override async hash(secret: string): Promise<string> {
    this.hashed += 1;
    const result = await super.hash(secret);
    if (this.hashGate !== null) await this.hashGate;
    return result;
  }
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

describe('a change that comes while a request is being worked out', () => {
  it('refuses a login that checked the old password: no session outlives a password reset', async () => {
    const hasher = new GatedHasher();
    const h = await makeHarness({ hasher });
    const held = gate();
    hasher.verifyGate = held.promise;

    const login = h.send({ url: LOGIN, body: OWNER }); // right password, stopped after the check
    await tick();
    hasher.verifyGate = null;
    await h.store.setPasswordHash(await hasher.hash('a reset password phrase'), h.clock.now);
    await h.store.revokeAllExcept(null, h.clock.now); // what the command on the server does
    held.open();

    const reply = await login;
    expect(reply.status).toBe(401);
    expect(reply.cookie).toBeNull();
    expect(await h.store.sessions(h.clock.now)).toEqual([]);
    // and the audit says the login failed, not that it worked
    expect(
      h.store.auditLog.filter((event) => event.type === 'LOGIN').map((event) => event.success),
    ).toEqual([false]);
  });

  it('refuses a login that checked a state without the second step when it was turned on meanwhile', async () => {
    const hasher = new GatedHasher();
    const h = await makeHarness({ hasher });
    const held = gate();
    hasher.verifyGate = held.promise;

    const login = h.send({ url: LOGIN, body: OWNER });
    await tick();
    hasher.verifyGate = null;
    // the owner turns the second step on from a session of their own while the password is being checked
    await h.store.setPendingTotp(Buffer.from('sealed'));
    await h.store.enableTotp(['a'.repeat(64)], Buffer.from('sealed'));
    held.open();

    expect((await login).status).toBe(401);
    expect(await h.store.sessions(h.clock.now)).toEqual([]);
  });

  it('refuses a login that checked the old second step when it was turned off and on again with a new secret meanwhile', async () => {
    const hasher = new GatedHasher();
    const h = await makeHarness({ hasher });
    const cookie = await h.login();
    const toSecret = (reply: { json: () => unknown }) =>
      (reply.json() as { secret: string }).secret;
    const a = toSecret(await h.send({ url: '/api/v1/auth/totp/setup', method: 'POST', cookie }));
    await h.send({ url: '/api/v1/auth/totp/enable', body: { code: await h.code(a) }, cookie });
    h.clock.advance(5 * MIN);

    // the login brings the code of the NEXT step: it is the highest one used, so the replay guard cannot be what stops it
    const held = gate();
    hasher.verifyGate = held.promise;
    const login = h.send({
      url: LOGIN,
      body: { ...OWNER, totp: await h.code(a, 30) },
      ip: '198.51.100.30',
    });
    await tick();
    hasher.verifyGate = null;

    // the owner rotates the second step (the codes are of the steps before it): off, then on with a new secret
    const off = await h.send({
      url: '/api/v1/auth/totp/disable',
      body: { code: await h.code(a, -30) },
      cookie,
    });
    expect(off.status).toBe(204);
    const b = toSecret(await h.send({ url: '/api/v1/auth/totp/setup', method: 'POST', cookie }));
    const on = await h.send({
      url: '/api/v1/auth/totp/enable',
      body: { code: await h.code(b) },
      cookie,
    });
    expect(on.status).toBe(200);
    expect((await h.store.owner())?.totpEnabled).toBe(true); // the flag is what it was; the secret is not
    held.open();

    expect((await login).status).toBe(401);
    expect((await h.store.sessions(h.clock.now)).length).toBe(1); // only the owner's own session
  });

  it('does not overwrite a password that was reset on the server while the new one was being hashed', async () => {
    const hasher = new GatedHasher();
    const h = await makeHarness({ hasher });
    const cookie = await h.login();
    const held = gate();
    hasher.hashGate = held.promise;

    const change = h.send({
      url: PASSWORD,
      body: { current: OWNER.password, next: 'an attacker chosen passphrase' },
      cookie,
    });
    await tick();
    hasher.hashGate = null;
    const reset = await hasher.hash('the reset the owner made');
    await h.store.setPasswordHash(reset, h.clock.now);
    held.open();

    const reply = await change;
    expect(reply.status).toBe(409);
    expect(problemSchema.parse(reply.json()).code).toBe('conflict');
    expect((await h.store.owner())?.passwordHash).toBe(reset);
  });

  it('does not let a session that was ended meanwhile change the password', async () => {
    const hasher = new GatedHasher();
    const h = await makeHarness({ hasher });
    const cookie = await h.login();
    const held = gate();
    hasher.hashGate = held.promise;

    const change = h.send({
      url: PASSWORD,
      body: { current: OWNER.password, next: 'an attacker chosen passphrase' },
      cookie,
    });
    await tick();
    await h.service.endToken(cookie); // the owner revokes it from the other device
    held.open();

    expect((await change).status).toBe(409);
    await h.login(); // the old password still works
  });

  it('does not turn the second step on for a secret that was replaced while its code was being checked', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const setup = await h.send({ url: '/api/v1/auth/totp/setup', method: 'POST', cookie });
    const secret = (setup.json() as { secret: string }).secret;
    const real = h.store.enableTotp.bind(h.store);
    h.store.enableTotp = async (hashes, expected) => {
      await h.store.setPendingTotp(Buffer.from('a secret from a second setup'));
      return real(hashes, expected);
    };
    const reply = await h.send({
      url: '/api/v1/auth/totp/enable',
      body: { code: await h.code(secret) },
      cookie,
    });
    expect(reply.status).toBe(409);
    expect(problemSchema.parse(reply.json()).code).toBe('conflict');
    expect((await h.store.owner())?.totpEnabled).toBe(false);
  });
});

describe('the throttle against a swarm', () => {
  const wrong = { ...OWNER, password: 'wrong wrong wrong' };

  it('does not keep the owner out: a client that has got in before is stopped only by its own failures', async () => {
    const h = await makeHarness();
    await h.login({}, '203.0.113.99'); // the owner at home: now a known client
    h.clock.advance(MIN);
    for (let i = 0; i < 40; i += 1) {
      await h.send({ url: LOGIN, body: wrong, ip: `198.51.100.${String(i + 10)}` });
    }
    // a client that never got in is stopped, however clean its own record...
    expect((await h.send({ url: LOGIN, body: OWNER, ip: '192.0.2.200' })).status).toBe(429);
    // ...the owner's usual one is not
    expect((await h.send({ url: LOGIN, body: OWNER, ip: '203.0.113.99' })).status).toBe(204);
    // and a known client is still limited by its own failures
    for (let i = 0; i < 5; i += 1) {
      await h.send({ url: LOGIN, body: wrong, ip: '203.0.113.99' });
    }
    expect((await h.send({ url: LOGIN, body: OWNER, ip: '203.0.113.99' })).status).toBe(429);
  });

  it('does not stop a change that needs a session, whatever the swarm did', async () => {
    const h = await makeHarness();
    const cookie = await h.login({}, '203.0.113.99');
    for (let i = 0; i < 45; i += 1) {
      await h.send({ url: LOGIN, body: wrong, ip: `198.51.100.${String(i + 10)}` });
    }
    expect((await h.send({ url: LOGIN, body: OWNER, ip: '192.0.2.200' })).status).toBe(429);
    const reply = await h.send({
      url: PASSWORD,
      body: { current: OWNER.password, next: 'a different long passphrase' },
      cookie,
      ip: '192.0.2.201', // an address nobody has seen
    });
    expect(reply.status).toBe(204);
  });
});

describe('a flood of tries', () => {
  it('is answered with 429 before it reaches the database when the admissions are queued up', async () => {
    const h = await makeHarness();
    const held = gate();
    let admitted = 0;
    h.store.admit = async () => {
      admitted += 1;
      await held.promise;
      return { allowed: false, retryAfterMs: 1000 };
    };
    // 8 run, 64 wait, and from the 73rd on a request is refused at once
    const replies = Array.from({ length: 80 }, (_, i) =>
      h.send({ url: LOGIN, body: OWNER, ip: `198.51.100.${String(i + 1)}` }),
    );
    await tick();
    expect(admitted).toBe(8);
    const early = await Promise.race([Promise.all(replies.slice(72)), tick().then(() => null)]);
    expect(early).not.toBeNull();
    for (const reply of early ?? []) {
      expect(reply.status).toBe(429);
      expect(reply.res.headers['retry-after']).toBe('5');
    }
    held.open();
    const all = await Promise.all(replies);
    expect(all.every((reply) => reply.status === 429)).toBe(true);
  });

  it('does not grow the audit without a bound when every try comes from another address', async () => {
    const h = await makeHarness();
    const wrong = { ...OWNER, password: 'wrong wrong wrong' };
    for (let i = 0; i < 1300; i += 1) {
      const ip = `10.${String(Math.floor(i / 250))}.${String(i % 250)}.1`;
      await h.send({ url: LOGIN, body: wrong, ip });
    }
    const throttled = h.store.auditLog.filter((event) => event.type === 'LOGIN_THROTTLED').length;
    expect(throttled).toBeGreaterThan(100);
    expect(throttled).toBeLessThanOrEqual(1000);
    // the failures that were judged are bounded by the swarm limit, and the table of attempts does not grow past them
    expect(h.store.attempts.length).toBeLessThanOrEqual(40);
  });
});

describe('the first login after a start', () => {
  it('needs no extra hash for an unknown user once the service is warmed up', async () => {
    const hasher = new GatedHasher();
    const h = await makeHarness({ hasher, noOwner: true });
    await h.service.warmUp();
    const before = hasher.hashed;
    const reply = await h.send({ url: LOGIN, body: OWNER });
    expect(reply.status).toBe(401);
    expect(hasher.hashed).toBe(before); // one check against the ready hash, no second hash made
  });

  it('would have made one on that first login without the warm-up (which is why there is one)', async () => {
    const hasher = new GatedHasher();
    const h = await makeHarness({ hasher, noOwner: true });
    const before = hasher.hashed;
    await h.send({ url: LOGIN, body: OWNER });
    expect(hasher.hashed).toBe(before + 1);
  });
});
