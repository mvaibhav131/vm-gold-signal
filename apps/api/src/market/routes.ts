import type { FastifyInstance } from 'fastify';

import {
  candlesQuerySchema,
  candlesResponseSchema,
  marketSnapshotSchema,
  type ChartCandle,
  type CandlesResponse,
} from '@vmgs/contracts';

import { API_BASE } from '../health/routes';
import { jsonRoute } from '../http/route';
import type { ChartLayers } from './layers';
import { computeOverlays, overlayWarmup } from './overlays';
import type { MarketReader } from './reader';
import { snapshotOf } from './snapshot';

export type { ChartLayers };

export interface MarketDeps {
  readonly reader: MarketReader;
  readonly layers: ChartLayers;
  readonly now: () => number;
}

export function registerMarketRoutes(app: FastifyInstance, deps: MarketDeps): void {
  jsonRoute(app, {
    method: 'GET',
    url: `${API_BASE}/market/snapshot`,
    response: marketSnapshotSchema,
    handler: async () => {
      const now = deps.now();
      return snapshotOf(await deps.reader.facts(now), now);
    },
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${API_BASE}/market/candles`,
    query: candlesQuerySchema,
    response: candlesResponseSchema,
    handler: async ({ query }): Promise<CandlesResponse> => {
      const now = deps.now();
      const before = query.before === undefined ? null : Date.parse(query.before);
      const warmup = overlayWarmup(query.overlays);
      const stored = await deps.reader.candles(query.tf, query.limit + warmup, before);
      const shown = stored.slice(Math.max(0, stored.length - query.limit));
      const hidden = stored.length - shown.length;

      const lines = computeOverlays(stored, query.overlays);
      const overlays: CandlesResponse['overlays'] = {};
      for (const [name, values] of Object.entries(lines) as [
        keyof typeof lines,
        (number | null)[],
      ][]) {
        overlays[name] = values.slice(hidden);
      }
      const [levels, objects] = await Promise.all([
        deps.layers.levels(now),
        query.objects.length === 0
          ? Promise.resolve([])
          : deps.layers.objects(query.objects, query.tf, now),
      ]);
      const candles: ChartCandle[] = shown.map((candle) => ({
        t: new Date(candle.openTime).toISOString(),
        o: candle.o,
        h: candle.h,
        l: candle.l,
        c: candle.c,
      }));
      return { candles, overlays, levels, objects };
    },
  });
}
