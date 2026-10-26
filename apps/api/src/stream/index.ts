import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { PostgresMarketReader } from '../market/reader';
import { NEWS_WINDOW, deriveNewsState, type NewsReader } from '../news/reader';
import { PostgresSignalsReader } from '../signals/reader';
import type { SystemReader } from '../system/reader';
import { EventHub } from './hub';
import { healthPortOf } from './health';
import { SignalListener } from './listener';
import { StreamPublisher, type NewsPort, type PublisherOptions } from './publisher';
import { registerStreamRoutes } from './routes';

export interface StreamSetup {
  readonly pool: Pool;
  readonly now: () => number;
  readonly news?: NewsReader;
  readonly system?: SystemReader;
  readonly log?: PublisherOptions['log'];
  /**
   * Whether the stream works on its own once the server is ready: the connection that listens to the worker, and the
   * timers that read the market, the signals, the news and the health. Off for tests that only walk the routes.
   */
  readonly background?: boolean;
  readonly intervals?: PublisherOptions['intervals'];
}

/** The newest HIGH-impact headline and the state of the news window, as the `news` event needs them. */
export function newsPortOf(reader: NewsReader): NewsPort {
  return {
    async read(now) {
      const [facts, headlines] = await Promise.all([
        reader.stateFacts(now, NEWS_WINDOW),
        reader.headlines({
          from: null,
          to: null,
          minImpact: 'HIGH',
          topic: null,
          limit: 1,
          after: null,
          now,
        }),
      ]);
      const state = deriveNewsState(facts, now, NEWS_WINDOW);
      const newest = headlines.items[0];
      return {
        state: state.state,
        next: state.next,
        newestHigh: newest === undefined ? null : { key: newest.id, headline: newest },
      };
    },
  };
}

export interface StreamHandle {
  readonly hub: EventHub;
  readonly publisher: StreamPublisher;
  /** Null when the background work is off. */
  readonly listener: SignalListener | null;
}

/**
 * `GET /stream` and what feeds it (04 section 3). The hub and the publisher live as long as the server: they start
 * when it is ready and stop when it closes.
 */
export function registerStream(app: FastifyInstance, setup: StreamSetup): StreamHandle {
  const hub = new EventHub(randomBytes(6).toString('hex'));
  const market = new PostgresMarketReader(setup.pool);
  const publisher = new StreamPublisher({
    hub,
    market,
    signals: new PostgresSignalsReader(setup.pool),
    ...(setup.news === undefined ? {} : { news: newsPortOf(setup.news) }),
    ...(setup.system === undefined ? {} : { health: healthPortOf(market, setup.system) }),
    now: setup.now,
    ...(setup.log === undefined ? {} : { log: setup.log }),
    ...(setup.intervals === undefined ? {} : { intervals: setup.intervals }),
  });
  registerStreamRoutes(app, { hub });

  if (setup.background !== false) {
    const listener = new SignalListener({
      pool: setup.pool,
      onNotification: (payload) => {
        void publisher.notified(payload);
      },
      // what was announced while the connection was down (or not yet up) is lost: the screens reload their state
      onConnected: () => {
        hub.resyncAll();
      },
      ...(setup.log === undefined ? {} : { log: setup.log }),
    });
    app.addHook('onReady', () => {
      // not awaited: a database that does not answer must not keep the server from starting (the listener retries by itself)
      void listener.start();
      publisher.start();
    });
    app.addHook('onClose', () => {
      publisher.stop();
      listener.stop();
    });
    return { hub, publisher, listener };
  }
  return { hub, publisher, listener: null };
}
