import { expect, test } from '@playwright/test';

import { deliverPush, expectWorkerThatCachesNothing, shownNotifications } from '../pwa-checks';

// Scenario E17, the push: a message that reaches the service worker is shown as a notification. The headless shell of Chromium
// never grants the permission for notifications; the browser itself, in its new headless mode, does. That cannot be set inside a
// group of tests, so these scenarios have a file of their own.
test.use({ channel: 'chromium', permissions: ['notifications'] });

const SIGNAL = '00000000-0000-4000-8000-000000000029';

test.describe('E17 PWA, a push', () => {
  test('that reaches the worker is shown as a notification, with its tag and the page to open', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'the push is delivered through the protocol of the desktop browser');
    await page.goto('/login');
    await expectWorkerThatCachesNothing(page);
    await deliverPush(page, {
      title: 'BUY XAUUSD #S-0042 (Strong 78)',
      body: 'Entry 4017.37, stop 4010.90, TP1 4023.84, TP2 4030.31',
      url: `/signals/${SIGNAL}`,
      tag: `signal:${SIGNAL}:confirmed`,
    });
    await expect
      .poll(() => shownNotifications(page))
      .toEqual([
        {
          title: 'BUY XAUUSD #S-0042 (Strong 78)',
          body: 'Entry 4017.37, stop 4010.90, TP1 4023.84, TP2 4030.31',
          tag: `signal:${SIGNAL}:confirmed`,
          data: { url: `/signals/${SIGNAL}` },
        },
      ]);

    // a newer message with the same tag replaces the older one: still one notification
    await deliverPush(page, {
      title: 'TP1 hit #S-0042',
      body: 'Stop moved to entry.',
      url: `/signals/${SIGNAL}`,
      tag: `signal:${SIGNAL}:confirmed`,
    });
    await expect
      .poll(async () => (await shownNotifications(page)).map((each) => each.title))
      .toEqual(['TP1 hit #S-0042']);
  });

  test('that cannot be read still shows something, and a page of another site is never the page to open', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'the push is delivered through the protocol of the desktop browser');
    await page.goto('/login');
    await expectWorkerThatCachesNothing(page);
    await deliverPush(page, {
      title: 'Elsewhere',
      body: 'A link to another site',
      url: 'https://evil.example.net/signals/x',
      tag: 'elsewhere',
    });
    await expect
      .poll(() => shownNotifications(page))
      .toEqual([
        {
          title: 'Elsewhere',
          body: 'A link to another site',
          tag: 'elsewhere',
          data: { url: '/' },
        },
      ]);
  });
});
