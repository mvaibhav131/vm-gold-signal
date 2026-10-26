import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  featureSnapshotResponseSchema,
  openSignalsResponseSchema,
  signalDetailSchema,
  signalHistoryPageSchema,
  signalHistoryQuerySchema,
  uuidSchema,
} from '@vmgs/contracts';

import { API_BASE } from '../health/routes';
import { ProblemError } from '../http/problem';
import { jsonRoute } from '../http/route';
import { decodeCursor, detailOf, openRiskOf, openSignalOf, pageOf, summaryOf } from './mappers';
import type { SignalsReader } from './reader';

export interface SignalsDeps {
  readonly reader: SignalsReader;
  readonly now: () => number;
}

const idParams = z.strictObject({ id: uuidSchema });

const noSuchSignal = (): ProblemError =>
  new ProblemError(404, 'not_found', 'There is no signal with this id.');

export function registerSignalsRoutes(app: FastifyInstance, deps: SignalsDeps): void {
  const { reader } = deps;

  jsonRoute(app, {
    method: 'GET',
    url: `${API_BASE}/signals/open`,
    response: openSignalsResponseSchema,
    handler: async () => {
      const now = deps.now();
      const { items, quote } = await reader.open(now);
      if (items.length === 0) return { items: [], openCount: 0, openRiskR: 0 };
      // a price is what an open signal is shown with: without any tick there is nothing true to say
      if (quote === null)
        throw new ProblemError(503, 'no_quote', 'No quote has been recorded yet.');
      return {
        items: items.map((record) => openSignalOf(record, quote, now)),
        openCount: items.length,
        openRiskR: openRiskOf(items),
      };
    },
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${API_BASE}/signals`,
    query: signalHistoryQuerySchema,
    response: signalHistoryPageSchema,
    handler: async ({ query }) => {
      const sort = query.sort ?? 'generatedAt';
      const order = query.order ?? 'desc';
      const after = query.cursor === undefined ? null : decodeCursor(query.cursor, sort, order);
      const filter = {
        from: query.from,
        to: query.to,
        result: query.result,
        strategy: query.strategy,
        side: query.side,
        session: query.session,
        regime: query.regime,
        cause: query.cause,
        grade: query.grade,
      };
      const [records, summary] = await Promise.all([
        reader.history({ filter, sort, order, limit: query.limit, after }),
        reader.summary(filter),
      ]);
      return pageOf(records, { limit: query.limit, sort, order }, summaryOf(summary));
    },
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${API_BASE}/signals/:id`,
    params: idParams,
    response: signalDetailSchema,
    handler: async ({ params }) => {
      const found = await reader.detail(params.id);
      if (found === null) throw noSuchSignal();
      return detailOf(found);
    },
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${API_BASE}/signals/:id/snapshot`,
    params: idParams,
    response: featureSnapshotResponseSchema,
    handler: async ({ params }) => {
      const found = await reader.snapshot(params.id);
      if (found === null) throw noSuchSignal();
      if (found.pruned) {
        throw new ProblemError(404, 'snapshot_pruned', 'The snapshot was removed by retention.');
      }
      return { signalId: params.id, features: found.features as Record<string, never> };
    },
  });
}
