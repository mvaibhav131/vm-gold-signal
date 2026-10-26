import { createContext, useContext } from 'react';

/** What the app needs to know about the subscription of this browser, and nothing of the browser's own types. */
export interface DeviceSubscription {
  readonly endpoint: string;
  /** The two keys the server encrypts with, or null when the browser did not give them. */
  keys(): { readonly p256dh: string; readonly auth: string } | null;
  unsubscribe(): Promise<boolean>;
}

/**
 * The browser as Web Push sees it. The real one is `browserPushEnv`; a test gives another, because no test browser can
 * reach a push service.
 */
export interface PushEnv {
  /** The browser has a service worker, a push manager and notifications. */
  supported(): boolean;
  /** An iPhone or iPad that has not got the app on its home screen: Web Push does not exist there until it has. */
  needsInstall(): boolean;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  /** The subscription this browser holds, or null. */
  current(): Promise<DeviceSubscription | null>;
  /** Subscribes with the public key of the server. Needs the permission and the service worker. */
  subscribe(applicationServerKey: Uint8Array<ArrayBuffer>): Promise<DeviceSubscription>;
}

function wrap(subscription: PushSubscription): DeviceSubscription {
  return {
    endpoint: subscription.endpoint,
    keys() {
      const keys = subscription.toJSON().keys;
      const p256dh = keys?.p256dh;
      const auth = keys?.auth;
      return p256dh === undefined || auth === undefined ? null : { p256dh, auth };
    },
    unsubscribe: () => subscription.unsubscribe(),
  };
}

const READY_WAIT_MS = 8000;

/** The worker that has taken over, or a failure: a page opened before the worker was there would wait for ever. */
async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error('the service worker of the app is not running'));
    }, READY_WAIT_MS);
  });
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

const isApple = (): boolean =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  // an iPad that says it is a Mac
  (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);

const isInstalled = (): boolean =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

export function browserPushEnv(): PushEnv {
  return {
    supported: () =>
      'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    needsInstall: () => isApple() && !isInstalled(),
    permission: () => ('Notification' in window ? Notification.permission : 'denied'),
    requestPermission: () => Notification.requestPermission(),
    async current() {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      return subscription ? wrap(subscription) : null;
    },
    async subscribe(applicationServerKey) {
      const registration = await activeRegistration();
      return wrap(
        await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }),
      );
    },
  };
}

export const PushEnvContext = createContext<PushEnv | null>(null);

let real: PushEnv | null = null;

/** The browser's own environment unless a test put another in the context. */
export function usePushEnv(): PushEnv {
  const given = useContext(PushEnvContext);
  real ??= browserPushEnv();
  return given ?? real;
}
