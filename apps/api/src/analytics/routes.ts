import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  breakdownQuerySchema,
  breakdownResponseSchema,
  calibrationQuerySchema,
  calibrationResponseSchema,
  driftResponseSchema,
  equityQuerySchema,
  equityResponseSchema,
  failuresQuerySchema,
  failuresResponseSchema,
  groupEffectivenessQuerySchema,
  groupEffectivenessResponseSchema,
  monthlyQuerySchema,
  monthlyResponseSchema,
  newsImpactResponseSchema,
  overviewQuerySchema,
  overviewResponseSchema,
} from '@vmgs/contracts';
import type { StatsScope, StrategyKey } from '@vmgs/core';

import { jsonRoute } from '../http/route';
import { ANALYTICS_CACHE_ENTRIES, ANALYTICS_CACHE_MS, AnswerCache } from './cache';
import {
  breakdownOf,
  calibrationOf,
  driftOf,
  equityOf,
  failuresOf,
  groupsOf,
  monthlyOf,
  newsImpactOf,
  overviewOf,
  resolveTimeZone,
} from './compute';
import type { AnalyticsReader, TradeQuery } from './reader';

const BASE = '/api/v1/analytics';

export interface AnalyticsDeps {
  readonly reader: AnalyticsReader;
  readonly now: () => number;
  /** How long an answer is kept; 30 seconds (04 section 2). */
  readonly cacheMs?: number;
  /** The most answers kept at once. */
  readonly cacheEntries?: number;
}

interface Filters {
  readonly scope: StatsScope;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly strategy?: StrategyKey | undefined;
}

/** The signals a request is about. Its JSON is also the key of the answer: the same instant is the same key. */
function tradeQueryOf(filters: Filters): TradeQuery {
  return {
    scope: filters.scope,
    ...(filters.from === undefined ? {} : { from: Date.parse(filters.from) }),
    ...(filters.to === undefined ? {} : { to: Date.parse(filters.to) }),
    ...(filters.strategy === undefined ? {} : { strategy: filters.strategy }),
  };
}

/** The two sections that have no scope on purpose take no parameter at all (04 section 2). */
const noQuery = z.strictObject({});

/**
 * The analytics routes (04 section 2). The figures are computed by `packages/core/src/stats` from the signals of the
 * scope with their outcomes and reviews (the rollup tables hold all-time counts by UTC month and by bucket, which no
 * range, display-zone month or breakdown can be cut from), and the news impact is read from `news_topic_stats`. An
 * answer is kept for 30 seconds by its endpoint and its query.
 */
export function registerAnalyticsRoutes(app: FastifyInstance, deps: AnalyticsDeps): void {
  const { reader } = deps;
  const cache = new AnswerCache({
    ttlMs: deps.cacheMs ?? ANALYTICS_CACHE_MS,
    maxEntries: deps.cacheEntries ?? ANALYTICS_CACHE_ENTRIES,
    now: deps.now,
  });
  const answer = <T>(endpoint: string, key: unknown, compute: () => Promise<T>): Promise<T> =>
    cache.get(`${endpoint}|${JSON.stringify(key)}`, compute);

  jsonRoute(app, {
    method: 'GET',
    url: `${BASE}/overview`,
    query: overviewQuerySchema,
    response: overviewResponseSchema,
    handler: ({ query }) => {
      const read = tradeQueryOf(query);
      return answer('overview', read, async () => overviewOf(await reader.trades(read)));
    },
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${BASE}/monthly`,
    query: monthlyQuerySchema,
    response: monthlyResponseSchema,
    handler: ({ query }) => {
      const read = tradeQueryOf(query);
      return answer('monthly', { ...read, months: query.months }, async () => {
        const [rows, stored] = await Promise.all([reader.trades(read), reader.displayTz()]);
        return monthlyOf(rows, query.months, resolveTimeZone(stored));
      });
    },
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${BASE}/breakdown`,
    query: breakdownQuerySchema,
    response: breakdownResponseSchema,
    handler: ({ query }) => {
      const read = tradeQueryOf(query);
      return answer('breakdown', { ...read, by: query.by }, async () =>
        breakdownOf(await reader.trades(read), query.by),
      );
    },
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${BASE}/failures`,
    query: failuresQuerySchema,
    response: failuresResponseSchema,
    handler: ({ query }) => {
      const read = tradeQueryOf(query);
      return answer('failures', read, async () => failuresOf(await reader.trades(read)));
    },
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${BASE}/groups`,
    query: groupEffectivenessQuerySchema,
    response: groupEffectivenessResponseSchema,
    handler: ({ query }) => {
      const read = tradeQueryOf(query);
      return answer('groups', read, async () => groupsOf(await reader.trades(read)));
    },
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${BASE}/score-calibration`,
    query: calibrationQuerySchema,
    response: calibrationResponseSchema,
    handler: ({ query }) => {
      const read = tradeQueryOf(query);
      return answer('score-calibration', read, async () =>
        calibrationOf(await reader.trades(read)),
      );
    },
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${BASE}/equity`,
    query: equityQuerySchema,
    response: equityResponseSchema,
    handler: ({ query }) => {
      const read = tradeQueryOf(query);
      return answer('equity', read, async () => equityOf(await reader.trades(read)));
    },
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${BASE}/drift`,
    query: noQuery,
    response: driftResponseSchema,
    handler: () =>
      answer('drift', null, async () => {
        const [forward, backtest] = await Promise.all([
          reader.trades({ scope: 'FORWARD' }),
          reader.trades({ scope: 'BACKTEST_OOS' }),
        ]);
        return driftOf(forward, backtest);
      }),
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${BASE}/news-impact`,
    query: noQuery,
    response: newsImpactResponseSchema,
    handler: () => answer('news-impact', null, async () => newsImpactOf(await reader.topicStats())),
  });
}
