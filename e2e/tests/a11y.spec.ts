import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { PRIVATE_ROUTES, logIn } from './helpers';

// Scenario E16: zero serious or critical axe violations on every route, in the dark and in the
// light theme. Axe reads the DOM, no image is taken.
async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      (violation) =>
        `${violation.id} (${String(violation.impact)}): ${violation.help} -> ${violation.nodes
          .slice(0, 3)
          .map((node) => node.target.join(' '))
          .join(' | ')}`,
    );
}

for (const scheme of ['dark', 'light'] as const) {
  test.describe(`E16 accessibility, ${scheme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => {
        window.localStorage.setItem('mantine-color-scheme-value', value);
      }, scheme);
    });

    test('the login screen has no serious or critical violations', async ({ page }) => {
      await page.goto('/login');
      await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', scheme);
      expect(await seriousViolations(page)).toEqual([]);
    });

    test('the login screen with an error has none either', async ({ page }) => {
      await page.goto('/login');
      await page.getByLabel(/^username/i).fill('owner');
      await page.getByLabel(/^password/i).fill('wrong');
      await page.getByRole('button', { name: 'Log in' }).click();
      await expect(page.getByTestId('login-error')).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
    });

    for (const { path, heading } of PRIVATE_ROUTES) {
      test(`${path} has no serious or critical violations`, async ({ page }) => {
        await logIn(page);
        await page.goto(path);
        await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
        await expect(page.getByTestId('status-mode')).toHaveText('SIMULATED');
        await expect(page.getByTestId('status-freshness')).toHaveText(/^FRESH/);
        await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', scheme);
        expect(await seriousViolations(page)).toEqual([]);
      });
    }
  });
}

test.describe('landmarks and headings', () => {
  test('every screen has exactly one level-1 heading and one main landmark', async ({ page }) => {
    await logIn(page);
    for (const { path, heading } of PRIVATE_ROUTES) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.getByRole('main')).toHaveCount(1);
    }
  });
});
