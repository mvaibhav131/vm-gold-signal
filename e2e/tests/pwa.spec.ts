import { expect, test } from '@playwright/test';

import { expectInstallable, expectWorkerThatCachesNothing } from '../pwa-checks';
import { logIn } from './helpers';

// Scenario E17 (05_UI_Spec section 9.4): the manifest is there and valid, the service worker registers, and no answer of the API
// is cached. The preview is a production build, so it registers the worker like the real site does. The DOM and the headers are
// read; no image is taken.

test.describe('E17 PWA', () => {
  test('the manifest is valid, its icons are real images of the sizes they claim, and the page points at them', async ({
    page,
  }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
    await expectInstallable(page);
  });

  test('the service worker registers for the whole site, is active, and caches nothing', async ({
    page,
  }) => {
    await logIn(page);
    await expectWorkerThatCachesNothing(page);
    // after a few screens (and their answers) there is still no cache
    for (const name of ['Signals', 'Analytics', 'News', 'System']) {
      await page.getByRole('link', { name, exact: true }).first().click();
      await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    }
    expect(await page.evaluate(() => caches.keys())).toEqual([]);
  });

  test('the Web Push section of the preview says that it needs the live app', async ({ page }) => {
    await logIn(page);
    await page.goto('/system?tab=alerts');
    await expect(page.getByTestId('alerts-webpush-note')).toContainText(
      'does not work in the preview',
    );
    await expect(page.getByTestId('alerts-webpush-subscribe')).toBeDisabled();
  });
});
