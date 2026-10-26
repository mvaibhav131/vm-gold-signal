import type { PushStatusResponse } from '@vmgs/contracts';

/** What the Web Push section can say about this device, in the order that it is decided. */
export type PushState =
  /** The simulated preview: there is no server to subscribe to. */
  | { readonly kind: 'preview' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'failed' }
  /** An iPhone or iPad where the app is not on the home screen. */
  | { readonly kind: 'needs-install' }
  | { readonly kind: 'unsupported' }
  /** The server has no VAPID keys. */
  | { readonly kind: 'not-set-up' }
  /** The owner said no to notifications for this site. */
  | { readonly kind: 'blocked' }
  /** This browser can subscribe and has not. */
  | { readonly kind: 'off'; readonly devices: number }
  | { readonly kind: 'on'; readonly devices: number }
  /** This browser holds a subscription that the server does not know (it was removed there). */
  | { readonly kind: 'lost' };

export interface PushFacts {
  readonly apiKind: 'mock' | 'live';
  /** undefined while it is being asked; `null` when the question failed. */
  readonly status: PushStatusResponse | null | undefined;
  readonly supported: boolean;
  readonly needsInstall: boolean;
  readonly permission: NotificationPermission;
  /** Whether this browser holds a subscription; undefined while it is being looked at. */
  readonly subscribed: boolean | undefined;
}

export function pushStateOf(facts: PushFacts): PushState {
  if (facts.apiKind === 'mock') return { kind: 'preview' };
  if (facts.needsInstall) return { kind: 'needs-install' };
  if (!facts.supported) return { kind: 'unsupported' };
  if (facts.status === null) return { kind: 'failed' };
  if (facts.status === undefined || facts.subscribed === undefined) return { kind: 'checking' };
  if (facts.status.publicKey === null) return { kind: 'not-set-up' };
  if (facts.subscribed) {
    return facts.status.devices === 0
      ? { kind: 'lost' }
      : { kind: 'on', devices: facts.status.devices };
  }
  if (facts.permission === 'denied') return { kind: 'blocked' };
  return { kind: 'off', devices: facts.status.devices };
}

/** Why a try to subscribe did not work: the three that the owner can do something about, and the rest. */
export class PushProblem extends Error {
  readonly reason: 'blocked' | 'not-set-up' | 'no-keys' | 'failed';

  constructor(reason: PushProblem['reason'], message: string) {
    super(message);
    this.name = 'PushProblem';
    this.reason = reason;
  }
}

/** The words for a failed try, for the screen. Nothing of the endpoint or the keys. */
export function enableProblemText(error: unknown): string {
  if (error instanceof PushProblem) {
    switch (error.reason) {
      case 'blocked':
        return 'Notifications were not allowed, so this device cannot be subscribed. Allow them for this site in the settings of the browser and try again.';
      case 'not-set-up':
        return 'Web Push is not set up on the server.';
      case 'no-keys':
        return 'The browser did not give the keys that a subscription needs. Try again.';
      case 'failed':
        return 'This device could not be subscribed. Try again.';
    }
  }
  return 'This device could not be subscribed. Check the connection and try again.';
}
