import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  headlinesQuerySchema,
  headlinesResponseSchema,
  marketMovesQuerySchema,
  marketMovesResponseSchema,
  newsEventsQuerySchema,
  newsEventsResponseSchema,
  newsStateResponseSchema,
} from '@vmgs/contracts';
import type { NewsWindowSpec } from '@vmgs/core';

import { jsonRoute } from '../http/route';
import {
  NEWS_WINDOW,
  decodeCursor,
  deriveNewsState,
  encodeCursor,
  eventsRange,
  movesFrom,
  sourceAgeS,
  type NewsReader,
} from './reader';

const NEWS_BASE = '/api/v1/news';

export interface NewsDeps {
  readonly reader: NewsReader;
  readonly now: () => number;
  readonly window?: NewsWindowSpec;
}

/** `GET /news/state` takes no query: a name it does not know is a mistake of the caller, like a wrong value. */
const noQuery = z.strictObject({});

/**
 * The four news routes of 04 section 2: the state, the calendar, the clustered headlines with the health of the
 * feeds, and the detected market moves. Read only; what is not known is `null`, and a list that is empty is empty
 * (the feeds' own health, `sources` and `sourceAgeS`, says whether that can be trusted).
 */
export function registerNewsRoutes(app: FastifyInstance, deps: NewsDeps): void {
  const window = deps.window ?? NEWS_WINDOW;

  jsonRoute(app, {
    method: 'GET',
    url: `${NEWS_BASE}/state`,
    query: noQuery,
    response: newsStateResponseSchema,
    handler: async () => {
      const now = deps.now();
      return deriveNewsState(await deps.reader.stateFacts(now, window), now, window);
    },
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${NEWS_BASE}/events`,
    query: newsEventsQuerySchema,
    response: newsEventsResponseSchema,
    handler: async ({ query }) => {
      const now = deps.now();
      const facts = await deps.reader.events({
        ...eventsRange(query, now),
        importance: query.importance ?? null,
        now,
      });
      return { items: facts.items, sourceAgeS: sourceAgeS(facts.calendarOkAt, now) };
    },
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${NEWS_BASE}/headlines`,
    query: headlinesQuerySchema,
    response: headlinesResponseSchema,
    handler: async ({ query }) => {
      const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
      const facts = await deps.reader.headlines({
        from: query.from === undefined ? null : Date.parse(query.from),
        to: query.to === undefined ? null : Date.parse(query.to),
        minImpact: query.minImpact ?? null,
        topic: query.topic ?? null,
        limit: query.limit,
        after,
        now: deps.now(),
      });
      return {
        items: facts.items,
        nextCursor: facts.next === null ? null : encodeCursor(facts.next),
        sources: facts.sources,
      };
    },
  });

  jsonRoute(app, {
    method: 'GET',
    url: `${NEWS_BASE}/moves`,
    query: marketMovesQuerySchema,
    response: marketMovesResponseSchema,
    handler: async ({ query }) => ({
      items: await deps.reader.moves({
        from: query.from === undefined ? movesFrom(deps.now()) : Date.parse(query.from),
        to: query.to === undefined ? null : Date.parse(query.to),
      }),
    }),
  });
}
