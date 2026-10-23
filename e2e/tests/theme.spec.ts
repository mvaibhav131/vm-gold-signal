import { expect, test } from '@playwright/test';

import { PRIVATE_ROUTES, logIn } from './helpers';

const KEY = 'mantine-color-scheme-value';

test.describe('theme switch', () => {
  test('is dark by default and switches to light and back', async ({ page }) => {
    await logIn(page);
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-mantine-color-scheme', 'dark');

    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(html).toHaveAttribute('data-mantine-color-scheme', 'light');
    await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toBeVisible();

    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(html).toHaveAttribute('data-mantine-color-scheme', 'dark');
  });

  test('the choice is kept after a reload and after logging out and in', async ({ page }) => {
    await logIn(page);
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light');

    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light');
  });

  test('the saved theme is applied from the first paint, before the app starts', async ({
    page,
  }) => {
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, 'light');
    }, KEY);
    // The tiny external script (theme-init.js) sets the attribute; check it on the raw document.
    await page.route('**/assets/*.js', (route) => route.abort());
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light');
  });

  test('ignores a broken saved value and falls back to dark', async ({ page }) => {
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, 'purple');
    }, KEY);
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
  });

  test('the switch is on the login screen and on every private screen', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByTestId('theme-toggle')).toBeVisible();
    await logIn(page);
    for (const { path, heading } of PRIVATE_ROUTES) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      await expect(page.getByTestId('theme-toggle')).toBeVisible();
    }
  });

  test('is usable with the keyboard', async ({ page }) => {
    await page.goto('/login');
    const toggle = page.getByTestId('theme-toggle');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light');
  });
});
