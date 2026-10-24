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

    test('the history with a filter, with every page loaded, with a menu open and with no match has none', async ({
      page,
    }) => {
      await logIn(page);
      await page.goto('/signals');
      await expect(page.getByTestId('history-row-43')).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
      // every page loaded
      await page.getByTestId('history-load-more').click();
      await expect(page.getByTestId(/^history-row-/)).toHaveCount(40);
      await page.getByTestId('history-load-more').click();
      await expect(page.getByTestId(/^history-row-/)).toHaveCount(43);
      expect(await seriousViolations(page)).toEqual([]);
      // a filter, and a menu that is open
      await page.goto('/signals?result=LOSS&sort=durationS&order=asc');
      await expect(page.getByTestId('history-row-34')).toBeVisible();
      const fold = page.getByRole('button', { name: /^Filters/ });
      if (await fold.isVisible()) await fold.click();
      await page.getByRole('combobox', { name: 'Failure cause' }).click();
      await expect(page.getByRole('option', { name: 'News shock', exact: true })).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
      await page.keyboard.press('Escape');
      // nothing matches
      await page.goto('/signals?strategy=pattern_breakout');
      await expect(page.getByText('No signals match these filters.')).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
      // an end date before the start date
      await page.goto('/signals?from=2026-10-20&to=2026-10-10');
      await expect(page.getByTestId('history-table')).toBeVisible();
      const folded = page.getByRole('button', { name: /^Filters/ });
      if (await folded.isVisible()) await folded.click();
      await expect(page.getByText('The end date is before the start date')).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
    });

    for (const seq of [40, 41, 42, 39, 11, 29, 1]) {
      test(`the detail of signal ${String(seq)} (every kind of result), with its chart and snapshot opened, has none`, async ({
        page,
      }) => {
        await logIn(page);
        await page.goto(`/signals/00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`);
        await expect(page.getByTestId('detail-header')).toBeVisible();
        const chart = page.getByRole('button', { name: 'Chart around the trade' });
        if (await chart.isVisible()) await chart.click();
        await expect(page.getByTestId('detail-chart').locator('canvas').first()).toBeVisible();
        const snapshot = page.getByTestId('detail-snapshot').getByRole('button');
        if ((await snapshot.count()) > 0) {
          await snapshot.click();
          await expect(page.getByTestId('detail-snapshot-json')).toBeVisible();
        }
        expect(await seriousViolations(page)).toEqual([]);
      });
    }

    test('the detail of a loss whose review is still preliminary has none', async ({ page }) => {
      await logIn(page, { scenario: 'review-pending' });
      await page.getByTestId('recent-row-42').getByRole('link', { name: 'S-0042' }).click();
      await expect(page.getByTestId('detail-autopsy-status')).toHaveText('PRELIMINARY');
      expect(await seriousViolations(page)).toEqual([]);
    });

    test('the detail of a signal that does not exist has none', async ({ page }) => {
      await logIn(page);
      await page.goto('/signals/00000000-0000-4000-8000-ffffffffffff');
      await expect(page.getByTestId('detail-not-found')).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
    });
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
