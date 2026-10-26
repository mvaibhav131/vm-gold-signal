import { defaultStrategyConfig } from '@vmgs/config';
import { STRATEGY_KEYS } from '@vmgs/core';
import { afterAll, describe, it } from 'vitest';

import { seedLive, startWorkerSimulator, tickPartitions } from './testing/liveSeed';
import { startLiveControl } from './testing/liveControl';
import { startPgApi, type PgApi } from './testing/pgApi';
import { startSeedWorld, type SeedWorld } from './testing/seedWorld';

/**
 * Not a test: the stack that a browser looks at (`pnpm e2e:live`, `e2e/playwright.live.config.ts`). It runs the whole API
 * on a real Postgres with a world of data (a few months of signals, a calendar, headlines, incidents) and a worker that
 * is simulated by a tick a second, and it stays up until the process is stopped. It does nothing unless
 * `VMGS_LIVE_STACK=1`, so no run of the test suites ever holds on to it.
 */
const enabled = process.env.VMGS_LIVE_STACK === '1';

/** The example key of the web-push documentation: a public value, good for a stack that never sends a real push. */
const VAPID_PUBLIC =
  'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';

let api: PgApi | null = null;
let world: SeedWorld | null = null;

afterAll(async () => {
  await world?.finish();
  await api?.close();
});

describe.skipIf(!enabled)('the live stack for the browser', () => {
  it(
    'serves the API with a world of data until it is stopped',
    async () => {
      const site = process.env.VMGS_LIVE_SITE ?? 'http://127.0.0.1:4174';
      const port = Number(process.env.VMGS_LIVE_PORT ?? 3000);
      api = await startPgApi({ siteOrigin: site, vapidPublicKey: VAPID_PUBLIC });
      // the service lives in real time, like the one on the VM
      api.clock.now = Date.now();
      const clock = api.clock;
      setInterval(() => {
        clock.now = Date.now();
      }, 100).unref();
      world = await startSeedWorld(api);
      // VMGS_LIVE_WORLD=fresh is the first hour of a new VM: ticks and a heartbeat, no candles, no signals, no calendar
      const fresh = process.env.VMGS_LIVE_WORLD === 'fresh';
      if (fresh) {
        await tickPartitions(api, Date.now());
        // the worker registers every strategy when it starts
        for (const key of STRATEGY_KEYS) {
          await world.store.ensureStrategyVersion(defaultStrategyConfig(key));
        }
      } else await seedLive(api, world, Date.now());
      const simulator = startWorkerSimulator(api, { warm: !fresh });
      await startLiveControl({
        api,
        world,
        simulator,
        port: Number(process.env.VMGS_LIVE_CONTROL_PORT ?? 3001),
      });
      await api.app.listen({ host: '127.0.0.1', port });
      await new Promise(() => undefined);
    },
    24 * 60 * 60 * 1000,
  );
});
