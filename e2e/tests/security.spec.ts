import { expect, test } from '@playwright/test';

import { fillLogin, logIn } from './helpers';

// Scenario E14, the part that can be checked on the simulated session (05_UI_Spec section 9.4):
// there is no registration route and a session that ended no longer opens a private page. The
// cookie flags and the `no-store` header are properties of the real API and its reverse proxy,
// so they are checked on the real stack (U5), not here.

test.describe('E14 security on the simulated session', () => {
  for (const path of ['/register', '/signup', '/sign-up', '/forgot-password', '/reset-password']) {
    test(`${path} is not a registration or recovery page`, async ({ page }) => {
      // without a session every route that is not the login leads to the login
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();

      // after the login the visitor comes back to the page that was asked for: it does not
      // exist, and there is no form to create or recover an account
      await fillLogin(page);
      await expect(page.getByRole('heading', { name: 'Page not found', level: 1 })).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole('textbox')).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: /sign ?up|register|create|reset/i }),
      ).toHaveCount(0);
    });
  }

  test('after logout the back button does not bring a private page back, and the session is gone', async ({
    page,
  }) => {
    await logIn(page);
    await page.getByRole('link', { name: 'System', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'System', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(
      await page.evaluate(() => window.sessionStorage.getItem('vmgs-mock-session')),
    ).toBeNull();

    await page.goBack();
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'System', level: 1 })).toHaveCount(0);
    await expect(page.getByTestId('health-summary')).toHaveCount(0);
  });

  test('a session that has ended does not open a private page', async ({ page }) => {
    // the current session has no Revoke button (ending it is Log out); here it ends by expiry
    await logIn(page);
    await page.goto('/system?tab=security');
    await expect(page.getByTestId('session-sess-current')).toContainText('This device');
    await expect(page.getByTestId('session-sess-current').getByRole('button')).toHaveCount(0);
    await page.evaluate(() => {
      window.sessionStorage.removeItem('vmgs-mock-session');
    });
    await page.reload();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
  });
});
