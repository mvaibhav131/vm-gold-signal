import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  PushStatusResponse,
  PushSubscribeRequest,
  PushUnsubscribeRequest,
} from '@vmgs/contracts';
import { describe, expect, it, vi, type Mock } from 'vitest';

import { ApiError, type ApiClient } from './api/client';
import { MOCK_PASSWORD, MOCK_USERNAME, createMockClient } from './mocks/mockClient';
import { urlBase64ToBytes } from './push/key';
import { registerServiceWorker } from './push/register';
import type { DeviceSubscription, PushEnv } from './push/env';
import { enableProblemText, PushProblem, pushStateOf, type PushFacts } from './push/state';
import { memoryStorage, renderApp } from './test-utils';

const KEY = `B${'A'.repeat(86)}`;
const KEYS = { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) };
const ENDPOINT = 'https://push.example.org/send/device-1';

describe('urlBase64ToBytes', () => {
  it('reads base64url with and without padding, and the two characters that differ from base64', () => {
    expect(Array.from(urlBase64ToBytes('AQID'))).toEqual([1, 2, 3]);
    expect(Array.from(urlBase64ToBytes('AQI'))).toEqual([1, 2]);
    expect(Array.from(urlBase64ToBytes('AQ'))).toEqual([1]);
    // 0xFB 0xFF 0xBF is "+/+/" in base64 and "-_-_" in base64url
    expect(Array.from(urlBase64ToBytes('-_-_'))).toEqual([0xfb, 0xff, 0xbf]);
    expect(Array.from(urlBase64ToBytes(''))).toEqual([]);
  });

  it('turns a key of the server (87 characters) into the 65 bytes of a P-256 point', () => {
    expect(urlBase64ToBytes(KEY)).toHaveLength(65);
  });
});

describe('pushStateOf', () => {
  const facts: PushFacts = {
    apiKind: 'live',
    status: { publicKey: KEY, devices: 1 },
    supported: true,
    needsInstall: false,
    permission: 'default',
    subscribed: false,
  };
  const kind = (over: Partial<PushFacts>) => pushStateOf({ ...facts, ...over }).kind;

  it('is the preview before anything else: there is no server to subscribe to', () => {
    expect(kind({ apiKind: 'mock', needsInstall: true, supported: false })).toBe('preview');
  });

  it('asks an iPhone to install the app before it says that the browser cannot do it', () => {
    expect(kind({ needsInstall: true, supported: false })).toBe('needs-install');
    expect(kind({ supported: false })).toBe('unsupported');
  });

  it('waits for both answers, and says so when the server could not be asked', () => {
    expect(kind({ status: undefined })).toBe('checking');
    expect(kind({ subscribed: undefined })).toBe('checking');
    expect(kind({ status: null })).toBe('failed');
  });

  it('says that the server is not set up when it has no key, even for a browser that holds a subscription', () => {
    expect(kind({ status: { publicKey: null, devices: 0 } })).toBe('not-set-up');
    expect(kind({ status: { publicKey: null, devices: 0 }, subscribed: true })).toBe('not-set-up');
  });

  it('is on for a subscribed browser that the server knows, and lost when the server has no device', () => {
    expect(pushStateOf({ ...facts, subscribed: true })).toEqual({ kind: 'on', devices: 1 });
    expect(kind({ subscribed: true, status: { publicKey: KEY, devices: 0 } })).toBe('lost');
  });

  it('is blocked only for a browser that is not subscribed (a subscription outlives a later refusal)', () => {
    expect(kind({ permission: 'denied' })).toBe('blocked');
    expect(kind({ permission: 'denied', subscribed: true })).toBe('on');
  });

  it('is off for a browser that can subscribe, with the number of the other devices', () => {
    expect(pushStateOf({ ...facts, status: { publicKey: KEY, devices: 3 } })).toEqual({
      kind: 'off',
      devices: 3,
    });
    expect(kind({ permission: 'granted' })).toBe('off');
  });
});

describe('enableProblemText', () => {
  it('tells the owner what to do for the problems that he can fix, and never repeats an error message', () => {
    expect(enableProblemText(new PushProblem('blocked', 'x'))).toContain('Allow them');
    expect(enableProblemText(new PushProblem('not-set-up', 'x'))).toContain('not set up');
    expect(enableProblemText(new PushProblem('no-keys', 'x'))).toContain('keys');
    expect(enableProblemText(new PushProblem('failed', 'x'))).toBe(
      'This device could not be subscribed. Try again.',
    );
    const other = enableProblemText(new Error('push service says secret-endpoint'));
    expect(other).not.toContain('secret-endpoint');
    expect(other).toContain('connection');
  });
});

describe('registerServiceWorker', () => {
  const container = () => ({
    register: vi.fn(() => Promise.resolve({} as ServiceWorkerRegistration)),
  });

  it('does nothing outside a build for production, or in a browser with no service workers', () => {
    const worker = container();
    registerServiceWorker({ production: false, container: worker, loaded: () => true });
    registerServiceWorker({ production: true, container: undefined, loaded: () => true });
    expect(worker.register).not.toHaveBeenCalled();
  });

  it('registers /sw.js for the whole site, at once when the page has loaded', () => {
    const worker = container();
    registerServiceWorker({ production: true, container: worker, loaded: () => true });
    expect(worker.register).toHaveBeenCalledExactlyOnceWith('/sw.js', { scope: '/' });
  });

  it('waits for the load of the page, so that the worker does not compete with the first screen', () => {
    const worker = container();
    let load: () => void = () => undefined;
    registerServiceWorker({
      production: true,
      container: worker,
      loaded: () => false,
      onLoad: (callback) => {
        load = callback;
      },
    });
    expect(worker.register).not.toHaveBeenCalled();
    load();
    expect(worker.register).toHaveBeenCalledOnce();
  });

  it('does not fail the page when the registration is refused', async () => {
    const refused = { register: vi.fn(() => Promise.reject(new Error('no'))) };
    expect(() => {
      registerServiceWorker({ production: true, container: refused, loaded: () => true });
    }).not.toThrow();
    await Promise.resolve();
    expect(refused.register).toHaveBeenCalledOnce();
  });
});

// ------------------------------------------------------------------------------------------ the Web Push section

interface FakeSubscription extends DeviceSubscription {
  readonly unsubscribed: Mock<() => Promise<boolean>>;
}

function subscriptionOf(keys: DeviceSubscription['keys'] extends () => infer K ? K : never) {
  const unsubscribed = vi.fn<() => Promise<boolean>>(() => Promise.resolve(true));
  const subscription: FakeSubscription = {
    endpoint: ENDPOINT,
    keys: () => keys,
    unsubscribe: unsubscribed,
    unsubscribed,
  };
  return subscription;
}

/** A browser that can subscribe: the permission and the subscription are the ones a test sets. */
function fakeEnv(
  options: {
    supported?: boolean;
    needsInstall?: boolean;
    permission?: NotificationPermission;
    asked?: NotificationPermission;
    subscription?: FakeSubscription | null;
    next?: FakeSubscription;
  } = {},
) {
  const state = {
    permission: options.permission ?? 'default',
    subscription: options.subscription ?? null,
  };
  const subscribe = vi.fn((_key: Uint8Array<ArrayBuffer>) => {
    const made = options.next ?? subscriptionOf(KEYS);
    state.subscription = made;
    return Promise.resolve(made);
  });
  const requestPermission = vi.fn(() => {
    state.permission = options.asked ?? 'granted';
    return Promise.resolve(state.permission);
  });
  const current = vi.fn(() => Promise.resolve(state.subscription));
  const env: PushEnv = {
    supported: () => options.supported ?? true,
    needsInstall: () => options.needsInstall ?? false,
    permission: () => state.permission,
    requestPermission,
    current,
    subscribe,
  };
  return { env, state, subscribe, requestPermission, current };
}

/** A logged-in client of the live kind whose server side of Web Push is a few variables. */
async function liveClient(server: { publicKey: string | null; devices: number }) {
  const mock = createMockClient({
    storage: memoryStorage(),
    latencyMs: 0,
    quoteIntervalMs: 600_000,
    signalUpdateIntervalMs: 600_000,
  });
  await mock.login({ username: MOCK_USERNAME, password: MOCK_PASSWORD });
  const calls: string[] = [];
  const subscribePush = vi.fn((request: PushSubscribeRequest) => {
    calls.push(`subscribe ${request.endpoint}`);
    server.devices += 1;
    return Promise.resolve();
  });
  const unsubscribePush = vi.fn((request: PushUnsubscribeRequest) => {
    calls.push(`unsubscribe ${request.endpoint}`);
    server.devices = Math.max(0, server.devices - 1);
    return Promise.resolve();
  });
  const sendTestNotification = vi.fn(() => Promise.resolve({ eventKey: `test:${'1'.repeat(36)}` }));
  const client: ApiClient = {
    ...mock,
    kind: 'live',
    getPushStatus: () => Promise.resolve<PushStatusResponse>({ ...server }),
    subscribePush,
    unsubscribePush,
    sendTestNotification,
  };
  return { client, calls, server, spies: { subscribePush, unsubscribePush, sendTestNotification } };
}

async function openAlerts(client: ApiClient, env: PushEnv) {
  renderApp({ client, route: '/system?tab=alerts', pushEnv: env });
  await screen.findByTestId('alerts-webpush-note');
  return userEvent.setup();
}

const note = () => screen.getByTestId('alerts-webpush-note');

describe('the Web Push section on the live client', () => {
  it('subscribes this device: asks for the permission, subscribes with the key of the server, tells the server, and shows it is on', async () => {
    const { client, calls, spies } = await liveClient({ publicKey: KEY, devices: 0 });
    const { env, subscribe, requestPermission } = fakeEnv();
    const user = await openAlerts(client, env);
    await waitFor(() => {
      expect(note()).toHaveTextContent('No device is subscribed.');
    });
    expect(screen.getByTestId('alerts-webpush-test')).toBeDisabled();

    await user.click(screen.getByTestId('alerts-webpush-subscribe'));
    await waitFor(() => {
      expect(note()).toHaveTextContent('This device is subscribed. 1 device in all');
    });
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(subscribe.mock.calls[0]?.[0]).toHaveLength(65);
    expect(spies.subscribePush).toHaveBeenCalledExactlyOnceWith({
      endpoint: ENDPOINT,
      keys: KEYS,
      userAgent: expect.stringContaining('Mozilla') as unknown,
    });
    expect(calls).toEqual([`subscribe ${ENDPOINT}`]);
    expect(screen.getByTestId('alerts-webpush-unsubscribe')).toBeInTheDocument();
    expect(screen.queryByTestId('alerts-webpush-subscribe')).toBeNull();
    expect(screen.getByTestId('alerts-webpush-test')).toBeEnabled();
  });

  it('does not subscribe when the owner says no to the question of the browser, and says what to do', async () => {
    const { client, spies } = await liveClient({ publicKey: KEY, devices: 0 });
    const { env, subscribe } = fakeEnv({ asked: 'denied' });
    const user = await openAlerts(client, env);
    await waitFor(() => {
      expect(screen.getByTestId('alerts-webpush-subscribe')).toBeEnabled();
    });
    await user.click(screen.getByTestId('alerts-webpush-subscribe'));
    expect(await screen.findByTestId('alerts-webpush-error')).toHaveTextContent('Allow them');
    expect(subscribe).not.toHaveBeenCalled();
    expect(spies.subscribePush).not.toHaveBeenCalled();
    // asked, answered no: the section is now the blocked one
    await waitFor(() => {
      expect(note()).toHaveTextContent('Notifications are blocked for this site');
    });
    expect(screen.getByTestId('alerts-webpush-subscribe')).toBeDisabled();
  });

  it('says that the server is not set up when its key is gone by the time the owner presses the button', async () => {
    const { client, server, spies } = await liveClient({ publicKey: KEY, devices: 0 });
    const { env, subscribe } = fakeEnv();
    const user = await openAlerts(client, env);
    await waitFor(() => {
      expect(screen.getByTestId('alerts-webpush-subscribe')).toBeEnabled();
    });
    server.publicKey = null;
    await user.click(screen.getByTestId('alerts-webpush-subscribe'));
    expect(await screen.findByTestId('alerts-webpush-error')).toHaveTextContent(
      'Web Push is not set up on the server.',
    );
    expect(subscribe).not.toHaveBeenCalled();
    expect(spies.subscribePush).not.toHaveBeenCalled();
  });

  it('lets the browser go of a subscription that the server did not take', async () => {
    const { client, spies } = await liveClient({ publicKey: KEY, devices: 0 });
    const made = subscriptionOf(KEYS);
    const { env } = fakeEnv({ next: made });
    spies.subscribePush.mockRejectedValueOnce(
      new ApiError(500, 'internal_error', 'secret-endpoint failed'),
    );
    const user = await openAlerts(client, env);
    await waitFor(() => {
      expect(screen.getByTestId('alerts-webpush-subscribe')).toBeEnabled();
    });
    await user.click(screen.getByTestId('alerts-webpush-subscribe'));
    expect(await screen.findByTestId('alerts-webpush-error')).toHaveTextContent(
      'could not be subscribed',
    );
    expect(screen.getByTestId('alerts-webpush-error')).not.toHaveTextContent('secret-endpoint');
    expect(made.unsubscribed).toHaveBeenCalledOnce();
  });

  it('refuses a subscription without keys, and lets the browser go of it', async () => {
    const { client, spies } = await liveClient({ publicKey: KEY, devices: 0 });
    const made = subscriptionOf(null);
    const { env } = fakeEnv({ next: made });
    const user = await openAlerts(client, env);
    await waitFor(() => {
      expect(screen.getByTestId('alerts-webpush-subscribe')).toBeEnabled();
    });
    await user.click(screen.getByTestId('alerts-webpush-subscribe'));
    expect(await screen.findByTestId('alerts-webpush-error')).toHaveTextContent('keys');
    expect(made.unsubscribed).toHaveBeenCalledOnce();
    expect(spies.subscribePush).not.toHaveBeenCalled();
  });

  it('says that the browser could not subscribe when the push service is out of reach', async () => {
    const { client, spies } = await liveClient({ publicKey: KEY, devices: 0 });
    const { env, subscribe } = fakeEnv();
    subscribe.mockRejectedValueOnce(new DOMException('push service error', 'AbortError'));
    const user = await openAlerts(client, env);
    await waitFor(() => {
      expect(screen.getByTestId('alerts-webpush-subscribe')).toBeEnabled();
    });
    await user.click(screen.getByTestId('alerts-webpush-subscribe'));
    expect(await screen.findByTestId('alerts-webpush-error')).toHaveTextContent(
      'Check the connection',
    );
    expect(spies.subscribePush).not.toHaveBeenCalled();
  });

  it('unsubscribes: the server is told first, then the browser lets go, and the section is off again', async () => {
    const { client, calls } = await liveClient({ publicKey: KEY, devices: 1 });
    const held = subscriptionOf(KEYS);
    held.unsubscribed.mockImplementation(() => {
      calls.push('browser lets go');
      return Promise.resolve(true);
    });
    const { env, state } = fakeEnv({ permission: 'granted', subscription: held });
    const user = await openAlerts(client, env);
    await waitFor(() => {
      expect(note()).toHaveTextContent('This device is subscribed.');
    });
    state.subscription = held;
    held.unsubscribed.mockImplementation(() => {
      calls.push('browser lets go');
      state.subscription = null;
      return Promise.resolve(true);
    });
    await user.click(screen.getByTestId('alerts-webpush-unsubscribe'));
    await waitFor(() => {
      expect(screen.getByTestId('alerts-webpush-subscribe')).toBeEnabled();
    });
    expect(calls).toEqual([`unsubscribe ${ENDPOINT}`, 'browser lets go']);
    expect(note()).toHaveTextContent('No device is subscribed.');
  });

  it('does nothing, and says nothing wrong, when the subscription of the browser is gone by the time the owner presses the button', async () => {
    const { client, spies } = await liveClient({ publicKey: KEY, devices: 1 });
    const held = subscriptionOf(KEYS);
    const { env, current } = fakeEnv({ permission: 'granted', subscription: held });
    const user = await openAlerts(client, env);
    await waitFor(() => {
      expect(screen.getByTestId('alerts-webpush-unsubscribe')).toBeEnabled();
    });
    current.mockResolvedValueOnce(null);
    await user.click(screen.getByTestId('alerts-webpush-unsubscribe'));
    await waitFor(() => {
      expect(screen.getByTestId('alerts-webpush-unsubscribe')).toBeEnabled();
    });
    expect(spies.unsubscribePush).not.toHaveBeenCalled();
    expect(held.unsubscribed).not.toHaveBeenCalled();
    expect(screen.queryByTestId('alerts-webpush-error')).toBeNull();
  });

  it('keeps the subscription of the browser when the server could not be told, and says so', async () => {
    const { client, spies } = await liveClient({ publicKey: KEY, devices: 1 });
    const held = subscriptionOf(KEYS);
    const { env } = fakeEnv({ permission: 'granted', subscription: held });
    spies.unsubscribePush.mockRejectedValueOnce(new Error('down'));
    const user = await openAlerts(client, env);
    await waitFor(() => {
      expect(screen.getByTestId('alerts-webpush-unsubscribe')).toBeEnabled();
    });
    await user.click(screen.getByTestId('alerts-webpush-unsubscribe'));
    expect(await screen.findByTestId('alerts-webpush-error')).toHaveTextContent(
      'could not be unsubscribed',
    );
    expect(held.unsubscribed).not.toHaveBeenCalled();
    expect(note()).toHaveTextContent('This device is subscribed.');
  });

  it('sends a test notification to the subscribed devices, and shows the key of the message', async () => {
    const { client, spies } = await liveClient({ publicKey: KEY, devices: 1 });
    const { env } = fakeEnv({ permission: 'granted', subscription: subscriptionOf(KEYS) });
    const user = await openAlerts(client, env);
    await waitFor(() => {
      expect(screen.getByTestId('alerts-webpush-test')).toBeEnabled();
    });
    await user.click(screen.getByTestId('alerts-webpush-test'));
    expect(spies.sendTestNotification).toHaveBeenCalledExactlyOnceWith({ channel: 'webpush' });
    expect(await screen.findByTestId('alerts-webpush-result')).toHaveTextContent(
      `Test notification queued (test:${'1'.repeat(36)}).`,
    );
  });

  it('says why a test could not be queued: the words of the server for a problem it names, a plain line for the rest', async () => {
    const { client, spies } = await liveClient({ publicKey: KEY, devices: 1 });
    const { env } = fakeEnv({ permission: 'granted', subscription: subscriptionOf(KEYS) });
    spies.sendTestNotification
      .mockRejectedValueOnce(
        new ApiError(409, 'no_push_subscription', 'No device is subscribed to Web Push yet.'),
      )
      .mockRejectedValueOnce(new Error('down'));
    const user = await openAlerts(client, env);
    await waitFor(() => {
      expect(screen.getByTestId('alerts-webpush-test')).toBeEnabled();
    });
    await user.click(screen.getByTestId('alerts-webpush-test'));
    expect(await screen.findByTestId('alerts-webpush-result')).toHaveTextContent(
      'No device is subscribed to Web Push yet.',
    );
    await user.click(screen.getByTestId('alerts-webpush-test'));
    await waitFor(() => {
      expect(screen.getByTestId('alerts-webpush-result')).toHaveTextContent(
        'The test notification could not be queued.',
      );
    });
  });

  const missing: [
    string,
    Parameters<typeof fakeEnv>[0],
    { publicKey: string | null; devices: number },
    string,
  ][] = [
    ['not set up on the server', {}, { publicKey: null, devices: 0 }, 'it has no VAPID keys'],
    [
      'an iPhone with no home-screen app',
      { needsInstall: true, supported: false },
      { publicKey: KEY, devices: 0 },
      'Add to Home Screen',
    ],
    [
      'a browser without Web Push',
      { supported: false },
      { publicKey: KEY, devices: 0 },
      'This browser cannot receive Web Push',
    ],
    [
      'notifications blocked',
      { permission: 'denied' },
      { publicKey: KEY, devices: 0 },
      'are blocked for this site',
    ],
  ];

  it.each(missing)(
    'says what is missing for %s, and keeps the buttons off',
    async (_name, envOptions, server, text) => {
      const { client } = await liveClient(server);
      const { env, current } = fakeEnv(envOptions);
      await openAlerts(client, env);
      await waitFor(() => {
        expect(note()).toHaveTextContent(text);
      });
      expect(screen.getByTestId('alerts-webpush-subscribe')).toBeDisabled();
      expect(screen.getByTestId('alerts-webpush-test')).toBeDisabled();
      // a browser that cannot do Web Push has no subscription to look at: it is not asked
      if (envOptions?.supported === false) expect(current).not.toHaveBeenCalled();
    },
  );

  it('counts the devices in words: one or more, with this one or without it', async () => {
    const other = await liveClient({ publicKey: KEY, devices: 1 });
    await openAlerts(other.client, fakeEnv().env);
    await waitFor(() => {
      expect(note()).toHaveTextContent(
        'This device is not subscribed. 1 other device receive Web Push.',
      );
    });
    cleanup();

    const others = await liveClient({ publicKey: KEY, devices: 3 });
    await openAlerts(others.client, fakeEnv().env);
    await waitFor(() => {
      expect(note()).toHaveTextContent(
        'This device is not subscribed. 3 other devices receive Web Push.',
      );
    });
    expect(screen.getByTestId('alerts-webpush-subscribe')).toBeEnabled();
    // another device receives a test even when this one is not subscribed
    expect(screen.getByTestId('alerts-webpush-test')).toBeEnabled();
    cleanup();

    const several = await liveClient({ publicKey: KEY, devices: 2 });
    const held = fakeEnv({ permission: 'granted', subscription: subscriptionOf(KEYS) });
    await openAlerts(several.client, held.env);
    await waitFor(() => {
      expect(note()).toHaveTextContent(
        'This device is subscribed. 2 devices in all receive Web Push.',
      );
    });
  });

  it('offers to unsubscribe a subscription that the server lost, and does not offer a test for it', async () => {
    const { client } = await liveClient({ publicKey: KEY, devices: 0 });
    const { env } = fakeEnv({ permission: 'granted', subscription: subscriptionOf(KEYS) });
    await openAlerts(client, env);
    await waitFor(() => {
      expect(note()).toHaveTextContent('does not know any more');
    });
    expect(screen.getByTestId('alerts-webpush-unsubscribe')).toBeEnabled();
    expect(screen.getByTestId('alerts-webpush-test')).toBeDisabled();
  });
  it('says that the state could not be read when the server cannot be asked', async () => {
    const { client } = await liveClient({ publicKey: KEY, devices: 0 });
    client.getPushStatus = () => Promise.reject(new Error('down'));
    const { env } = fakeEnv();
    await openAlerts(client, env);
    await waitFor(() => {
      expect(note()).toHaveTextContent('could not be read');
    });
    expect(screen.getByTestId('alerts-webpush-subscribe')).toBeDisabled();
  });
});
