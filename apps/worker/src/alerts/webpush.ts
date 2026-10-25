import { createHash } from 'node:crypto';

import webpush from 'web-push';

import type { PushSubscriptionRecord } from '../alerts/store';

/** What goes to the service worker of the dashboard: it shows the title and the body, a click opens `url`. */
export interface PushPayload {
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly tag: string;
  readonly ttlSec: number;
  readonly urgency: 'very-low' | 'low' | 'normal' | 'high';
}

export type PushResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** The push service says the subscription no longer exists (404, 410): it is removed. */
      readonly gone: boolean;
      /** The message itself was refused (400, 413): trying again cannot help. */
      readonly permanent: boolean;
      readonly message: string;
    };

/** The one thing the sender needs from Web Push: deliver a message to one subscription. */
export interface WebPushSink {
  send(
    subscription: PushSubscriptionRecord,
    payload: PushPayload,
    ttlSec: number,
  ): Promise<PushResult>;
}

/** The `Topic` header is at most 32 characters of the URL-safe base64 alphabet: a hash of the tag, so a repeat replaces the earlier message. */
export function topicOf(tag: string): string {
  return createHash('sha256').update(tag).digest('base64url').slice(0, 32);
}

/** The options of one delivery: how long the push service may hold it, how urgent it is, and what replaces it. */
export function pushOptionsFor(payload: PushPayload, ttlSec: number): webpush.RequestOptions {
  return {
    TTL: Math.max(0, Math.floor(ttlSec)),
    urgency: payload.urgency,
    topic: topicOf(payload.tag),
  };
}

/** The text that is encrypted for the browser. */
export const pushBodyOf = (payload: PushPayload): string =>
  JSON.stringify({ title: payload.title, body: payload.body, url: payload.url, tag: payload.tag });

export interface VapidDetails {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

type SendFunction = (
  subscription: webpush.PushSubscription,
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>;

/**
 * Web Push through the `web-push` library (01_HLD section 11: old but verified on Node 22 and 24,
 * isolated behind this interface). The VAPID keys are given with each call, not set globally.
 */
export class LibWebPushSink implements WebPushSink {
  constructor(
    private readonly vapid: VapidDetails,
    private readonly send_: SendFunction = (subscription, payload, options) =>
      webpush.sendNotification(subscription, payload, options),
  ) {}

  async send(
    subscription: PushSubscriptionRecord,
    payload: PushPayload,
    ttlSec: number,
  ): Promise<PushResult> {
    try {
      await this.send_(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        pushBodyOf(payload),
        {
          ...pushOptionsFor(payload, ttlSec),
          vapidDetails: {
            subject: this.vapid.subject,
            publicKey: this.vapid.publicKey,
            privateKey: this.vapid.privateKey,
          },
          timeout: 15_000,
        },
      );
      return { ok: true };
    } catch (error) {
      const status =
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        typeof error.statusCode === 'number'
          ? error.statusCode
          : null;
      const text = error instanceof Error ? error.message : 'push failed';
      return {
        ok: false,
        gone: status === 404 || status === 410,
        permanent: status === 400 || status === 413,
        message: status === null ? text : `HTTP ${String(status)}: ${text}`,
      };
    }
  }
}
