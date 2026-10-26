import { expect, test, type Page } from '@playwright/test';

import { control, expectNoProblems, logIn } from './support';

// Web Push on the real API (phase U6). The browser's push service cannot be reached from a test, so the page is given a push
// manager and a permission of its own (a few lines run before the app): everything else is real, the service worker of the
// built app, the section of the Alerts tab, the key the API hands out, the subscription it stores and the message it queues.
// What a push service does with that message, and what the phone does with it, is the manual test on a device (deploy/README.md).

const SUBSCRIPTION_STUB = `
(() => {
  const KEYS = {
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  };
  const held = () =>
    window.localStorage.getItem('e2e-push-device') === '1'
      ? {
          endpoint: 'https://push.example.org/send/e2e-device',
          toJSON() { return { endpoint: this.endpoint, keys: KEYS }; },
          unsubscribe() { window.localStorage.removeItem('e2e-push-device'); return Promise.resolve(true); },
        }
      : null;
  PushManager.prototype.getSubscription = () => Promise.resolve(held());
  PushManager.prototype.subscribe = (options) => {
    window.localStorage.setItem('e2e-push-device', '1');
    window.localStorage.setItem('e2e-push-key-bytes', String(options.applicationServerKey.byteLength));
    return Promise.resolve(held());
  };
  Object.defineProperty(Notification, 'permission', {
    get: () => window.localStorage.getItem('e2e-push-permission') ?? 'default',
  });
  Notification.requestPermission = () => {
    window.localStorage.setItem('e2e-push-permission', 'granted');
    return Promise.resolve('granted');
  };
})();
`;

async function openAlerts(page: Page): Promise<void> {
  await page.goto('/system?tab=alerts');
  await expect(page.getByRole('heading', { name: 'System', level: 1 })).toBeVisible();
}

test.describe('Web Push', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(SUBSCRIPTION_STUB);
  });

  test('subscribes this device with the key of the server, queues a test for it, and unsubscribes', async ({
    page,
    request,
  }) => {
    const problems = await logIn(page);
    await openAlerts(page);
    const note = page.getByTestId('alerts-webpush-note');
    await expect(note).toContainText('No device is subscribed.');
    await expect(page.getByTestId('alerts-webpush-test')).toBeDisabled();

    // nothing can be sent before a device is subscribed: the API says so instead of queueing a message nobody can get
    const refused = await page.request.post('/api/v1/notifications/test', {
      data: { channel: 'webpush' },
      headers: { origin: 'http://127.0.0.1:4174', 'x-vmgs-csrf': '1' },
    });
    expect(refused.status()).toBe(409);

    await page.getByTestId('alerts-webpush-subscribe').click();
    await expect(note).toContainText('This device is subscribed. 1 device in all');
    // the page gave the browser the 65 bytes of the key that the server handed out
    expect(await page.evaluate(() => window.localStorage.getItem('e2e-push-key-bytes'))).toBe('65');

    await page.reload();
    await expect(page.getByTestId('alerts-webpush-note')).toContainText(
      'This device is subscribed. 1 device in all',
    );
    await expect(page.getByTestId('alerts-webpush-unsubscribe')).toBeVisible();

    await page.getByTestId('alerts-webpush-test').click();
    await expect(page.getByTestId('alerts-webpush-result')).toContainText(
      /^Test notification queued \(test:[0-9a-f-]{36}\)\./,
    );
    // what the API queued for the worker: a test message for Web Push, in the form the service worker shows
    expect(await control(request, '/outbox/last')).toMatchObject({
      channel: 'webpush',
      kind: 'TEST',
      payload: { title: 'TEST', url: '/' },
    });

    await page.getByTestId('alerts-webpush-unsubscribe').click();
    await expect(page.getByTestId('alerts-webpush-note')).toContainText('No device is subscribed.');
    await expect(page.getByTestId('alerts-webpush-test')).toBeDisabled();
    await page.reload();
    await expect(page.getByTestId('alerts-webpush-note')).toContainText('No device is subscribed.');
    // the 409 of the first look is the only refused request of this scenario
    expectNoProblems(problems.filter((line) => !line.includes('409')));
  });

  test('the service worker of the built app is running, so that a device can subscribe at all', async ({
    page,
  }) => {
    await logIn(page);
    const worker = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.active?.scriptURL ?? null;
    });
    expect(worker).toBe('http://127.0.0.1:4174/sw.js');
  });
});
