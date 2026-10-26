import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generate } from 'otplib';

import { createPool } from '@vmgs/db';
import {
  meResponseSchema,
  sessionsResponseSchema,
  totpEnableResponseSchema,
  totpSetupResponseSchema,
} from '@vmgs/contracts';

import { query, type TestDatabase } from '../../../packages/db/test/database';
import { migratedDatabase } from '../../../packages/db/test/setup';
import { buildApp } from './app';
import { clientKey } from './auth/client';
import { SESSION_COOKIE } from './auth/guard';
import { SecretHasher } from './auth/hasher';
import { deriveKeys, hmacHex, parseMasterKey } from './auth/keys';
import { Limiter } from './auth/limiter';
import { PostgresAuthStore } from './auth/postgresStore';
import { AuthPurge } from './auth/purge';
import { TOTP_CONTEXT, open } from './auth/secretbox';
import { AuthService } from './auth/service';
import { runCli } from './cli/commands';
import { MASTER_KEY, OWNER, SITE, TEST_ARGON } from './testing/harness';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

/**
 * The API on a real Postgres with the rights of the role `vmgs_api` and nothing else: what the memory tests show about
 * the rules, this shows about the database (the grants, the sequences, the types, the atomic steps, the restart).
 * Time is a clock of the test (every time the service writes is a parameter), so the second step needs no waiting.
 */
const MIN = 60_000;
const DAY = 86_400_000;
const NEXT_PASSWORD = 'a different long passphrase';
const clock = { now: Date.now() };

let database: TestDatabase;
const pools: ReturnType<typeof createPool>[] = [];

async function boot() {
  const pool = createPool(database.urlFor('vmgs_api', 'api-pass'), { max: 6 });
  pools.push(pool);
  const store = new PostgresAuthStore(pool);
  const service = new AuthService({
    store,
    hasher: new SecretHasher(TEST_ARGON, new Limiter(4, 64)),
    keys: deriveKeys(parseMasterKey(MASTER_KEY)),
    now: () => clock.now,
  });
  const app = await buildApp({ service, siteOrigin: SITE });
  await app.ready();
  return {
    app,
    store,
    send: (options: {
      method?: 'GET' | 'POST' | 'DELETE';
      url: string;
      body?: unknown;
      cookie?: string;
      ip?: string;
    }) =>
      app.inject({
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        url: options.url,
        remoteAddress: options.ip ?? '203.0.113.7',
        headers: {
          origin: SITE,
          'x-vmgs-csrf': '1',
          ...(options.cookie === undefined
            ? {}
            : { cookie: `${SESSION_COOKIE}=${options.cookie}` }),
        },
        ...(options.body === undefined ? {} : { payload: options.body as object }),
      }),
  };
}

function cookieOf(response: { cookies: { name: string; value: string }[] }): string {
  const set = response.cookies.find((cookie) => cookie.name === SESSION_COOKIE);
  if (set === undefined) throw new Error('no session cookie');
  return set.value;
}

/** The code of the app at the time of the clock; the clock moves on first, so that no step is used twice. */
function codeFor(secret: string): Promise<string> {
  clock.now += MIN;
  return generate({ secret, epoch: Math.floor(clock.now / 1000) });
}

async function sealedSecret(): Promise<string> {
  const rows = await query<{ totp_secret_enc: Buffer }>(
    database.url,
    'SELECT totp_secret_enc FROM auth_owner',
  );
  const blob = rows[0]?.totp_secret_enc;
  const secret =
    blob === undefined
      ? null
      : open(deriveKeys(parseMasterKey(MASTER_KEY)).totp, blob, TOTP_CONTEXT);
  if (secret === null) throw new Error('no secret to read');
  return secret;
}

beforeAll(async () => {
  database = await migratedDatabase();
  await query(database.url, "ALTER ROLE vmgs_api LOGIN PASSWORD 'api-pass'");
  const pool = createPool(database.urlFor('vmgs_api', 'api-pass'), { max: 2 });
  pools.push(pool);
  // the owner is made the way the real one is: with the command, on the server
  const lines: string[] = [];
  const code = await runCli(['owner:create', OWNER.username], {
    store: new PostgresAuthStore(pool),
    hasher: new SecretHasher(TEST_ARGON, new Limiter(1, 0)),
    now: () => clock.now,
    print: (line) => lines.push(line),
    readSecret: () => Promise.resolve(OWNER.password),
    interactive: false,
  });
  expect(code, lines.join('\n')).toBe(0);
});

afterAll(async () => {
  await Promise.all(pools.map((each) => each.end()));
  await database.drop();
});

describe('the whole of the authentication on Postgres', () => {
  it('logs in, shows the session, changes the password, turns the second step on, logs in with a recovery code and out', async () => {
    const api = await boot();
    const login = await api.send({ url: '/api/v1/auth/login', body: OWNER });
    expect(login.statusCode).toBe(204);
    const cookie = cookieOf(login);

    const me = meResponseSchema.parse((await api.send({ url: '/api/v1/auth/me', cookie })).json());
    expect(me.username).toBe(OWNER.username);

    const change = await api.send({
      url: '/api/v1/auth/password',
      body: { current: OWNER.password, next: NEXT_PASSWORD },
      cookie,
    });
    expect(change.statusCode).toBe(204);

    const setup = totpSetupResponseSchema.parse(
      (await api.send({ url: '/api/v1/auth/totp/setup', method: 'POST', cookie })).json(),
    );
    const enable = await api.send({
      url: '/api/v1/auth/totp/enable',
      body: { code: await codeFor(setup.secret) },
      cookie,
    });
    expect(enable.statusCode).toBe(200);
    const { recoveryCodes } = totpEnableResponseSchema.parse(enable.json());

    const next = { ...OWNER, password: NEXT_PASSWORD };
    expect(
      (await api.send({ url: '/api/v1/auth/login', body: next, ip: '198.51.100.1' })).statusCode,
    ).toBe(401);
    const withRecovery = await api.send({
      url: '/api/v1/auth/login',
      body: { ...next, totp: recoveryCodes[0] },
      ip: '198.51.100.2',
    });
    expect(withRecovery.statusCode).toBe(204);
    const reused = await api.send({
      url: '/api/v1/auth/login',
      body: { ...next, totp: recoveryCodes[0] },
      ip: '198.51.100.3',
    });
    expect(reused.statusCode).toBe(401);

    const { items } = sessionsResponseSchema.parse(
      (await api.send({ url: '/api/v1/auth/sessions', cookie })).json(),
    );
    expect(items[0]?.current).toBe(true);
    expect(items.length).toBeGreaterThanOrEqual(2);

    expect(
      (await api.send({ url: '/api/v1/auth/logout', method: 'POST', cookie })).statusCode,
    ).toBe(204);
    expect((await api.send({ url: '/api/v1/auth/me', cookie })).statusCode).toBe(401);
  });

  it('keeps nothing secret in the clear in any of the four tables', async () => {
    const dump = JSON.stringify(
      await Promise.all(
        ['auth_owner', 'auth_sessions', 'login_attempts', 'security_audit_events'].map((table) =>
          query(database.url, `SELECT * FROM ${table}`),
        ),
      ),
    );
    for (const secret of [OWNER.password, NEXT_PASSWORD, '203.0.113.7', '198.51.100.2']) {
      expect(dump, secret).not.toContain(secret);
    }
    const [owner] = await query<{
      password_hash: string;
      totp_enabled: boolean;
      recovery_code_hashes: string[];
    }>(database.url, 'SELECT password_hash, totp_enabled, recovery_code_hashes FROM auth_owner');
    expect(owner?.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(owner?.totp_enabled).toBe(true);
    expect(owner?.recovery_code_hashes).toHaveLength(7); // one was used
    const events = await query<{ event_type: string }>(
      database.url,
      'SELECT DISTINCT event_type FROM security_audit_events',
    );
    expect(events.map((event) => event.event_type).sort()).toEqual(
      [
        'LOGIN',
        'LOGOUT',
        'OWNER_CREATED',
        'PASSWORD_CHANGED',
        'RECOVERY_CODE_USED',
        'TOTP_ENABLED',
        'TOTP_SETUP',
      ].sort(),
    );
  });

  it('remembers the failures of a client across a restart of the API (the throttle is in the database)', async () => {
    const before = await boot();
    for (let i = 0; i < 5; i += 1) {
      const reply = await before.send({
        url: '/api/v1/auth/login',
        body: { ...OWNER, password: 'wrong wrong wrong' },
        ip: '198.51.100.50',
      });
      expect(reply.statusCode).toBe(401);
    }
    await before.app.close();

    const after = await boot(); // a new process: nothing in memory
    const stopped = await after.send({
      url: '/api/v1/auth/login',
      body: OWNER,
      ip: '198.51.100.50',
    });
    expect(stopped.statusCode).toBe(429);
    expect(stopped.headers['retry-after']).toBeDefined();
    // another client is judged (and refused: the owner has another password now)
    const other = await after.send({ url: '/api/v1/auth/login', body: OWNER, ip: '198.51.100.51' });
    expect(other.statusCode).toBe(401);
  });

  it('lets exactly five of thirty parallel tries from one client be judged (the admission is one step)', async () => {
    const api = await boot();
    const replies = await Promise.all(
      Array.from({ length: 30 }, () =>
        api.send({
          url: '/api/v1/auth/login',
          body: { ...OWNER, password: 'wrong wrong wrong' },
          ip: '198.51.100.60',
        }),
      ),
    );
    expect(replies.filter((reply) => reply.statusCode === 401)).toHaveLength(5);
    expect(replies.filter((reply) => reply.statusCode === 429)).toHaveLength(25);
    // and only the five that were judged are in the table: a refused try writes nothing
    const ipHash = hmacHex(deriveKeys(parseMasterKey(MASTER_KEY)).ip, clientKey('198.51.100.60'));
    const rows = await query<{ n: string }>(
      database.url,
      'SELECT count(*) AS n FROM login_attempts WHERE ip_hash = $1',
      [ipHash],
    );
    expect(Number(rows[0]?.n)).toBe(5);
  });

  it('lets one of two parallel logins with the same recovery code in, not both', async () => {
    const api = await boot();
    const login = { ...OWNER, password: NEXT_PASSWORD };
    const first = await api.send({
      url: '/api/v1/auth/login',
      body: { ...login, totp: await codeFor(await sealedSecret()) },
      ip: '198.51.100.70',
    });
    expect(first.statusCode).toBe(204);
    const cookie = cookieOf(first);

    // off and on again, for a fresh set of eight codes
    const off = await api.send({
      url: '/api/v1/auth/totp/disable',
      body: { code: await codeFor(await sealedSecret()) },
      cookie,
    });
    expect(off.statusCode).toBe(204);
    const setup = totpSetupResponseSchema.parse(
      (await api.send({ url: '/api/v1/auth/totp/setup', method: 'POST', cookie })).json(),
    );
    const on = await api.send({
      url: '/api/v1/auth/totp/enable',
      body: { code: await codeFor(setup.secret) },
      cookie,
    });
    const { recoveryCodes } = totpEnableResponseSchema.parse(on.json());

    const replies = await Promise.all(
      ['198.51.100.71', '198.51.100.72'].map((ip) =>
        api.send({ url: '/api/v1/auth/login', body: { ...login, totp: recoveryCodes[0] }, ip }),
      ),
    );
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([204, 401]);
  });

  it('ends a session that has expired, and purges it later with the rights of the API only', async () => {
    const api = await boot();
    const login = {
      ...OWNER,
      password: NEXT_PASSWORD,
      totp: await codeFor(await sealedSecret()),
    };
    const reply = await api.send({ url: '/api/v1/auth/login', body: login, ip: '198.51.100.80' });
    expect(reply.statusCode).toBe(204);
    const cookie = cookieOf(reply);

    clock.now += 8 * DAY; // idle for more than seven days
    expect((await api.send({ url: '/api/v1/auth/me', cookie })).statusCode).toBe(401);

    const counts = await new AuthPurge({
      store: api.store,
      now: () => clock.now + 2 * DAY,
    }).runOnce();
    expect(counts?.sessions).toBeGreaterThanOrEqual(1);
    const left = await query<{ n: string }>(
      database.url,
      'SELECT count(*) AS n FROM auth_sessions WHERE expires_at < $1',
      [new Date(clock.now)],
    );
    expect(Number(left[0]?.n)).toBe(0);
  });
});
