import type { FastifyInstance } from 'fastify';

import { healthLiveSchema, healthReadySchema } from '@vmgs/contracts';

import { jsonRoute } from '../http/route';
import { isReady, type ReadinessReader } from './readiness';

export const API_BASE = '/api/v1';

export interface HealthDeps {
  readonly reader: ReadinessReader;
  /** The number of the newest migration file of this build. */
  readonly expectedMigration: number;
  readonly now: () => number;
  /** How long an answer is kept: a probe that comes often must not be a load on the database. */
  readonly cacheMs?: number;
}

/**
 * The two health routes, the only ones besides the login that a visitor without a session may call (04 section 2).
 * They tell nothing but `ok` and `not_ready`. The ready answer is worked out at most once in `cacheMs`, and a request
 * that comes while it is being worked out shares that one answer.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  const cacheMs = deps.cacheMs ?? 2000;
  let cached: { at: number; ready: boolean } | null = null;
  let running: Promise<boolean> | null = null;

  async function work(): Promise<boolean> {
    try {
      return isReady(await deps.reader.facts(), deps.expectedMigration, deps.now());
    } catch {
      return false;
    }
  }

  function ready(): Promise<boolean> {
    const now = deps.now();
    if (cached !== null && now >= cached.at && now - cached.at < cacheMs) {
      return Promise.resolve(cached.ready);
    }
    running ??= work().then((value) => {
      cached = { at: deps.now(), ready: value };
      running = null;
      return value;
    });
    return running;
  }

  jsonRoute(app, {
    method: 'GET',
    url: `${API_BASE}/health/live`,
    public: true,
    quiet: true,
    response: healthLiveSchema,
    handler: () => Promise.resolve({ status: 'ok' as const }),
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${API_BASE}/health/ready`,
    public: true,
    quiet: true,
    response: healthReadySchema,
    handler: async ({ reply }) => {
      const ok = await ready();
      // 503 for a probe that only looks at the status; the body says the same
      if (!ok) void reply.code(503);
      return { status: ok ? ('ok' as const) : ('not_ready' as const) };
    },
  });
}
