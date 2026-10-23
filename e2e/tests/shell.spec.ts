import { expect, test } from '@playwright/test';

import { PRIVATE_ROUTES, logIn } from './helpers';

// Scenario E2: the status bar is on every private screen, every value is text.
test.describe('E2 status bar', () => {
  test('shows price, spread, feed, session, regime, engine, mode and strategy status', async ({
    page,
  }) => {
    await logIn(page);
    const bar = page.getByRole('region', { name: 'Market status' });
    await expect(bar.getByTestId('status-price')).toHaveText(
      /^\d{4}\.\d{2} \(bid \d{4}\.\d{2} \/ ask \d{4}\.\d{2}\)$/,
    );
    await expect(bar.getByTestId('status-spread')).toHaveText(/^\d\.\d{2}$/);
    await expect(bar.getByTestId('status-freshness')).toHaveText(/^FRESH \d\.\d s$/);
    await expect(bar.getByTestId('status-session')).toHaveText('LONDON');
    await expect(bar.getByTestId('status-regime')).toHaveText('TREND UP');
    await expect(bar.getByTestId('status-engine')).toHaveText('RUNNING');
    await expect(bar.getByTestId('status-mode')).toHaveText('SIMULATED');
    await expect(bar.getByTestId('status-strategy')).toHaveText('FORWARD-TEST');
  });

  test('the price keeps moving (the quote stream is alive)', async ({ page }) => {
    await logIn(page);
    const price = page.getByTestId('status-price');
    const first = await price.textContent();
    await expect(price).not.toHaveText(first ?? '', { timeout: 10_000 });
  });

  test('the SIMULATED badge stays on every private screen', async ({ page }) => {
    await logIn(page);
    for (const { path, heading } of PRIVATE_ROUTES) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      await expect(page.getByTestId('status-mode')).toHaveText('SIMULATED');
    }
  });
});

test.describe('navigation', () => {
  test('opens every main screen and marks the current one', async ({ page }) => {
    await logIn(page);
    for (const name of ['Signals', 'Analytics', 'News', 'System', 'Dashboard']) {
      await page.getByRole('link', { name, exact: true }).click();
      await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
      await expect(page.getByRole('link', { name, exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(page).toHaveTitle(new RegExp(`^${name} · VM Gold Signal$`));
    }
  });

  test('shows a not-found page inside the frame', async ({ page }) => {
    await logIn(page);
    await page.goto('/this-page-does-not-exist');
    await expect(page.getByRole('heading', { name: 'Page not found', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Market status' })).toBeVisible();
  });

  test('a keyboard user can skip to the content', async ({ page }) => {
    await logIn(page);
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#page$/);
  });
});

// Scenario E15, the part that exists in U0: the frame adapts to the screen.
test.describe('E15 responsive frame', () => {
  test('uses the navigation rail on desktop and the bottom tab bar on a phone', async ({
    page,
  }, testInfo) => {
    await logIn(page);
    const rail = page.getByRole('navigation', { name: 'Main navigation', exact: true });
    const tabs = page.getByRole('navigation', { name: 'Main navigation, bottom tabs' });
    if (testInfo.project.name === 'mobile') {
      await expect(tabs).toBeVisible();
      await expect(rail).toBeHidden();
      for (const name of ['Dashboard', 'Signals', 'Analytics', 'News', 'System']) {
        await expect(tabs.getByRole('link', { name, exact: true })).toBeVisible();
      }
    } else {
      await expect(rail).toBeVisible();
      await expect(tabs).toBeHidden();
    }
  });

  test('never scrolls sideways', async ({ page }) => {
    await logIn(page);
    for (const { path, heading } of PRIVATE_ROUTES) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
    }
  });

  test('the login screen does not scroll sideways either', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
