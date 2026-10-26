import { createServer, type Server } from 'node:http';

import type { StrategyKey } from '@vmgs/core';

import type { WorkerSimulator } from './liveSeed';
import type { PgApi } from './pgApi';
import { MINUTE_MS, outcomeOf, type SeededSignal, type SeedWorld } from './seedWorld';

/** The price of the entry of the signals of the seed, and so the break-even stop after TP1. */
const ENTRY = 4017.37;

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

/**
 * The hand on the simulated worker that a browser test needs: the things that happen in the stack while a page is open
 * (a signal is created, reaches TP1 or closes; the feed goes quiet; the worker dies). A tiny HTTP server on the loopback
 * only, started by `liveStack.int.test.ts`; the e2e specs call it with the request context of Playwright.
 *
 *   POST /ticks/on|off            the recorder writes ticks or not (the feed goes stale)
 *   POST /worker/on|off           the whole worker is there or not (no tick, no heartbeat: disconnected)
 *   POST /signal/new?side=&strategy=   a new open signal, made now; answers { id, seq }
 *   POST /signal/<id>/tp1|win|loss     moves that signal as the tracker would
 *   POST /sessions/revoke-all     ends every session (each scenario that logs in starts one, and the list of sessions shows them all)
 *   POST /outbox/last             the newest row of the outbox (channel, kind, payload): what the API queued for the worker to send
 *   POST /throttle/reset          forgets the failed logins (a scenario that fails on purpose leaves the owner as it found him)
 */
export function startLiveControl(options: {
  api: PgApi;
  world: SeedWorld;
  simulator: WorkerSimulator;
  port: number;
}): Promise<Server> {
  const { api, world, simulator } = options;
  const created = new Map<string, SeededSignal>();

  async function handle(method: string, url: URL): Promise<Reply> {
    const path = url.pathname.split('/').filter((part) => part !== '');
    if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
    const [area, what, action] = path;

    if (area === 'ticks' && (what === 'on' || what === 'off')) {
      simulator.setTicks(what === 'on');
      return { status: 200, body: { ticks: what } };
    }
    if (area === 'worker' && (what === 'on' || what === 'off')) {
      simulator.setWorker(what === 'on');
      return { status: 200, body: { worker: what } };
    }
    if (area === 'throttle' && what === 'reset') {
      await api.admin.query('DELETE FROM login_attempts WHERE NOT success');
      return { status: 200, body: { reset: true } };
    }
    if (area === 'outbox' && what === 'last') {
      const { rows } = await api.admin.query<{ channel: string; kind: string; payload: unknown }>(
        'SELECT channel, kind, payload FROM notification_outbox ORDER BY created_at DESC LIMIT 1',
      );
      return { status: 200, body: rows[0] ?? null };
    }
    if (area === 'sessions' && what === 'revoke-all') {
      await api.admin.query('UPDATE auth_sessions SET revoked_at = $1 WHERE revoked_at IS NULL', [
        new Date(api.clock.now),
      ]);
      return { status: 200, body: { revoked: true } };
    }
    if (area === 'signal' && what === 'new') {
      const side = url.searchParams.get('side') === 'SELL' ? 'SELL' : 'BUY';
      const strategy = (url.searchParams.get('strategy') ?? 'trend_pullback') as StrategyKey;
      const signal = await world.createSignal({
        strategy,
        side,
        generatedAt: api.clock.now,
        qualityScore: 80,
      });
      created.set(signal.id, signal);
      return { status: 200, body: { id: signal.id, seq: signal.seq } };
    }
    const signal = what === undefined ? undefined : created.get(what);
    if (area === 'signal' && signal !== undefined) {
      const at = api.clock.now;
      if (action === 'tp1') {
        await world.setState(
          signal.id,
          { status: 'TP1_HIT', stopLossCurrent: ENTRY, tp1HitAt: at, mfeR: 1.1, maeR: -0.1 },
          at,
        );
        return { status: 200, body: { tp1: true } };
      }
      if (action === 'win' || action === 'loss') {
        const closedAt = at + MINUTE_MS;
        await world.close(
          signal,
          outcomeOf(action === 'win' ? 'WIN' : 'LOSS', closedAt, { durationS: 60 }),
        );
        return { status: 200, body: { closed: action } };
      }
    }
    return { status: 404, body: { error: 'unknown control' } };
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    void handle(request.method ?? 'GET', url)
      .catch((error: unknown): Reply => ({
        status: 500,
        body: { error: error instanceof Error ? error.message : String(error) },
      }))
      .then((reply) => {
        response.writeHead(reply.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(reply.body));
      });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}
