import { expect, test } from '@playwright/test';

import { PRIVATE_ROUTES, fillLogin, logIn } from './helpers';

// Scenario E1 (05_UI_Spec section 9.4).
test.describe('E1 login', () => {
  test('a wrong password shows the generic error and stays on the login screen', async ({
    page,
  }) => {
    await page.goto('/login');
    await fillLogin(page, 'not-the-password');
    const error = page.getByTestId('login-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveText(/Login failed\. Check your details and try again\./);
    await expect(error).not.toContainText(/wrong password|no such user|username is/i);
    await expect(page).toHaveURL(/\/login$/);
  });

  test('the correct login lands on the dashboard and logout returns to /login', async ({
    page,
  }) => {
    await logIn(page);
    await expect(page).toHaveURL(/\/$/);

    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
  });

  for (const { path } of PRIVATE_ROUTES) {
    test(`visiting ${path} without a session redirects to /login`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
    });
  }

  test('after login the visitor returns to the page that was asked for', async ({ page }) => {
    await page.goto('/analytics');
    await expect(page).toHaveURL(/\/login$/);
    await fillLogin(page);
    await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible();
    await expect(page).toHaveURL(/\/analytics$/);
  });

  test('a session survives a reload and ends with logout', async ({ page }) => {
    await logIn(page);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/system');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('there is no sign-up and no forgot-password link', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
    await expect(
      page.getByRole('link', { name: /sign ?up|register|create account|forgot/i }),
    ).toHaveCount(0);
  });

  test('the login page says that the data is simulated', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByTestId('login-preview-hint')).toContainText('simulated');
  });
});
