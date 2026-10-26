import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import {
  notificationTestRequestSchema,
  notificationTestResponseSchema,
  pushStatusResponseSchema,
  pushSubscribeRequestSchema,
  pushUnsubscribeRequestSchema,
} from '@vmgs/contracts';
import { systemOutboxRows, testEventKey, testMessage } from '@vmgs/core';

import { emptyRoute, jsonRoute } from '../http/route';
import { ProblemError } from '../http/problem';
import { PostgresSettingsStore, type SettingsStore } from '../settings/store';
import { PostgresNotificationStore, type NotificationStore, type PushStore } from './store';

const API_BASE = '/api/v1';

export interface NotificationDeps {
  readonly notifications: NotificationStore;
  readonly push: PushStore;
  /** The public VAPID key of the server (the one the browsers subscribe with), or null when Web Push is not set up. */
  readonly vapidPublicKey: string | null;
  /** The language and the time zone of the test message are the ones of the settings of that moment. */
  readonly settings: Pick<SettingsStore, 'read'>;
  readonly now: () => number;
  readonly newId?: () => string;
}

/** The dependencies of the notification routes on the real database. */
export function postgresNotificationDeps(
  pool: Pick<Pool, 'query' | 'connect'>,
  now: () => number,
  vapidPublicKey: string | null = null,
): NotificationDeps {
  const store = new PostgresNotificationStore(pool);
  return {
    notifications: store,
    push: store,
    vapidPublicKey,
    settings: new PostgresSettingsStore(pool),
    now,
  };
}

/**
 * `POST /notifications/test`, `GET /push/status` and the Web Push subscription (04 sections 2 and 5).
 *
 * The test message is built by the same functions as `pnpm cli telegram:test` and goes into the outbox the same way
 * (event key `test:<uuid>`, kind `TEST`, an hour to live), so the worker's sender delivers it and labels it as a test.
 * The channel is the one the owner asks for: the switches of the alerts decide who is told about a signal, not whether
 * the owner may try a channel.
 *
 * Subscribing never changes `alerts.webpush.enabled`: the docs do not say it should, and the switch is the owner's.
 * The endpoint and the keys are never logged and never in an error.
 */
export function registerNotificationRoutes(app: FastifyInstance, deps: NotificationDeps): void {
  const newId = deps.newId ?? randomUUID;

  jsonRoute(app, {
    method: 'POST',
    url: `${API_BASE}/notifications/test`,
    body: notificationTestRequestSchema,
    response: notificationTestResponseSchema,
    handler: async ({ body }) => {
      const now = deps.now();
      const { displayTz, locale } = await deps.settings.read();
      const eventKey = testEventKey(newId());
      const [row] = systemOutboxRows(
        testMessage(now, { locale, displayTz }),
        eventKey,
        [body.channel],
        now,
      );
      if (row?.kind !== 'TEST') throw new Error('the test message has no row');
      const result = await deps.notifications.queueTest(
        {
          eventKey: row.eventKey,
          channel: row.channel,
          kind: 'TEST',
          payload: row.payload,
          expiresAt: row.expiresAt ?? now,
        },
        now,
      );
      if (result === 'NO_SUBSCRIPTION') {
        throw new ProblemError(
          409,
          'no_push_subscription',
          'No device is subscribed to Web Push yet.',
        );
      }
      return { eventKey };
    },
  });

  // The public key is not a secret (every browser that subscribes is given it), but the route is private like the others:
  // only the owner has a reason to ask.
  jsonRoute(app, {
    method: 'GET',
    url: `${API_BASE}/push/status`,
    response: pushStatusResponseSchema,
    handler: async () => ({
      publicKey: deps.vapidPublicKey,
      devices: await deps.push.countSubscriptions(),
    }),
  });

  emptyRoute(app, {
    method: 'POST',
    url: `${API_BASE}/push/subscribe`,
    body: pushSubscribeRequestSchema,
    handler: async ({ body }) => {
      await deps.push.subscribe({
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent: body.userAgent ?? null,
      });
    },
  });

  emptyRoute(app, {
    method: 'DELETE',
    url: `${API_BASE}/push/subscribe`,
    body: pushUnsubscribeRequestSchema,
    handler: async ({ body }) => {
      await deps.push.unsubscribe(body.endpoint);
    },
  });
}
