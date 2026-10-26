import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { defaultSettings } from '@vmgs/config';
import {
  strategiesResponseSchema,
  strategyConfigResponseSchema,
  strategyInfoSchema,
  strategyKeySchema,
  strategyPatchSchema,
  type StrategyInfo,
} from '@vmgs/contracts';

import { API_BASE } from '../health/routes';
import { ProblemError } from '../http/problem';
import { jsonRoute } from '../http/route';
import type { StrategiesReader, StrategyListing, StrategyRow } from './reader';

export interface StrategiesDeps {
  readonly reader: StrategiesReader;
  readonly now: () => number;
}

const paramsSchema = z.strictObject({ key: strategyKeySchema });

/** A strategy as the list shows it: the version, the owner's two switches (a missing one is the default), its newest signal. */
export function strategyInfoOf(row: StrategyRow, listing: StrategyListing): StrategyInfo {
  const alert = listing.switches.alerts[row.key] ?? defaultSettings().strategyAlerts[row.key];
  return strategyInfoSchema.parse({
    key: row.key,
    version: row.version,
    status: row.status,
    enabled: listing.switches.enabled[row.key] !== false,
    alerts: alert === 'on',
    lastSignalAt: row.lastSignalAt === null ? null : new Date(row.lastSignalAt).toISOString(),
    evidence: row.evidence,
  });
}

function noSuchStrategy(): ProblemError {
  return new ProblemError(404, 'not_found', 'There is no such strategy.');
}

export function registerStrategiesRoutes(app: FastifyInstance, deps: StrategiesDeps): void {
  const { reader } = deps;

  jsonRoute(app, {
    method: 'GET',
    url: `${API_BASE}/strategies`,
    response: strategiesResponseSchema,
    handler: async () => {
      const listing = await reader.list();
      return { items: listing.rows.map((row) => strategyInfoOf(row, listing)) };
    },
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${API_BASE}/strategies/:key/config`,
    params: paramsSchema,
    response: strategyConfigResponseSchema,
    handler: async ({ params }) => {
      const found = await reader.config(params.key);
      if (found === null) throw noSuchStrategy();
      return { key: params.key, version: found.version, config: found.config } as z.infer<
        typeof strategyConfigResponseSchema
      >;
    },
  });

  jsonRoute(app, {
    method: 'PATCH',
    url: `${API_BASE}/strategies/:key`,
    params: paramsSchema,
    body: strategyPatchSchema,
    response: strategyInfoSchema,
    handler: async ({ params, body }) => {
      const before = await reader.list();
      if (!before.rows.some((row) => row.key === params.key)) throw noSuchStrategy();
      await reader.change(params.key, body, deps.now());
      const after = await reader.list();
      const row = after.rows.find((each) => each.key === params.key);
      if (row === undefined) throw noSuchStrategy();
      return strategyInfoOf(row, after);
    },
  });
}
