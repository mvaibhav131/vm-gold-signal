import { describe, expect, it } from 'vitest';

import {
  PROBLEM_CONTENT_TYPE,
  meResponseSchema,
  problemSchema,
  sessionsResponseSchema,
  totpEnableResponseSchema,
  totpSetupResponseSchema,
} from '@vmgs/contracts';

import { SESSION_COOKIE } from './guard';
import { DEFAULT_SESSION_POLICY } from './policy';
import { OWNER, makeHarness, type Harness } from '../testing/harness';

const LOGIN = '/api/v1/auth/login';
const MIN = 60_000;
const DAY = 86_400_000;

function problemOf(reply: { json: () => unknown; res: { headers: Record<string, unknown> } }) {
  expect(String(reply.res.headers['content-type'])).toContain(PROBLEM_CONTENT_TYPE);
  return problemSchema.parse(reply.json());
}

describe('login', () => {
  it('answers 204 and sets one session cookie with every flag a session cookie needs', async () => {
    const h = await makeHarness();
    const reply = await h.send({ url: LOGIN, body: OWNER });
    expect(reply.status).toBe(204);
    expect(reply.res.body).toBe('');
    const raw = reply.res.headers['set-cookie'];
    expect(typeof raw).toBe('string'); // exactly one cookie
    const cookie = String(raw);
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43};`));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).toContain(`Max-Age=${String(DEFAULT_SESSION_POLICY.idleMs / 1000)}`);
  });

  it('keeps no token anywhere: the store holds a hash, and the sessions of two logins differ', async () => {
    const h = await makeHarness();
    const first = await h.login();
    const second = await h.login();
    expect(first).not.toBe(second);
    const rows = await h.store.sessions(h.clock.now);
    expect(rows).toHaveLength(2);
    const dump = JSON.stringify([...rows, ...h.store.attempts, ...h.store.auditLog]);
    expect(dump).not.toContain(first);
    expect(dump).not.toContain(second);
    expect(dump).not.toContain(OWNER.password);
    for (const row of rows) expect(row.idHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same 401 for a wrong password, a wrong user name and a missing owner', async () => {
    const withOwner = await makeHarness();
    const wrongPassword = await withOwner.send({
      url: LOGIN,
      body: { ...OWNER, password: 'wrong wrong wrong' },
    });
    const wrongUser = await withOwner.send({
      url: LOGIN,
      body: { ...OWNER, username: 'somebody' },
    });
    const noOwner = await (await makeHarness({ noOwner: true })).send({ url: LOGIN, body: OWNER });

    for (const reply of [wrongPassword, wrongUser, noOwner]) {
      expect(reply.status).toBe(401);
      expect(reply.cookie).toBeNull();
      expect(reply.res.headers['set-cookie']).toBeUndefined();
      expect(problemOf(reply)).toMatchObject({
        status: 401,
        code: 'invalid_credentials',
        detail: 'Login failed.',
      });
    }
    expect(wrongPassword.res.body).toBe(wrongUser.res.body);
    expect(wrongPassword.res.body).toBe(noOwner.res.body);
    expect(Object.keys(wrongPassword.res.headers).sort()).toEqual(
      Object.keys(wrongUser.res.headers).sort(),
    );
  });

  it('checks the password even when the user name is wrong or there is no owner (the same work either way)', async () => {
    const calls: string[] = [];
    const h = await makeHarness();
    const real = h.hasher.verify.bind(h.hasher);
    h.hasher.verify = (hashed, secret) => {
      calls.push(hashed.slice(0, 9));
      return real(hashed, secret);
    };
    await h.send({ url: LOGIN, body: { ...OWNER, username: 'somebody' } });
    await h.send({ url: LOGIN, body: { ...OWNER, password: 'wrong wrong wrong' } });
    expect(calls).toEqual(['$argon2id', '$argon2id']);

    const none = await makeHarness({ noOwner: true });
    let dummyUsed = 0;
    const realNone = none.hasher.verify.bind(none.hasher);
    none.hasher.verify = (hashed, secret) => {
      dummyUsed += 1;
      return realNone(hashed, secret);
    };
    await none.send({ url: LOGIN, body: OWNER });
    expect(dummyUsed).toBe(1);
  });

  it('refuses a body that does not match the contract with 400 and never says what was in it', async () => {
    const h = await makeHarness();
    for (const body of [
      { username: 'owner' },
      { password: 'x' },
      { ...OWNER, extra: 1 },
      { ...OWNER, totp: '12345' },
      { username: '', password: 'x' },
      { ...OWNER, password: 'x'.repeat(1025) },
    ]) {
      const reply = await h.send({ url: LOGIN, body });
      expect(reply.status, JSON.stringify(Object.keys(body))).toBe(400);
      expect(problemOf(reply).code).toBe('invalid_request');
      expect(reply.res.body).not.toContain('x'.repeat(30));
      expect(reply.res.body).not.toContain(OWNER.password);
    }
    expect(h.store.attempts).toHaveLength(0); // nothing was tried, so nothing was counted
  });

  it('starts a new session when one is held: the old cookie stops working (no fixation)', async () => {
    const h = await makeHarness();
    const old = await h.login();
    const reply = await h.send({ url: LOGIN, body: OWNER, cookie: old });
    expect(reply.status).toBe(204);
    expect(reply.cookie).not.toBe(old);
    expect((await h.send({ url: '/api/v1/auth/me', cookie: old })).status).toBe(401);
    expect((await h.send({ url: '/api/v1/auth/me', cookie: reply.cookie })).status).toBe(200);
  });

  it('writes what happened to the audit, and nothing that was typed', async () => {
    const h = await makeHarness();
    await h.send({ url: LOGIN, body: { ...OWNER, password: 'wrong wrong wrong' } });
    await h.login();
    expect(h.store.auditLog.map((event) => [event.type, event.success])).toEqual([
      ['LOGIN', false],
      ['LOGIN', true],
    ]);
    const dump = JSON.stringify(h.store.auditLog);
    expect(dump).not.toContain('wrong wrong wrong');
    expect(dump).not.toContain(OWNER.password);
    expect(dump).not.toContain(OWNER.username);
    expect(dump).not.toContain('203.0.113.7'); // the address is a keyed hash
  });
});

describe('the session of a request', () => {
  it('tells who is logged in, in the shape of the contract', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const reply = await h.send({ url: '/api/v1/auth/me', cookie });
    expect(reply.status).toBe(200);
    const me = meResponseSchema.parse(reply.json());
    expect(me).toEqual({
      username: 'owner',
      totpEnabled: false,
      sessionExpiresAt: new Date(h.clock.now + DEFAULT_SESSION_POLICY.idleMs).toISOString(),
    });
  });

  it('is ended by a logout: 204, the cookie is cleared, and the old cookie is dead', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const out = await h.send({ url: '/api/v1/auth/logout', method: 'POST', cookie });
    expect(out.status).toBe(204);
    const cleared = String(out.res.headers['set-cookie']);
    expect(cleared).toContain(`${SESSION_COOKIE}=;`);
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect(cleared).toContain('Secure');
    expect(cleared).toContain('HttpOnly');
    expect((await h.send({ url: '/api/v1/auth/me', cookie })).status).toBe(401);
    expect(h.store.auditLog.map((event) => event.type)).toContain('LOGOUT');
  });

  it('is extended while it is used, at most every ten minutes, and the cookie is sent again with the new lifetime', async () => {
    const h = await makeHarness();
    const cookie = await h.login();

    h.clock.advance(5 * MIN);
    const early = await h.send({ url: '/api/v1/auth/me', cookie });
    expect(early.res.headers['set-cookie']).toBeUndefined();

    h.clock.advance(6 * MIN); // 11 minutes since the login
    const later = await h.send({ url: '/api/v1/auth/me', cookie });
    expect(later.status).toBe(200);
    const refreshed = String(later.res.headers['set-cookie']);
    expect(refreshed).toContain(`${SESSION_COOKIE}=${cookie};`);
    expect(refreshed).toContain(`Max-Age=${String(DEFAULT_SESSION_POLICY.idleMs / 1000)}`);
    expect(meResponseSchema.parse(later.json()).sessionExpiresAt).toBe(
      new Date(h.clock.now + DEFAULT_SESSION_POLICY.idleMs).toISOString(),
    );
  });

  it('is extended at exactly ten minutes after it was last seen, and not a millisecond before', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    h.clock.advance(10 * MIN - 1);
    const early = await h.send({ url: '/api/v1/auth/me', cookie });
    expect(early.res.headers['set-cookie']).toBeUndefined();
    h.clock.advance(1);
    const due = await h.send({ url: '/api/v1/auth/me', cookie });
    expect(String(due.res.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=${cookie};`);
  });

  it('ends after seven days without use', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    h.clock.advance(DEFAULT_SESSION_POLICY.idleMs - MIN);
    expect((await h.send({ url: '/api/v1/auth/me', cookie })).status).toBe(200);
    h.clock.advance(DEFAULT_SESSION_POLICY.idleMs + MIN);
    const reply = await h.send({ url: '/api/v1/auth/me', cookie });
    expect(reply.status).toBe(401);
    expect(String(reply.res.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=;`);
  });

  it('ends thirty days after the login however often it is used', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    let lastStatus = 200;
    for (let day = 1; day <= 31; day += 1) {
      h.clock.advance(DAY);
      lastStatus = (await h.send({ url: '/api/v1/auth/me', cookie })).status;
      if (day < 30) expect(lastStatus, `day ${String(day)}`).toBe(200);
    }
    expect(lastStatus).toBe(401);
  });

  it('is refused for a cookie that is not a token, a token nobody made, or a revoked one', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    for (const bad of [
      'x',
      'x'.repeat(43),
      `${cookie.slice(0, -1)}${cookie.endsWith('A') ? 'B' : 'A'}`,
    ]) {
      expect((await h.send({ url: '/api/v1/auth/me', cookie: bad })).status, bad).toBe(401);
    }
    await h.service.endToken(cookie);
    expect((await h.send({ url: '/api/v1/auth/me', cookie })).status).toBe(401);
  });
});

describe('throttling', () => {
  const wrong = { ...OWNER, password: 'wrong wrong wrong' };

  it('stops a client after five failures, even with the right password, and says for how long', async () => {
    const h = await makeHarness();
    for (let i = 0; i < 5; i += 1) {
      expect((await h.send({ url: LOGIN, body: wrong })).status).toBe(401);
    }
    const stopped = await h.send({ url: LOGIN, body: OWNER });
    expect(stopped.status).toBe(429);
    expect(problemOf(stopped)).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(stopped.res.headers['retry-after']).toBe('900');
    expect(stopped.cookie).toBeNull();
    // the refused request was not counted as another failure
    expect(h.store.attempts).toHaveLength(5);
  });

  it('lets the client in again when the oldest failure has left the window', async () => {
    const h = await makeHarness();
    for (let i = 0; i < 5; i += 1) {
      await h.send({ url: LOGIN, body: wrong });
      h.clock.advance(1000);
    }
    expect((await h.send({ url: LOGIN, body: OWNER })).status).toBe(429);
    h.clock.advance(15 * MIN - 5000 + 1); // the oldest failure is now 15 minutes old
    expect((await h.send({ url: LOGIN, body: OWNER })).status).toBe(204);
  });

  it('forgives a client that gets in: the count starts again', async () => {
    const h = await makeHarness();
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 4; i += 1) await h.send({ url: LOGIN, body: wrong });
      h.clock.advance(1000);
      expect((await h.send({ url: LOGIN, body: OWNER })).status).toBe(204);
      h.clock.advance(1000);
    }
  });

  it('counts a client by its address, so another address is not stopped', async () => {
    const h = await makeHarness();
    for (let i = 0; i < 5; i += 1) await h.send({ url: LOGIN, body: wrong });
    expect((await h.send({ url: LOGIN, body: OWNER })).status).toBe(429);
    expect((await h.send({ url: LOGIN, body: OWNER, ip: '198.51.100.9' })).status).toBe(204);
  });

  it('counts all the addresses of an IPv6 /64 as one client', async () => {
    const h = await makeHarness();
    for (let i = 0; i < 5; i += 1) {
      await h.send({
        url: LOGIN,
        body: wrong,
        ip: `2001:db8:1:2:${i.toString(16)}::${(i + 1).toString(16)}`,
      });
    }
    expect((await h.send({ url: LOGIN, body: OWNER, ip: '2001:db8:1:2:ffff::1' })).status).toBe(
      429,
    );
    expect((await h.send({ url: LOGIN, body: OWNER, ip: '2001:db8:1:3::1' })).status).toBe(204);
  });

  it('stops everybody when forty failures came from many addresses (a guess spread over a botnet)', async () => {
    const h = await makeHarness();
    for (let i = 0; i < 40; i += 1) {
      await h.send({ url: LOGIN, body: wrong, ip: `198.51.100.${String(i + 10)}` });
    }
    const owner = await h.send({ url: LOGIN, body: OWNER, ip: '192.0.2.200' });
    expect(owner.status).toBe(429);
    expect(owner.res.headers['retry-after']).toBeDefined();
    h.clock.advance(16 * MIN);
    expect((await h.send({ url: LOGIN, body: OWNER, ip: '192.0.2.200' })).status).toBe(204);
  });

  it('does not stop a client that got in less than thirty days ago when many addresses fail, and stops it after that', async () => {
    const h = await makeHarness();
    const known = '192.0.2.77';
    const stale = '192.0.2.78';
    expect((await h.send({ url: LOGIN, body: OWNER, ip: known })).status).toBe(204);
    expect((await h.send({ url: LOGIN, body: OWNER, ip: stale })).status).toBe(204);
    const spread = async () => {
      for (let i = 0; i < 40; i += 1) {
        await h.send({ url: LOGIN, body: wrong, ip: `198.51.100.${String(i + 10)}` });
      }
    };

    h.clock.advance(29 * DAY);
    await spread();
    expect((await h.send({ url: LOGIN, body: OWNER, ip: '192.0.2.200' })).status).toBe(429);
    expect((await h.send({ url: LOGIN, body: OWNER, ip: known })).status).toBe(204); // gets in again: known anew

    h.clock.advance(2 * DAY); // thirty-one days since the stale client got in
    await spread();
    expect((await h.send({ url: LOGIN, body: OWNER, ip: stale })).status).toBe(429);
    expect((await h.send({ url: LOGIN, body: OWNER, ip: known })).status).toBe(204);
  });

  it('writes one audit line for a throttled client, not one for every request', async () => {
    const h = await makeHarness();
    for (let i = 0; i < 5; i += 1) await h.send({ url: LOGIN, body: wrong });
    for (let i = 0; i < 20; i += 1) await h.send({ url: LOGIN, body: wrong });
    expect(h.store.auditLog.filter((event) => event.type === 'LOGIN_THROTTLED')).toHaveLength(1);
    h.clock.advance(16 * MIN);
    for (let i = 0; i < 6; i += 1) await h.send({ url: LOGIN, body: wrong });
    expect(h.store.auditLog.filter((event) => event.type === 'LOGIN_THROTTLED')).toHaveLength(2);
  });

  it('counts a burst of parallel tries: they do not all get a turn', async () => {
    const h = await makeHarness();
    const replies = await Promise.all(
      Array.from({ length: 30 }, () => h.send({ url: LOGIN, body: wrong })),
    );
    const judged = replies.filter((reply) => reply.status === 401).length;
    const refused = replies.filter((reply) => reply.status === 429).length;
    expect(judged + refused).toBe(30);
    expect(judged).toBeLessThan(30);
    expect((await h.send({ url: LOGIN, body: OWNER })).status).toBe(429);
  });

  it('answers 429 for a password check that finds the queue full, and keeps the owner out of nothing else', async () => {
    const { Limiter } = await import('./limiter');
    const { SecretHasher } = await import('./hasher');
    const hasher = new SecretHasher(
      { memoryCost: 1024, timeCost: 1, parallelism: 1 },
      new Limiter(1, 0),
    );
    const h = await makeHarness({ hasher });
    const [a, b] = await Promise.all([
      h.send({ url: LOGIN, body: OWNER }),
      h.send({ url: LOGIN, body: OWNER, ip: '198.51.100.9' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([204, 429]);
    const busy = a.status === 429 ? a : b;
    expect(problemOf(busy).code).toBe('rate_limited');
    expect(busy.res.headers['retry-after']).toBe('5');
  });
});

describe('changing the password', () => {
  const NEXT = 'a different long passphrase';

  it('needs the current one, and a wrong one is 403 and counts against the client', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const reply = await h.send({
      url: '/api/v1/auth/password',
      body: { current: 'wrong wrong wrong', next: NEXT },
      cookie,
    });
    expect(reply.status).toBe(403);
    expect(problemOf(reply).code).toBe('wrong_password');
    expect(h.store.attempts.filter((attempt) => !attempt.success)).toHaveLength(1);
    expect((await h.store.owner())?.passwordHash).not.toBe('');
    // the old password still works
    await h.login();
  });

  it('is stopped after five wrong current passwords like a login is', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    for (let i = 0; i < 5; i += 1) {
      await h.send({
        url: '/api/v1/auth/password',
        body: { current: 'wrong wrong wrong', next: NEXT },
        cookie,
      });
    }
    const reply = await h.send({
      url: '/api/v1/auth/password',
      body: { current: OWNER.password, next: NEXT },
      cookie,
    });
    expect(reply.status).toBe(429);
  });

  it('refuses a new password that is short (400) or the same as the current one (400)', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const short = await h.send({
      url: '/api/v1/auth/password',
      body: { current: OWNER.password, next: 'short' },
      cookie,
    });
    expect(short.status).toBe(400);
    expect(problemOf(short).code).toBe('invalid_request');
    const same = await h.send({
      url: '/api/v1/auth/password',
      body: { current: OWNER.password, next: OWNER.password },
      cookie,
    });
    expect(same.status).toBe(400);
    expect(problemOf(same).code).toBe('password_unchanged');
    await h.login(); // nothing changed
  });

  it('changes it, ends every other session, keeps this one and writes it to the audit', async () => {
    const h = await makeHarness();
    const phone = await h.login();
    const laptop = await h.login({}, '198.51.100.9');
    const reply = await h.send({
      url: '/api/v1/auth/password',
      body: { current: OWNER.password, next: NEXT },
      cookie: phone,
    });
    expect(reply.status).toBe(204);

    expect((await h.send({ url: '/api/v1/auth/me', cookie: phone })).status).toBe(200);
    expect((await h.send({ url: '/api/v1/auth/me', cookie: laptop })).status).toBe(401);
    expect((await h.send({ url: LOGIN, body: OWNER })).status).toBe(401);
    expect((await h.send({ url: LOGIN, body: { ...OWNER, password: NEXT } })).status).toBe(204);
    const changed = h.store.auditLog.find((event) => event.type === 'PASSWORD_CHANGED');
    expect(changed).toMatchObject({ success: true, detail: { sessionsEnded: 1 } });
    expect(JSON.stringify(h.store.auditLog)).not.toContain(NEXT);
  });
});

describe('the second step', () => {
  async function withTotp(
    h: Harness,
    cookie: string,
  ): Promise<{ secret: string; codes: string[] }> {
    const setup = await h.send({ url: '/api/v1/auth/totp/setup', method: 'POST', cookie });
    expect(setup.status).toBe(200);
    const { secret } = totpSetupResponseSchema.parse(setup.json());
    const enable = await h.send({
      url: '/api/v1/auth/totp/enable',
      body: { code: await h.code(secret) },
      cookie,
    });
    expect(enable.status).toBe(200);
    return { secret, codes: totpEnableResponseSchema.parse(enable.json()).recoveryCodes };
  }

  it('shows its secret once, and the table keeps it sealed', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const reply = await h.send({ url: '/api/v1/auth/totp/setup', method: 'POST', cookie });
    const setup = totpSetupResponseSchema.parse(reply.json());
    expect(setup.otpauthUrl).toContain(`secret=${setup.secret}`);
    const owner = await h.store.owner();
    expect(owner?.totpEnabled).toBe(false);
    expect(owner?.totpSecretEnc?.toString('latin1')).not.toContain(setup.secret);
    const me = meResponseSchema.parse((await h.send({ url: '/api/v1/auth/me', cookie })).json());
    expect(me.totpEnabled).toBe(false);
  });

  it('turns on only with a code from the app, and then shows the eight recovery codes once', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const setup = totpSetupResponseSchema.parse(
      (await h.send({ url: '/api/v1/auth/totp/setup', method: 'POST', cookie })).json(),
    );

    const wrong = await h.send({
      url: '/api/v1/auth/totp/enable',
      body: { code: '000000' },
      cookie,
    });
    expect(wrong.status).toBe(400);
    expect(problemOf(wrong).code).toBe('invalid_code');
    expect((await h.store.owner())?.totpEnabled).toBe(false);

    const right = await h.send({
      url: '/api/v1/auth/totp/enable',
      body: { code: await h.code(setup.secret) },
      cookie,
    });
    expect(right.status).toBe(200);
    const { recoveryCodes } = totpEnableResponseSchema.parse(right.json());
    expect(new Set(recoveryCodes).size).toBe(8);
    const owner = await h.store.owner();
    expect(owner?.totpEnabled).toBe(true);
    expect(owner?.recoveryCodeHashes).toHaveLength(8);
    expect(JSON.stringify(owner)).not.toContain(recoveryCodes[0]);
    const me = meResponseSchema.parse((await h.send({ url: '/api/v1/auth/me', cookie })).json());
    expect(me.totpEnabled).toBe(true);
  });

  it('answers 409 for a setup or an enable that does not fit the state', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const early = await h.send({
      url: '/api/v1/auth/totp/enable',
      body: { code: '123456' },
      cookie,
    });
    expect(early.status).toBe(409);
    expect(problemOf(early).code).toBe('totp_not_set_up');
    const off = await h.send({
      url: '/api/v1/auth/totp/disable',
      body: { code: '123456' },
      cookie,
    });
    expect(off.status).toBe(409);
    expect(problemOf(off).code).toBe('totp_not_enabled');

    await withTotp(h, cookie);
    for (const url of ['/api/v1/auth/totp/setup', '/api/v1/auth/totp/enable']) {
      const reply = await h.send({
        url,
        method: 'POST',
        body: url.endsWith('enable') ? { code: '123456' } : undefined,
        cookie,
      });
      expect(reply.status, url).toBe(409);
      expect(problemOf(reply).code).toBe('totp_already_enabled');
    }
  });

  it('is asked at login: without a code, with a wrong one and with a wrong password it is the same 401', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const { secret } = await withTotp(h, cookie);
    h.clock.advance(60_000);
    const bodies: string[] = [];
    for (const attempt of [
      OWNER,
      { ...OWNER, totp: '000000' },
      { ...OWNER, password: 'wrong wrong wrong', totp: await h.code(secret) },
    ]) {
      const reply = await h.send({
        url: LOGIN,
        body: attempt,
        ip: `198.51.100.${String(bodies.length + 20)}`,
      });
      expect(reply.status).toBe(401);
      bodies.push(reply.res.body);
    }
    expect(new Set(bodies).size).toBe(1);
    const ok = await h.send({
      url: LOGIN,
      body: { ...OWNER, totp: await h.code(secret) },
      ip: '198.51.100.99',
    });
    expect(ok.status).toBe(204);
  });

  it('lets a code work once: the same code a second time is refused, the next step is fine', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const { secret } = await withTotp(h, cookie);
    h.clock.advance(60_000);
    const code = await h.code(secret);
    expect((await h.send({ url: LOGIN, body: { ...OWNER, totp: code } })).status).toBe(204);
    expect(
      (await h.send({ url: LOGIN, body: { ...OWNER, totp: code }, ip: '198.51.100.9' })).status,
    ).toBe(401);
    h.clock.advance(30_000);
    expect(
      (
        await h.send({
          url: LOGIN,
          body: { ...OWNER, totp: await h.code(secret) },
          ip: '198.51.100.8',
        })
      ).status,
    ).toBe(204);
  });

  it('does not use a code up when the password was wrong', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const { secret } = await withTotp(h, cookie);
    h.clock.advance(60_000);
    const code = await h.code(secret);
    expect(
      (await h.send({ url: LOGIN, body: { ...OWNER, password: 'wrong wrong wrong', totp: code } }))
        .status,
    ).toBe(401);
    expect((await h.send({ url: LOGIN, body: { ...OWNER, totp: code } })).status).toBe(204);
  });

  it('lets a recovery code in once, in place of the app, and keeps only hashes of them', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const { codes } = await withTotp(h, cookie);
    const [first, second] = codes;
    expect((await h.send({ url: LOGIN, body: { ...OWNER, totp: first } })).status).toBe(204);
    expect(
      (await h.send({ url: LOGIN, body: { ...OWNER, totp: first }, ip: '198.51.100.9' })).status,
    ).toBe(401);
    expect(
      (await h.send({ url: LOGIN, body: { ...OWNER, totp: second }, ip: '198.51.100.8' })).status,
    ).toBe(204);
    expect((await h.store.owner())?.recoveryCodeHashes).toHaveLength(6);
    expect(h.store.auditLog.filter((event) => event.type === 'RECOVERY_CODE_USED')).toHaveLength(2);
    expect(JSON.stringify(h.store.auditLog)).not.toContain(first);
  });

  it('does not touch the table for a recovery code that is not on the list', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    await withTotp(h, cookie);
    let used = 0;
    const real = h.store.useRecoveryCode.bind(h.store);
    h.store.useRecoveryCode = (hash: string) => {
      used += 1;
      return real(hash);
    };
    const reply = await h.send({ url: LOGIN, body: { ...OWNER, totp: 'abcd-efgh' } });
    expect(reply.status).toBe(401);
    expect(used).toBe(0);
  });

  it('is turned off with a code from the app, not with a wrong one', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const { secret } = await withTotp(h, cookie);
    h.clock.advance(60_000);
    const wrong = await h.send({
      url: '/api/v1/auth/totp/disable',
      body: { code: '000000' },
      cookie,
    });
    expect(wrong.status).toBe(400);
    expect(problemOf(wrong).code).toBe('invalid_code');
    expect((await h.store.owner())?.totpEnabled).toBe(true);

    const right = await h.send({
      url: '/api/v1/auth/totp/disable',
      body: { code: await h.code(secret) },
      cookie,
    });
    expect(right.status).toBe(204);
    expect(await h.store.owner()).toMatchObject({
      totpEnabled: false,
      totpSecretEnc: null,
      recoveryCodeHashes: [],
    });
    await h.login(); // no code needed any more
  });

  it('counts wrong codes like wrong passwords: five of them stop the client', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    await h.send({ url: '/api/v1/auth/totp/setup', method: 'POST', cookie });
    for (let i = 0; i < 5; i += 1) {
      expect(
        (await h.send({ url: '/api/v1/auth/totp/enable', body: { code: '000000' }, cookie }))
          .status,
      ).toBe(400);
    }
    expect(
      (await h.send({ url: '/api/v1/auth/totp/enable', body: { code: '000000' }, cookie })).status,
    ).toBe(429);
  });

  it('cannot be opened when the key was changed: only the way out on the server is left (and the answer is still a plain 401)', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const { secret } = await withTotp(h, cookie);
    const { AuthService } = await import('./service');
    const { deriveKeys } = await import('./keys');
    const other = new AuthService({
      store: h.store,
      hasher: h.hasher,
      keys: deriveKeys(Buffer.alloc(32, 3)),
      now: () => h.clock.now,
    });
    h.clock.advance(60_000);
    await expect(
      other.login(
        { ...OWNER, totp: await h.code(secret) },
        { ip: IP_FOR_TEST, userAgent: undefined },
      ),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
  });
});

const IP_FOR_TEST = '203.0.113.50';

describe('sessions', () => {
  it('lists the valid ones with this one first, and the ids are not the cookie', async () => {
    const h = await makeHarness();
    const phone = await h.login();
    h.clock.advance(MIN);
    const laptop = await h.login({}, '198.51.100.9');
    const reply = await h.send({ url: '/api/v1/auth/sessions', cookie: phone });
    expect(reply.status).toBe(200);
    const { items } = sessionsResponseSchema.parse(reply.json());
    expect(items).toHaveLength(2);
    expect(items[0]?.current).toBe(true);
    expect(items[1]?.current).toBe(false);
    for (const item of items) {
      expect(item.id).toMatch(/^[0-9a-f]{16}$/);
      expect(phone.includes(item.id) || laptop.includes(item.id)).toBe(false);
    }
    // the same list seen from the laptop has the laptop first
    const other = sessionsResponseSchema.parse(
      (await h.send({ url: '/api/v1/auth/sessions', cookie: laptop })).json(),
    );
    expect(other.items[0]?.id).not.toBe(items[0]?.id);
    expect(other.items[0]?.current).toBe(true);
  });

  it('does not list what is revoked or has expired', async () => {
    const h = await makeHarness();
    const keep = await h.login();
    const gone = await h.login({}, '198.51.100.9');
    await h.service.endToken(gone);
    const { items } = sessionsResponseSchema.parse(
      (await h.send({ url: '/api/v1/auth/sessions', cookie: keep })).json(),
    );
    expect(items).toHaveLength(1);
  });

  it('revokes another session by its id: 204, and its cookie is dead at once', async () => {
    const h = await makeHarness();
    const phone = await h.login();
    const laptop = await h.login({}, '198.51.100.9');
    const { items } = sessionsResponseSchema.parse(
      (await h.send({ url: '/api/v1/auth/sessions', cookie: phone })).json(),
    );
    const other = items.find((item) => !item.current);
    const reply = await h.send({
      url: `/api/v1/auth/sessions/${other?.id ?? ''}`,
      method: 'DELETE',
      cookie: phone,
    });
    expect(reply.status).toBe(204);
    expect((await h.send({ url: '/api/v1/auth/me', cookie: laptop })).status).toBe(401);
    expect((await h.send({ url: '/api/v1/auth/me', cookie: phone })).status).toBe(200);
    expect(h.store.auditLog.find((event) => event.type === 'SESSION_REVOKED')).toMatchObject({
      detail: { current: false },
    });
  });

  it('revokes the session in use as a logout: the cookie is cleared', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const { items } = sessionsResponseSchema.parse(
      (await h.send({ url: '/api/v1/auth/sessions', cookie })).json(),
    );
    const reply = await h.send({
      url: `/api/v1/auth/sessions/${items[0]?.id ?? ''}`,
      method: 'DELETE',
      cookie,
    });
    expect(reply.status).toBe(204);
    expect(String(reply.res.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=;`);
    expect((await h.send({ url: '/api/v1/auth/me', cookie })).status).toBe(401);
  });

  it('answers 404 for an id that is not a session, of any shape', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    for (const id of [
      '0123456789abcdef',
      'short',
      'ZZZZZZZZZZZZZZZZ',
      '0123456789abcdef0123',
      '%00',
    ]) {
      const reply = await h.send({ url: `/api/v1/auth/sessions/${id}`, method: 'DELETE', cookie });
      expect(reply.status, id).toBe(404);
      expect(problemOf(reply).code).toBe('not_found');
    }
    expect((await h.send({ url: '/api/v1/auth/me', cookie })).status).toBe(200);
  });

  it('does not ask the store about an id that cannot be a session id', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    let asked = 0;
    const real = h.store.revokeByPublicId.bind(h.store);
    h.store.revokeByPublicId = (publicId: string, now: number) => {
      asked += 1;
      return real(publicId, now);
    };
    for (const id of ['short', '0123456789abcdef0', 'ZZZZZZZZZZZZZZZZ']) {
      const reply = await h.send({ url: `/api/v1/auth/sessions/${id}`, method: 'DELETE', cookie });
      expect(reply.status, id).toBe(404);
    }
    expect(asked).toBe(0);
    await h.send({ url: '/api/v1/auth/sessions/0123456789abcdef', method: 'DELETE', cookie });
    expect(asked).toBe(1);
  });
});

describe('purge', () => {
  it('removes what is past its keeping time through the store, and reports it', async () => {
    const { AuthPurge } = await import('./purge');
    const h = await makeHarness();
    await h.login();
    let logged = 0;
    const purge = new AuthPurge({
      store: h.store,
      now: () => h.clock.now + 400 * DAY,
      log: () => (logged += 1),
    });
    const counts = await purge.runOnce();
    expect(counts).toMatchObject({ sessions: 1 });
    expect(logged).toBe(1);
  });

  it('logs a failure and carries on', async () => {
    const { AuthPurge } = await import('./purge');
    const h = await makeHarness();
    const lines: string[] = [];
    h.store.purge = () => Promise.reject(new Error('the database is gone'));
    const purge = new AuthPurge({
      store: h.store,
      log: (level, message) => lines.push(`${level}: ${message}`),
    });
    expect(await purge.runOnce()).toBeNull();
    expect(lines).toEqual(['error: the purge of the authentication tables failed']);
  });
});
