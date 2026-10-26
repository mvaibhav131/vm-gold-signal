import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { PROBLEM_CONTENT_TYPE, problemSchema } from '@vmgs/contracts';

import { SESSION_COOKIE } from './auth/guard';
import { SECURITY_HEADERS, parseSiteOrigin } from './http/security';
import { MemoryAuthStore } from './testing/memoryAuthStore';
import { OWNER, SITE, makeHarness, type Harness, type Reply } from './testing/harness';

/** The routes that anybody may call. A new one has to be added here on purpose, with a reason. */
const PUBLIC_ROUTES = ['POST /api/v1/auth/login'];

const SOME_ID = '0123456789abcdef';

function concrete(url: string): string {
  return url.replace(/:[A-Za-z]+/g, SOME_ID);
}

function bodyFor(method: string, url: string): unknown {
  if (method === 'GET' || method === 'HEAD') return undefined;
  if (url.includes('/totp/')) return { code: '123456' };
  if (url.endsWith('/password')) return { current: 'x', next: 'y'.repeat(12) };
  if (url.endsWith('/login')) return { ...OWNER };
  return undefined;
}

function expectSecurityHeaders(reply: Reply): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(reply.res.headers[name.toLowerCase()], name).toBe(value);
  }
  expect(reply.res.headers['x-powered-by']).toBeUndefined();
  expect(reply.res.headers['access-control-allow-origin']).toBeUndefined();
  expect(reply.res.headers['access-control-allow-credentials']).toBeUndefined();
}

describe('what exists', () => {
  it('has no way to register, sign up, recover or reset: not as a route and not by guessing an address', async () => {
    const h = await makeHarness();
    const bad = /regist|sign-?up|sign-?in|forgot|recover|reset|invite|create-?user|owner/i;
    for (const route of h.app.routeTable) {
      expect(route.url, `${route.method} ${route.url}`).not.toMatch(bad);
    }
    const cookie = await h.login();
    for (const path of [
      'register',
      'signup',
      'sign-up',
      'forgot-password',
      'reset-password',
      'recover',
      'owner',
      'users',
    ]) {
      for (const base of ['/api/v1/auth', '/api/v1', '']) {
        const url = `${base}/${path}`;
        const anonymous = await h.send({
          method: 'POST',
          url,
          body: { username: 'x', password: 'y'.repeat(12) },
        });
        expect(anonymous.status, `anonymous ${url}`).toBe(401);
        const owner = await h.send({ method: 'POST', url, body: {}, cookie });
        expect(owner.status, `owner ${url}`).toBe(404);
      }
    }
  });

  it('opens exactly one route to a visitor without a session: the login', async () => {
    const h = await makeHarness();
    const open = h.app.routeTable
      .filter((route) => route.public)
      .map((route) => `${route.method} ${route.url}`);
    expect(open.filter((route) => !route.startsWith('HEAD ')).sort()).toEqual(PUBLIC_ROUTES);
  });
});

describe('a visitor without a session', () => {
  it('gets 401 from every route that is not public, with every method and a made-up id', async () => {
    const h = await makeHarness();
    const closed = h.app.routeTable.filter((route) => !route.public);
    expect(closed.length).toBeGreaterThanOrEqual(9);
    for (const route of closed) {
      const reply = await h.send({
        method: route.method as 'GET',
        url: concrete(route.url),
        body: bodyFor(route.method, route.url),
      });
      expect(reply.status, `${route.method} ${route.url}`).toBe(401);
      // an answer to HEAD has no body
      if (route.method !== 'HEAD') {
        expect(problemSchema.parse(reply.json())).toMatchObject({ code: 'unauthenticated' });
      }
    }
  });

  it('gets 401 for an address that is no route, so that the answer does not tell which addresses exist', async () => {
    const h = await makeHarness();
    for (const url of [
      '/',
      '/api',
      '/api/v1',
      '/api/v1/nothing',
      '/api/v1/auth/',
      '/.env',
      '/admin',
    ]) {
      const reply = await h.send({ url });
      expect(reply.status, url).toBe(401);
    }
  });

  it('gets 401 for a cookie that is no good, and the browser is told to drop it', async () => {
    const h = await makeHarness();
    const reply = await h.send({ url: '/api/v1/auth/me', cookie: 'x'.repeat(43) });
    expect(reply.status).toBe(401);
    expect(String(reply.res.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=;`);
    const none = await h.send({ url: '/api/v1/auth/me' });
    expect(none.res.headers['set-cookie']).toBeUndefined();
  });

  it('gets 401 also for a session that was revoked, expired or whose owner is gone', async () => {
    const h = await makeHarness();
    const revoked = await h.login();
    await h.service.endToken(revoked);
    expect((await h.send({ url: '/api/v1/auth/me', cookie: revoked })).status).toBe(401);

    const expiring = await h.login();
    h.clock.advance(8 * 86_400_000);
    expect((await h.send({ url: '/api/v1/auth/me', cookie: expiring })).status).toBe(401);

    const nobody = await makeHarness({ noOwner: true });
    const token = await (async () => {
      // a session row that exists although the owner does not (it cannot be made through the API)
      const { newSessionToken, sessionIdHash } = await import('./auth/tokens');
      const raw = newSessionToken();
      nobody.store.putSession({
        idHash: sessionIdHash(raw),
        at: nobody.clock.now,
        expiresAt: nobody.clock.now + 1_000_000,
        ipHash: null,
        userAgentHash: null,
      });
      return raw;
    })();
    expect((await nobody.send({ url: '/api/v1/auth/me', cookie: token })).status).toBe(401);
  });

  it('is refused by HEAD and OPTIONS too', async () => {
    const h = await makeHarness();
    for (const method of ['HEAD', 'OPTIONS'] as const) {
      const reply = await h.send({ method, url: '/api/v1/auth/me' });
      expect(reply.status, method).toBe(401);
    }
  });
});

describe('the session cookie', () => {
  it('carries every flag at the login, at the refresh and at the logout', async () => {
    const h = await makeHarness();
    const login = await h.send({ url: '/api/v1/auth/login', body: OWNER });
    const cookie = login.cookie ?? '';
    h.clock.advance(20 * 60_000);
    const refresh = await h.send({ url: '/api/v1/auth/me', cookie });
    const logout = await h.send({ url: '/api/v1/auth/logout', method: 'POST', cookie });
    for (const reply of [login, refresh, logout]) {
      const raw = String(reply.res.headers['set-cookie']);
      expect(raw.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
      for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/'])
        expect(raw, flag).toContain(flag);
      expect(raw).not.toMatch(/Domain=/i);
    }
  });

  it('is named with the __Host- prefix, which a browser accepts only as Secure, Path=/ and without a Domain', () => {
    expect(SESSION_COOKIE).toBe('__Host-vmgs_session');
  });

  it('is sent by a browser as it is: a second cookie of another name changes nothing', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const reply = await h.app.inject({
      url: '/api/v1/auth/me',
      headers: { cookie: `other=1; ${SESSION_COOKIE}=${cookie}; more=2` },
    });
    expect(reply.statusCode).toBe(200);
  });
});

describe('every answer', () => {
  it('has the security headers, whatever the status, and no CORS headers', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const replies = [
      await h.send({ url: '/api/v1/auth/me', cookie }), // 200
      await h.send({
        url: '/api/v1/auth/logout',
        method: 'POST',
        cookie: await h.login({}, '198.51.100.9'),
      }), // 204
      await h.send({ url: '/api/v1/auth/me' }), // 401
      await h.send({ url: '/api/v1/auth/login', body: OWNER, sameSite: false }), // 403
      await h.send({ url: '/api/v1/nothing', cookie }), // 404
      await h.send({ url: '/api/v1/auth/login', body: { nope: 1 } }), // 400
    ];
    expect(replies.map((reply) => reply.status)).toEqual([200, 204, 401, 403, 404, 400]);
    const wrong = { ...OWNER, password: 'wrong wrong wrong' };
    for (let i = 0; i < 5; i += 1) await h.send({ url: '/api/v1/auth/login', body: wrong });
    replies.push(await h.send({ url: '/api/v1/auth/login', body: OWNER })); // 429
    expect(replies.at(-1)?.status).toBe(429);
    for (const reply of replies) expectSecurityHeaders(reply);
  });

  it('is problem+json for every error, in the shape of the contract', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    for (const reply of [
      await h.send({ url: '/api/v1/auth/me' }),
      await h.send({ url: '/api/v1/auth/login', body: OWNER, sameSite: false }),
      await h.send({ url: '/api/v1/nothing', cookie }),
      await h.send({ url: '/api/v1/auth/login', body: { nope: 1 } }),
    ]) {
      expect(String(reply.res.headers['content-type'])).toContain(PROBLEM_CONTENT_TYPE);
      const problem = problemSchema.parse(reply.json());
      expect(problem.status).toBe(reply.status);
    }
  });

  it('is not cacheable, so that nothing of it stays in a shared cache or on the disk of a browser', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    expect((await h.send({ url: '/api/v1/auth/me', cookie })).res.headers['cache-control']).toBe(
      'no-store',
    );
    expect((await h.send({ url: '/api/v1/auth/me' })).res.headers['cache-control']).toBe(
      'no-store',
    );
  });
});

describe('a request that does not come from the site (CSRF)', () => {
  const unsafeRoutes = (h: Harness) =>
    h.app.routeTable.filter((route) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method));

  it('is refused by every route that changes anything unless Origin is the site and the custom header is there', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const routes = unsafeRoutes(h);
    expect(routes.length).toBeGreaterThanOrEqual(7);
    const variants: [string, Record<string, string | undefined>][] = [
      ['no Origin', { origin: undefined }],
      ['another Origin', { origin: 'https://evil.example' }],
      ['a lookalike Origin', { origin: `${SITE}.evil.example` }],
      ['the right host over http', { origin: SITE.replace('https', 'http') }],
      ['a null Origin (a sandboxed frame)', { origin: 'null' }],
      ['the site with a path', { origin: `${SITE}/` }],
      ['no custom header', { 'x-vmgs-csrf': undefined }],
      ['the custom header with another value', { 'x-vmgs-csrf': '0' }],
      ['a cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
      ['a same-site (another subdomain) fetch', { 'sec-fetch-site': 'same-site' }],
    ];
    for (const route of routes) {
      for (const [name, headers] of variants) {
        const reply = await h.send({
          method: route.method as 'POST',
          url: concrete(route.url),
          body: bodyFor(route.method, route.url),
          cookie,
          headers,
        });
        expect(reply.status, `${route.method} ${route.url}: ${name}`).toBe(403);
        expect(problemSchema.parse(reply.json()).code).toBe('csrf_rejected');
      }
    }
    // nothing of it took effect: the session is alive and nothing was audited as done
    expect((await h.send({ url: '/api/v1/auth/me', cookie })).status).toBe(200);
    expect(h.store.auditLog.map((event) => event.type)).toEqual(['LOGIN']);
  });

  it('is refused before the session is looked at, and counts as no attempt', async () => {
    const h = await makeHarness();
    const reply = await h.send({ url: '/api/v1/auth/login', body: OWNER, sameSite: false });
    expect(reply.status).toBe(403);
    expect(h.store.attempts).toHaveLength(0);
  });

  it('is allowed when the browser says it is the same origin, or does not say (a script, curl)', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    expect(
      (
        await h.send({
          url: '/api/v1/auth/logout',
          method: 'POST',
          cookie,
          headers: { 'sec-fetch-site': 'same-origin' },
        })
      ).status,
    ).toBe(204);
    const second = await h.login();
    expect(
      (await h.send({ url: '/api/v1/auth/logout', method: 'POST', cookie: second })).status,
    ).toBe(204);
  });

  it('is not asked of a read: another Origin on a GET changes nothing (the cookie is SameSite=Strict, and no CORS)', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const reply = await h.send({
      url: '/api/v1/auth/me',
      cookie,
      headers: { origin: 'https://evil.example' },
    });
    expect(reply.status).toBe(200);
    expect(reply.res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('gets no CORS answer to a preflight, so a page of another site cannot read or send anything', async () => {
    const h = await makeHarness();
    const reply = await h.send({
      method: 'OPTIONS',
      url: '/api/v1/auth/login',
      sameSite: false,
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-vmgs-csrf,content-type',
      },
    });
    expect(reply.status).toBeGreaterThanOrEqual(400);
    for (const name of Object.keys(reply.res.headers)) expect(name).not.toMatch(/^access-control-/);
  });
});

describe('the site origin of the configuration', () => {
  it('is scheme, host and port as a browser writes an Origin, and nothing else', () => {
    expect(parseSiteOrigin('https://gold.example.org')).toBe('https://gold.example.org');
    expect(parseSiteOrigin('http://localhost:8080')).toBe('http://localhost:8080');
    for (const text of [
      'https://gold.example.org/',
      'https://gold.example.org/app',
      'https://gold.example.org:443',
      'HTTPS://gold.example.org',
      'https://gold.example.org?x=1',
    ]) {
      expect(() => parseSiteOrigin(text), text).toThrow(/scheme, host and port only/);
    }
    expect(() => parseSiteOrigin('data:text/plain,x')).toThrow();
  });
});

describe('a body that is not what the API reads', () => {
  it('is refused: wrong type 415, broken JSON 400, no body 400, too large 413', async () => {
    const h = await makeHarness();
    const base = { url: '/api/v1/auth/login', method: 'POST' as const };
    const text = await h.app.inject({
      method: 'POST',
      url: base.url,
      headers: { origin: SITE, 'x-vmgs-csrf': '1', 'content-type': 'text/plain' },
      payload: 'username=owner',
    });
    expect(text.statusCode).toBe(415);
    expect(problemSchema.parse(text.json()).code).toBe('unsupported_media_type');

    const broken = await h.app.inject({
      method: 'POST',
      url: base.url,
      headers: { origin: SITE, 'x-vmgs-csrf': '1', 'content-type': 'application/json' },
      payload: '{"username": ',
    });
    expect(broken.statusCode).toBe(400);
    expect(problemSchema.parse(broken.json()).code).toBe('invalid_request');

    expect((await h.send({ ...base })).status).toBe(400); // no body at all
    const empty = await h.app.inject({
      method: 'POST',
      url: base.url,
      headers: { origin: SITE, 'x-vmgs-csrf': '1', 'content-type': 'application/json' },
      payload: '',
    });
    expect(empty.statusCode).toBe(400);

    const large = await h.app.inject({
      method: 'POST',
      url: base.url,
      headers: { origin: SITE, 'x-vmgs-csrf': '1', 'content-type': 'application/json' },
      payload: JSON.stringify({ ...OWNER, password: 'x'.repeat(70_000) }),
    });
    expect(large.statusCode).toBe(413);
    expect(problemSchema.parse(large.json()).code).toBe('payload_too_large');
    expect(h.store.attempts).toHaveLength(0);
  });

  it('does not let a prototype be poisoned through the body', async () => {
    const h = await makeHarness();
    const reply = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: SITE, 'x-vmgs-csrf': '1', 'content-type': 'application/json' },
      payload: '{"username":"owner","password":"x","__proto__":{"admin":true}}',
    });
    expect(reply.statusCode).toBe(400);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('takes a logout with an empty JSON body (a client that always sends the header)', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    const reply = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        origin: SITE,
        'x-vmgs-csrf': '1',
        'content-type': 'application/json',
        cookie: `${SESSION_COOKIE}=${cookie}`,
      },
      payload: '',
    });
    expect(reply.statusCode).toBe(204);
  });
});

describe('who a client is', () => {
  const wrong = { ...OWNER, password: 'wrong wrong wrong' };

  it('is the address of the connection: a made-up X-Forwarded-For does not give a client a new count', async () => {
    const h = await makeHarness();
    for (let i = 0; i < 5; i += 1) {
      await h.send({
        url: '/api/v1/auth/login',
        body: wrong,
        headers: { 'x-forwarded-for': `10.0.0.${String(i + 1)}` },
      });
    }
    const reply = await h.send({
      url: '/api/v1/auth/login',
      body: OWNER,
      headers: { 'x-forwarded-for': '10.9.9.9' },
    });
    expect(reply.status).toBe(429);
  });

  it('is, behind one proxy, the address the proxy added: what the client wrote to the left of it is ignored', async () => {
    const h = await makeHarness({ trustedProxyHops: 1 });
    for (let i = 0; i < 5; i += 1) {
      await h.send({
        url: '/api/v1/auth/login',
        body: wrong,
        ip: '172.18.0.5', // the proxy
        headers: { 'x-forwarded-for': `10.0.0.${String(i + 1)}, 192.0.2.77` },
      });
    }
    const same = await h.send({
      url: '/api/v1/auth/login',
      body: OWNER,
      ip: '172.18.0.5',
      headers: { 'x-forwarded-for': '10.8.8.8, 192.0.2.77' },
    });
    expect(same.status).toBe(429);
    const other = await h.send({
      url: '/api/v1/auth/login',
      body: OWNER,
      ip: '172.18.0.5',
      headers: { 'x-forwarded-for': '192.0.2.78' },
    });
    expect(other.status).toBe(204);
  });

  it('is stored as a keyed hash: the audit and the sessions hold no address', async () => {
    const h = await makeHarness();
    await h.login({}, '203.0.113.201');
    const dump = JSON.stringify([
      ...h.store.auditLog,
      ...h.store.attempts,
      ...(await h.store.sessions(h.clock.now)),
    ]);
    expect(dump).not.toContain('203.0.113.201');
    expect(h.store.attempts[0]?.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('when something fails', () => {
  it('is an error, never an open door: a store that fails turns every private route into a 500', async () => {
    const store = new MemoryAuthStore();
    const h = await makeHarness({ store });
    const cookie = await h.login();
    store.session = () => Promise.reject(new Error('connection refused: password=hunter2'));
    const reply = await h.send({ url: '/api/v1/auth/me', cookie });
    expect(reply.status).toBe(500);
    expect(problemSchema.parse(reply.json())).toMatchObject({ code: 'server_error' });
    expect(reply.res.body).not.toContain('hunter2');
    expect(reply.res.body).not.toContain('connection refused');
    expectSecurityHeaders(reply);
  });

  it('turns a store that fails during a login into a 500 and no cookie', async () => {
    const store = new MemoryAuthStore();
    const h = await makeHarness({ store });
    store.createSession = () => Promise.reject(new Error('disk full'));
    const reply = await h.send({ url: '/api/v1/auth/login', body: OWNER });
    expect(reply.status).toBe(500);
    expect(reply.cookie).toBeNull();
    expect(reply.res.headers['set-cookie']).toBeUndefined();
  });

  it('does not answer with a result that breaks its contract: it is a 500, not a wrong answer', async () => {
    const h = await makeHarness();
    const cookie = await h.login();
    h.service.me = () =>
      Promise.resolve({ username: '', totpEnabled: 'yes', sessionExpiresAt: 'soon' } as never);
    const reply = await h.send({ url: '/api/v1/auth/me', cookie });
    expect(reply.status).toBe(500);
    expect(reply.res.body).not.toContain('soon');
  });
});

describe('the log', () => {
  it('never holds a password, a cookie, a token or a code', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString('utf8'));
        done();
      },
    });
    const h = await makeHarness({ logger: { level: 'trace', stream } });
    const cookie = await h.login();
    await h.send({
      url: '/api/v1/auth/login',
      body: { ...OWNER, password: 'wrong wrong wrong', totp: '123456' },
    });
    await h.send({ url: '/api/v1/auth/me', cookie });
    await h.send({
      url: '/api/v1/auth/password',
      body: { current: OWNER.password, next: 'another long phrase' },
      cookie,
    });
    h.service.me = () => Promise.reject(new Error('boom'));
    await h.send({ url: '/api/v1/auth/me', cookie });

    const log = lines.join('');
    expect(log.length).toBeGreaterThan(0);
    for (const secret of [
      OWNER.password,
      'wrong wrong wrong',
      'another long phrase',
      cookie,
      '123456',
      SESSION_COOKIE,
    ]) {
      expect(log, secret).not.toContain(secret);
    }
  });
});
