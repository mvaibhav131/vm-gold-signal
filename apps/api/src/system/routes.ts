import type { FastifyInstance } from 'fastify';

import {
  systemHealthSchema,
  systemIncidentsResponseSchema,
  systemLatencySchema,
  systemStorageSchema,
} from '@vmgs/contracts';

import { jsonRoute } from '../http/route';
import { healthOf, incidentOf, latencyOf, storageOf } from './logic';
import type { SystemReader } from './reader';

const API_BASE = '/api/v1';

export interface SystemDeps {
  readonly reader: SystemReader;
  readonly now: () => number;
}

/**
 * The System page (04 section 2): health, the last 30 feed incidents, storage and latency. All four need a session. A
 * figure that nothing records is null (or has no samples) in the answer, never a guess.
 */
export function registerSystemRoutes(app: FastifyInstance, deps: SystemDeps): void {
  jsonRoute(app, {
    method: 'GET',
    url: `${API_BASE}/system/health`,
    response: systemHealthSchema,
    handler: async () => {
      const now = deps.now();
      return healthOf(await deps.reader.health(now), now);
    },
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${API_BASE}/system/incidents`,
    response: systemIncidentsResponseSchema,
    handler: async () => ({ items: (await deps.reader.incidents()).map(incidentOf) }),
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${API_BASE}/system/storage`,
    response: systemStorageSchema,
    handler: async () => storageOf(await deps.reader.storage()),
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${API_BASE}/system/latency`,
    response: systemLatencySchema,
    handler: async () => latencyOf(await deps.reader.latency(deps.now())),
  });
}
