import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { PostgresAnalyticsReader } from '../analytics/reader';
import { registerAnalyticsRoutes } from '../analytics/routes';
import { PostgresEngineControlStore } from '../engine/store';
import { registerEngineRoutes } from '../engine/routes';
import { PostgresReadinessReader } from '../health/readiness';
import { registerHealthRoutes } from '../health/routes';
import { postgresNotificationDeps, registerNotificationRoutes } from '../notifications/routes';
import { registerSettingsRoutes } from '../settings/routes';
import { PostgresSettingsStore } from '../settings/store';
import { PostgresSystemReader } from '../system/reader';
import { registerSystemRoutes } from '../system/routes';
import { PostgresNewsReader } from '../news/reader';
import { registerNewsRoutes } from '../news/routes';
import { PostgresStrategiesReader } from '../strategies/reader';
import { registerStrategiesRoutes } from '../strategies/routes';
import { PostgresSignalsReader } from '../signals/reader';
import { registerSignalsRoutes } from '../signals/routes';
import { PostgresChartLayers } from '../market/layers';
import { PostgresMarketReader } from '../market/reader';
import { registerMarketRoutes } from '../market/routes';
import { registerStream, type StreamHandle, type StreamSetup } from '../stream';

/** What the routes of B30 stand on: the database, the clock and the version of the schema this build expects. */
export interface ApiDeps {
  readonly pool: Pool;
  readonly now: () => number;
  /** The number of the newest migration file of this build (`GET /health/ready`). */
  readonly expectedMigration: number;
  readonly log?: StreamSetup['log'];
  /** `false` leaves the stream's own work (the listener of the database, the timers) off: for tests that only walk the routes. */
  readonly background?: boolean;
  readonly streamIntervals?: StreamSetup['intervals'];
  /** Told once, when the stream is made (tests wait for its listener, and read its hub). */
  readonly onStream?: (stream: StreamHandle) => void;
}

/**
 * Every route of 04 section 2 that is not authentication. They are registered after the guard, so every one of them
 * needs a session unless it says `public: true`; the only ones that do are the two health routes.
 */
export function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): void {
  registerHealthRoutes(app, {
    reader: new PostgresReadinessReader(deps.pool),
    expectedMigration: deps.expectedMigration,
    now: deps.now,
  });
  registerAnalyticsRoutes(app, { reader: new PostgresAnalyticsReader(deps.pool), now: deps.now });
  registerStrategiesRoutes(app, {
    reader: new PostgresStrategiesReader(deps.pool),
    now: deps.now,
  });
  const news = new PostgresNewsReader(deps.pool);
  const system = new PostgresSystemReader(deps.pool);
  const stream = registerStream(app, {
    pool: deps.pool,
    now: deps.now,
    news,
    system,
    ...(deps.log === undefined ? {} : { log: deps.log }),
    ...(deps.background === undefined ? {} : { background: deps.background }),
    ...(deps.streamIntervals === undefined ? {} : { intervals: deps.streamIntervals }),
  });
  deps.onStream?.(stream);
  registerEngineRoutes(app, {
    store: new PostgresEngineControlStore(deps.pool),
    now: deps.now,
    // the screens are told at once, not at the next look
    onChanged: () => {
      void stream.publisher.refresh();
    },
  });
  registerSignalsRoutes(app, { reader: new PostgresSignalsReader(deps.pool), now: deps.now });
  registerMarketRoutes(app, {
    reader: new PostgresMarketReader(deps.pool),
    layers: new PostgresChartLayers(deps.pool),
    now: deps.now,
  });
  registerNewsRoutes(app, { reader: news, now: deps.now });
  registerSystemRoutes(app, { reader: system, now: deps.now });
  registerSettingsRoutes(app, { store: new PostgresSettingsStore(deps.pool), now: deps.now });
  registerNotificationRoutes(app, postgresNotificationDeps(deps.pool, deps.now));
}
