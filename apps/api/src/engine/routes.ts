import type { FastifyInstance } from 'fastify';

import { pauseRequestSchema } from '@vmgs/contracts';

import { API_BASE } from '../health/routes';
import { ProblemError } from '../http/problem';
import { emptyRoute } from '../http/route';
import type { EngineControlStore } from './store';

export interface EngineDeps {
  readonly store: EngineControlStore;
  readonly now: () => number;
  /** Called after a pause or a resume was stored: the stream tells the screens at once. */
  readonly onChanged?: () => void;
}

/**
 * The owner's pause (04 section 2): it stops new signals and nothing else (recording, tracking and the review go on).
 * A pause when it is paused, and a resume when it runs, are 409: the owner's other screen did it first.
 */
export function registerEngineRoutes(app: FastifyInstance, deps: EngineDeps): void {
  emptyRoute(app, {
    method: 'POST',
    url: `${API_BASE}/engine/pause`,
    // a pause with no end has no body at all, or an empty one
    body: pauseRequestSchema.default({}),
    handler: async ({ body }) => {
      const result = await deps.store.pause(body.minutes ?? null, deps.now());
      if (result.outcome === 'ALREADY_PAUSED') {
        throw new ProblemError(409, 'already_paused', 'The engine is paused already.');
      }
      deps.onChanged?.();
    },
  });

  emptyRoute(app, {
    method: 'POST',
    url: `${API_BASE}/engine/resume`,
    handler: async () => {
      if ((await deps.store.resume(deps.now())) === 'NOT_PAUSED') {
        throw new ProblemError(409, 'not_paused', 'The engine is not paused.');
      }
      deps.onChanged?.();
    },
  });
}
