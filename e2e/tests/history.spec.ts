import { expect, test, type Page } from '@playwright/test';

import { logIn } from './helpers';

// Scenario E7 on the simulated history (05_UI_Spec section 9.4): filters, sorting, pagination and
// the way into a signal. Every check reads the DOM; no image is taken. On a phone the filters sit
// in a folded panel, so each test opens it first.

const rows = (page: Page) => page.getByTestId(/^history-row-/);
const rowNumbers = async (page: Page) =>
  (await rows(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))).map(
    (id) => Number(id?.replace('history-row-', '')),
  );

async function openHistory(page: Page, query = ''): Promise<void> {
  await logIn(page);
  await page.goto(`/signals${query}`);
  await expect(page.getByRole('heading', { name: 'Signals', level: 1 })).toBeVisible();
  await expect(page.getByTestId('history-table')).toBeVisible();
  await expect(rows(page).first()).toBeVisible();
}

/** On a phone the filters are folded away; open them. */
async function openFilters(page: Page): Promise<void> {
  const fold = page.getByRole('button', { name: /^Filters/ });
  if (await fold.isVisible()) {
    if ((await fold.getAttribute('aria-expanded')) !== 'true') await fold.click();
  }
}

async function choose(page: Page, label: string, option: string): Promise<void> {
  await openFilters(page);
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test.describe('E7 signal history', () => {
  test('opens from the navigation with the summary of the whole list and the newest signals first', async ({
    page,
  }) => {
    await logIn(page);
    await page.getByRole('link', { name: 'Signals', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Signals', level: 1 })).toBeVisible();
    await expect(page.getByTestId('history-table')).toBeVisible();
    expect((await rowNumbers(page)).slice(0, 5)).toEqual([43, 42, 41, 40, 39]);

    const summary = page.getByTestId('history-summary');
    await expect(summary.getByTestId('summary-signals')).toHaveText('43');
    await expect(summary.getByTestId('summary-valid')).toHaveText('39');
    // 39 valid results: a win rate with its interval and the low-sample label
    await expect(summary.getByTestId('summary-win-rate')).toContainText(/^54% \(95% CI \d+–\d+%\)/);
    await expect(summary.getByTestId('summary-win-rate')).toContainText('Low sample');
    await expect(page.getByTestId('history-count')).toHaveText('Showing 20 of 43 signals');
  });

  test('shows levels, result, net R, duration, cause with its category and the evidence of a row', async ({
    page,
  }) => {
    await openHistory(page);
    const loss = page.getByTestId('history-row-40');
    await expect(loss).toContainText('Loss');
    await expect(loss).toContainText('-1.04R');
    await expect(loss).toContainText('15 min');
    await expect(loss).toContainText('No follow-through');
    await expect(loss).toContainText('Setup failure');
    await expect(loss).toContainText('4021.600');
    await expect(loss).toContainText(/n=\d+ \(insufficient\)/);
    await expect(page.getByTestId('history-row-43')).toContainText('Open');
  });

  test('a filter by result narrows the rows and the summary, and is in the address bar', async ({
    page,
  }) => {
    await openHistory(page);
    await choose(page, 'Result', 'Loss');
    await expect(page.getByTestId('summary-signals')).toHaveText('15');
    await expect(rows(page)).toHaveCount(15);
    await expect(page.getByTestId('history-row-41')).toHaveCount(0);
    expect(new URL(page.url()).search).toBe('?result=LOSS');
    // 15 valid results: counts only
    await expect(page.getByTestId('summary-win-rate')).toHaveText(
      'Insufficient evidence (15 results)',
    );
    // the filtered list survives a reload (it is in the address bar)
    await page.reload();
    await expect(page.getByTestId('summary-signals')).toHaveText('15');
    await openFilters(page);
    await expect(page.getByRole('combobox', { name: 'Result' })).toHaveValue('Loss');
  });

  test('filters by strategy and by failure cause, and clears them again', async ({ page }) => {
    await openHistory(page);
    await choose(page, 'Failure cause', 'News shock');
    await expect(rows(page)).toHaveCount(2);
    expect((await rowNumbers(page)).sort((a, b) => a - b)).toEqual([10, 34]);
    await choose(page, 'Strategy', 'Trend Pullback');
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByTestId('history-row-10')).toBeVisible();
    await openFilters(page);
    await page.getByTestId('history-filter-reset').click();
    await expect(page.getByTestId('summary-signals')).toHaveText('43');
    await expect(page.getByTestId('history-filter-reset')).toBeDisabled();
  });

  test('filters by a range of days of the display time zone', async ({ page }) => {
    await openHistory(page, '?result=WIN&strategy=trend_pullback&side=SELL');
    await expect(rows(page)).toHaveCount(1);
    const stamp = await page.getByTestId('history-row-20').locator('time').getAttribute('datetime');
    const day = new Date(stamp ?? '').toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const next = new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

    await openFilters(page);
    await page.getByLabel('From', { exact: true }).fill(day);
    await page.getByLabel('To', { exact: true }).fill(day);
    await expect(rows(page)).toHaveCount(1);
    // a day later: nothing. The two date fields are filled one right after the other on purpose:
    // both changes must reach the list (an earlier version lost the first one)
    await page.getByLabel('From', { exact: true }).fill(next);
    await page.getByLabel('To', { exact: true }).fill(next);
    await expect(page.getByTestId('summary-signals')).toHaveText('0');
    await expect(page.getByTestId('history-count')).toHaveText('Showing 0 of 0 signals');
    await expect(rows(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`from=${next}&to=${next}`));
    // an end before the start is reported and ignored
    await page.getByLabel('To', { exact: true }).fill('2020-01-01');
    await expect(page.getByText('The end date is before the start date')).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
  });

  test('sorts across all pages by net R and reverses on the second click', async ({ page }) => {
    await openHistory(page);
    const header = page.getByTestId('history-table').getByText('Net R', { exact: true });
    await header.click();
    await expect.poll(async () => (await rowNumbers(page))[0]).toBe(20); // +1.49R, the best win
    expect(new URL(page.url()).search).toBe('?sort=realizedRNet&order=desc');
    await header.click();
    await expect.poll(async () => (await rowNumbers(page))[0]).toBe(34); // -1.15R, the biggest loss
    expect(new URL(page.url()).search).toBe('?sort=realizedRNet&order=asc');
    // signals without a result in R (the two open ones, the cancelled and the data-invalid one) come last
    await page.getByTestId('history-load-more').click();
    await page.getByTestId('history-load-more').click();
    await expect(rows(page)).toHaveCount(43);
    expect((await rowNumbers(page)).slice(-4)).toEqual([43, 42, 29, 11]);
  });

  test('sorts by time, grade and duration too', async ({ page }) => {
    await openHistory(page);
    const table = page.getByTestId('history-table');
    await table.getByText('Time', { exact: true }).click();
    await expect.poll(async () => (await rowNumbers(page))[0]).toBe(1); // the oldest signal first
    await table.getByText('Duration', { exact: true }).click();
    await expect.poll(async () => (await rowNumbers(page))[0]).not.toBe(1);
    expect(new URL(page.url()).search).toContain('sort=durationS');
    await table.getByText('Grade', { exact: true }).click();
    expect(new URL(page.url()).search).toContain('sort=qualityScore');
  });

  test('loads 20 signals at a time with a cursor, every signal once', async ({ page }) => {
    await openHistory(page);
    await expect(rows(page)).toHaveCount(20);
    await page.getByTestId('history-load-more').click();
    await expect(rows(page)).toHaveCount(40);
    await page.getByTestId('history-load-more').click();
    await expect(rows(page)).toHaveCount(43);
    await expect(page.getByTestId('history-load-more')).toHaveCount(0);
    await expect(page.getByTestId('history-count')).toHaveText('Showing 43 of 43 signals');
    const all = await rowNumbers(page);
    expect(new Set(all).size).toBe(43);
  });

  test('a strategy with fewer than 30 valid results shows no percentage anywhere in the summary', async ({
    page,
  }) => {
    await openHistory(page);
    await choose(page, 'Strategy', 'Squeeze Breakout and Retest');
    await expect(page.getByTestId('summary-valid')).toHaveText('4');
    const summary = await page.getByTestId('history-summary').textContent();
    expect(summary).not.toMatch(/%/);
    await expect(page.getByTestId('summary-win-rate')).toHaveText(
      'Insufficient evidence (4 results)',
    );
  });

  test('a row opens its detail page, by the number and by a click on the row', async ({ page }) => {
    await openHistory(page);
    await page.getByTestId('history-row-40').getByRole('link', { name: 'S-0040' }).click();
    await expect(page).toHaveURL(/\/signals\/00000000-0000-4000-8000-000000000028$/);
    await expect(page.getByTestId('detail-id')).toHaveText('S-0040');
    await page.goBack();
    await expect(page.getByTestId('history-row-41')).toBeVisible();
    await page.getByTestId('history-row-41').getByText('Win', { exact: true }).click();
    await expect(page.getByTestId('detail-id')).toHaveText('S-0041');
  });
});
