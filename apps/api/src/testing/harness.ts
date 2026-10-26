import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { generate } from 'otplib';

import { buildApp } from '../app';
import { SecretHasher } from '../auth/hasher';
import { type AuthKeys, deriveKeys, parseMasterKey } from '../auth/keys';
import { Limiter } from '../auth/limiter';
import { SESSION_COOKIE } from '../auth/guard';
import { AuthService } from '../auth/service';
import type { SessionPolicy } from '../auth/policy';
import type { ThrottlePolicy } from '../auth/throttle';
import { MemoryAuthStore } from './memoryAuthStore';

export const SITE = 'https://vmgs.example.org';
export const OWNER = { username: 'owner', password: 'correct horse battery staple' };
export const T0 = Date.UTC(2026, 9, 26, 6, 0, 0);
export const MASTER_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
export const IP = '203.0.113.7';

/** Cheap Argon2 for the tests: they check what the code does, not what the hash costs. */
export const TEST_ARGON = { memoryCost: 1024, timeCost: 1, parallelism: 1 };

export interface Clock {
  now: number;
  advance(ms: number): void;
}

export interface HarnessOptions {
  readonly hasher?: SecretHasher;
  readonly store?: MemoryAuthStore;
  readonly trustedProxyHops?: number;
  readonly session?: SessionPolicy;
  readonly throttle?: ThrottlePolicy;
  readonly logger?: Parameters<typeof buildApp>[0]['logger'];
  readonly noOwner?: boolean;
  /** The routes of B30 that a test brings (usually with fakes); they come after the guard like the real ones. */
  readonly routes?: (app: FastifyInstance, clock: Clock) => void;
}

export interface Reply {
  readonly res: LightMyRequestResponse;
  readonly status: number;
  readonly json: () => unknown;
  /** The session cookie of a login, as the value to send back. */
  readonly cookie: string | null;
}

export interface Send {
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT' | 'HEAD' | 'OPTIONS';
  url: string;
  body?: unknown;
  cookie?: string | null;
  headers?: Record<string, string | undefined>;
  /** `false` leaves the Origin and the CSRF header out, as a request from another site would. */
  sameSite?: boolean;
  ip?: string;
}

export interface Harness {
  readonly app: FastifyInstance;
  readonly store: MemoryAuthStore;
  readonly service: AuthService;
  readonly keys: AuthKeys;
  readonly clock: Clock;
  readonly hasher: SecretHasher;
  send(options: Send): Promise<Reply>;
  /** A login that is expected to work; returns the cookie. */
  login(
    overrides?: Partial<{ username: string; password: string; totp: string }>,
    ip?: string,
  ): Promise<string>;
  /** The code the authenticator app shows at the time of the clock. */
  code(secret: string, offsetS?: number): Promise<string>;
}

export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock: Clock = {
    now: T0,
    advance(ms) {
      this.now += ms;
    },
  };
  const store = options.store ?? new MemoryAuthStore();
  const hasher = options.hasher ?? new SecretHasher(TEST_ARGON, new Limiter(4, 32));
  const keys = deriveKeys(parseMasterKey(MASTER_KEY));
  const service = new AuthService({
    store,
    hasher,
    keys,
    now: () => clock.now,
    ...(options.session === undefined ? {} : { session: options.session }),
    ...(options.throttle === undefined ? {} : { throttle: options.throttle }),
  });
  if (options.noOwner !== true) {
    await store.createOwner(OWNER.username, await hasher.hash(OWNER.password), clock.now);
  }
  const routes = options.routes;
  const app = await buildApp({
    service,
    siteOrigin: SITE,
    ...(routes === undefined
      ? {}
      : {
          routes: (instance: FastifyInstance) => {
            routes(instance, clock);
          },
        }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.trustedProxyHops === undefined
      ? {}
      : { trustedProxyHops: options.trustedProxyHops }),
  });
  await app.ready();

  async function send(request: Send): Promise<Reply> {
    const method = request.method ?? (request.body === undefined ? 'GET' : 'POST');
    const wanted = new Map<string, string | undefined>();
    if (request.sameSite !== false) {
      wanted.set('origin', SITE);
      wanted.set('x-vmgs-csrf', '1');
    }
    if (request.cookie !== undefined && request.cookie !== null) {
      wanted.set('cookie', `${SESSION_COOKIE}=${request.cookie}`);
    }
    // a header given as `undefined` is taken away
    for (const [name, value] of Object.entries(request.headers ?? {})) wanted.set(name, value);
    const headers: Record<string, string> = {};
    for (const [name, value] of wanted) {
      if (value !== undefined) headers[name] = value;
    }
    const inject: InjectOptions = {
      method,
      url: request.url,
      headers,
      remoteAddress: request.ip ?? IP,
      ...(request.body === undefined ? {} : { payload: request.body as object }),
    };
    const res = await app.inject(inject);
    const set = res.cookies.find((cookie) => cookie.name === SESSION_COOKIE);
    return {
      res,
      status: res.statusCode,
      json: () => res.json(),
      cookie: set === undefined || set.value === '' ? null : set.value,
    };
  }

  return {
    app,
    store,
    service,
    keys,
    clock,
    hasher,
    send,
    async login(overrides = {}, ip) {
      const reply = await send({
        url: '/api/v1/auth/login',
        body: { ...OWNER, ...overrides },
        ...(ip === undefined ? {} : { ip }),
      });
      if (reply.status !== 204 || reply.cookie === null) {
        throw new Error(`the login failed: ${String(reply.status)} ${reply.res.body}`);
      }
      return reply.cookie;
    },
    code: (secret, offsetS = 0) =>
      generate({ secret, epoch: Math.floor(clock.now / 1000) + offsetS }),
  };
}
