import type { FastifyInstance } from 'fastify';
import pg from 'pg';

import { createPool, loadMigrations } from '@vmgs/db';

import { query, type TestDatabase } from '../../../../packages/db/test/database';
import { migratedDatabase } from '../../../../packages/db/test/setup';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth/guard';
import { SecretHasher } from '../auth/hasher';
import { deriveKeys, parseMasterKey } from '../auth/keys';
import { Limiter } from '../auth/limiter';
import { PostgresAuthStore } from '../auth/postgresStore';
import { AuthService } from '../auth/service';
import { registerApiRoutes } from '../routes';
import type { StreamHandle, StreamSetup } from '../stream';
import { MASTER_KEY, OWNER, SITE, T0, TEST_ARGON } from './harness';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

export interface PgReply {
  readonly status: number;
  readonly headers: Record<string, unknown>;
  readonly body: string;
  readonly json: () => unknown;
}

export interface PgApi {
  readonly database: TestDatabase;
  /** The clock of the service and of the routes. Tests put it where their data is. */
  readonly clock: { now: number };
  /** The session cookie of the logged-in owner (for a client of their own, like an event stream). */
  readonly cookie: string;
  /** The stream of the app: its hub and its listener of the database. */
  readonly stream: StreamHandle;
  /** The superuser's pool: tests write their data through it (the API role cannot write signals, and should not). */
  readonly admin: pg.Pool;
  /** The pool of the role `vmgs_api`, the one the routes use: for a test that builds a reader by hand. */
  readonly pool: pg.Pool;
  readonly app: FastifyInstance;
  /** An authenticated request as the owner (Origin and the CSRF header included for a change). */
  send(options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    body?: unknown;
  }): Promise<PgReply>;
  /** A request with no session at all. */
  anonymous(url: string): Promise<PgReply>;
  close(): Promise<void>;
}

/**
 * The whole API on a real Postgres with the rights of the role `vmgs_api` and nothing else, and an owner that is
 * logged in: what an area's tests need to show that its SQL, its grants and its answers fit together. The clock starts
 * at `T0` of the test harness.
 */
export async function startPgApi(
  options: { streamIntervals?: StreamSetup['intervals'] } = {},
): Promise<PgApi> {
  const database = await migratedDatabase();
  await query(database.url, "ALTER ROLE vmgs_api LOGIN PASSWORD 'api-pass'");
  const apiPool = createPool(database.urlFor('vmgs_api', 'api-pass'), { max: 6 });
  const admin = new pg.Pool({ connectionString: database.url, max: 4 });
  const clock = { now: T0 };

  const hasher = new SecretHasher(TEST_ARGON, new Limiter(4, 64));
  const store = new PostgresAuthStore(apiPool);
  await store.createOwner(OWNER.username, await hasher.hash(OWNER.password), clock.now);
  const service = new AuthService({
    store,
    hasher,
    keys: deriveKeys(parseMasterKey(MASTER_KEY)),
    now: () => clock.now,
  });
  const expectedMigration = (await loadMigrations()).length;
  let stream = null as StreamHandle | null;
  const app = await buildApp({
    service,
    siteOrigin: SITE,
    routes: (instance) => {
      registerApiRoutes(instance, {
        pool: apiPool,
        now: () => clock.now,
        expectedMigration,
        ...(options.streamIntervals === undefined
          ? {}
          : { streamIntervals: options.streamIntervals }),
        onStream: (made) => {
          stream = made;
        },
      });
    },
  });
  await app.ready();
  if (stream === null) throw new Error('the routes made no stream');

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: '203.0.113.7',
    headers: { origin: SITE, 'x-vmgs-csrf': '1' },
    payload: { ...OWNER },
  });
  const cookie = login.cookies.find((each) => each.name === SESSION_COOKIE)?.value;
  if (login.statusCode !== 204 || cookie === undefined) {
    throw new Error(`the login of the test owner failed: ${String(login.statusCode)}`);
  }

  const reply = (res: Awaited<ReturnType<typeof app.inject>>): PgReply => ({
    status: res.statusCode,
    headers: res.headers,
    body: res.body,
    json: () => res.json(),
  });

  return {
    database,
    clock,
    cookie,
    stream,
    admin,
    pool: apiPool,
    app,
    async send(options) {
      const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
      const res = await app.inject({
        method,
        url: options.url,
        remoteAddress: '203.0.113.7',
        headers: {
          origin: SITE,
          'x-vmgs-csrf': '1',
          cookie: `${SESSION_COOKIE}=${cookie}`,
        },
        ...(options.body === undefined ? {} : { payload: options.body as object }),
      });
      return reply(res);
    },
    async anonymous(url) {
      return reply(await app.inject({ method: 'GET', url, remoteAddress: '203.0.113.8' }));
    },
    async close() {
      await app.close();
      await Promise.all([apiPool.end(), admin.end()]);
      await database.drop();
    },
  };
}
