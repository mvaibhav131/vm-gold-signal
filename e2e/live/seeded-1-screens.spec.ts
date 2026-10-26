import { expect, test } from '@playwright/test';

import {
  bodyText,
  endSessionOnServer,
  expectNoProblems,
  logIn,
  openScreen,
  OWNER,
  SITE,
} from './support';

// The web app on the real API (phase U5b): the world of the live stack is months of signals, a calendar, headlines, incidents and a
// simulated worker (apps/api/src/testing/liveSeed.ts). What is asserted here is what the mock cannot tell: that the screens
// work on what the API really sends.

const SCREENS = [
  ['/', 'Dashboard'],
  ['/signals', 'Signals'],
  ['/analytics', 'Analytics'],
  ['/news', 'News'],
  ['/news?tab=headlines', 'News'],
  ['/news?tab=moves', 'News'],
  ['/system', 'System'],
  ['/system?tab=storage', 'System'],
  ['/system?tab=strategies', 'System'],
  ['/system?tab=alerts', 'System'],
  ['/system?tab=display', 'System'],
  ['/system?tab=security', 'System'],
] as const;

test.describe('the session', () => {
  test('refuses a wrong password with one generic message, then lets the owner in and out', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByLabel(/^username/i).fill(OWNER.username);
    await page.getByLabel(/^password/i).fill('not the password');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByTestId('login-error')).toHaveText(
      'Login failed. Check your details and try again.',
    );
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel(/^password/i).fill(OWNER.password);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page).toHaveURL(`${SITE}/`);

    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/signals');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('sends the owner to the login when the session ends on the server while a screen is open', async ({
    page,
  }) => {
    await logIn(page);
    await expect(page.getByTestId('open-signals')).toBeVisible();

    await endSessionOnServer(page);
    // the next request of the page that is refused moves it to the login: it does not stay on "Retrying" for ever
    await expect(page).toHaveURL(/\/login$/, { timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();

    await page.getByLabel(/^username/i).fill(OWNER.username);
    await page.getByLabel(/^password/i).fill(OWNER.password);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page.getByTestId('open-signals')).toBeVisible();
    expect(await bodyText(page)).not.toMatch(/Could not load|Retrying/);
  });
});

test.describe('every screen', () => {
  test('loads on the real API without an error of any kind, and none says that it could not load', async ({
    page,
  }) => {
    const problems = await logIn(page);
    for (const [path, heading] of SCREENS) {
      await test.step(path, async () => {
        await openScreen(page, path, heading);
        await expect(page.locator('.mantine-Skeleton-root')).toHaveCount(0);
        await expect(page.getByRole('alert')).toHaveCount(0);
        expect(await bodyText(page)).not.toMatch(/Could not load|Retrying/);
      });
    }
    expectNoProblems(problems);
  });

  test('the layout of the screen has the status bar with a live price, the engine and a fresh feed', async ({
    page,
  }) => {
    await logIn(page);
    await expect(page.getByTestId('status-price')).toContainText(/40\d\d\.\d{3}/);
    await expect(page.getByTestId('status-engine')).toHaveText('RUNNING');
    await expect(page.locator('body')).toContainText(/FEED\s+FRESH/, { useInnerText: true });
  });
});

test.describe('the dashboard', () => {
  test('shows the two open signals, the chart with its legend and levels, and the recent signals', async ({
    page,
  }) => {
    const problems = await logIn(page);
    const open = page.getByTestId('open-signals');
    await expect(open.getByTestId('signal-card-39')).toBeVisible();
    await expect(open.getByTestId('signal-card-40')).toBeVisible();
    await expect(open.getByTestId('signal-card-39').getByTestId('signal-state')).toHaveText(
      'ACTIVE',
    );
    await expect(open.getByTestId('signal-card-40').getByTestId('signal-state')).toHaveText(
      'TP1 HIT',
    );

    const chart = page.getByTestId('chart-panel');
    await expect(chart.getByTestId('price-chart').locator('canvas').first()).toBeVisible();
    await expect(chart.getByTestId('chart-legend')).toContainText(/EMA 20 \d{4}\.\d{3}/);
    await expect(chart.getByTestId('chart-levels')).toContainText(/PDH|Previous day high/);
    await expect(chart.getByTestId('chart-empty')).toHaveCount(0);

    await expect(page.getByTestId('recent-signals')).toContainText('S-0038');
    expectNoProblems(problems);
  });

  test('pauses the engine through its dialog and resumes it, and the status bar follows', async ({
    page,
  }) => {
    const problems = await logIn(page);
    await page.getByTestId('pause-button').click();
    await page
      .getByRole('dialog', { name: 'Pause the engine?' })
      .getByTestId('pause-confirm')
      .click();
    await expect(page.getByTestId('status-engine')).toHaveText('PAUSED');
    await expect(page.getByTestId('paused-card')).toBeVisible();

    await page
      .getByTestId('paused-card')
      .getByRole('button', { name: /resume/i })
      .click();
    await expect(page.getByTestId('status-engine')).toHaveText('RUNNING');
    await expect(page.getByTestId('paused-card')).toHaveCount(0);
    expectNoProblems(problems);
  });
});

test.describe('the signal history', () => {
  test('counts the signals, filters by result, and loads more pages until all are shown', async ({
    page,
  }) => {
    const problems = await logIn(page);
    await openScreen(page, '/signals', 'Signals');
    await expect(page.getByTestId('history-count')).toHaveText('Showing 20 of 40 signals');
    await expect(page.getByTestId('history-summary')).toContainText('Properly tracked');
    await expect(page.getByTestId(/^history-row-/)).toHaveCount(20);

    await page.getByTestId('history-load-more').click();
    await expect(page.getByTestId('history-count')).toHaveText('Showing 40 of 40 signals');
    await expect(page.getByTestId(/^history-row-/)).toHaveCount(40);
    await expect(page.getByTestId('history-load-more')).toHaveCount(0);

    await openScreen(page, '/signals?result=LOSS', 'Signals');
    await expect(page.getByTestId('history-count')).toHaveText('Showing 14 of 14 signals');
    await page.getByTestId('history-filter-reset').click();
    await expect(page.getByTestId('history-count')).toHaveText('Showing 20 of 40 signals');
    expectNoProblems(problems);
  });
});

test.describe('the signal detail', () => {
  test('shows a closed signal with its result, its review and the snapshot of the moment it was made', async ({
    page,
  }) => {
    const problems = await logIn(page);
    await openScreen(page, '/signals?result=LOSS', 'Signals');
    await page.getByTestId('history-row-37').getByRole('link', { name: 'S-0037' }).click();
    const detail = page.getByTestId('page-signal-detail');
    await expect(detail).toContainText('S-0037');
    await expect(detail).toContainText(/Result\s+LOSS/, { useInnerText: true });
    await expect(detail).toContainText('Exit reason');
    await expect(detail).toContainText('Review (preliminary)');
    await expect(detail).toContainText('Why this signal');
    await expect(detail.locator('canvas').first()).toBeVisible();
    expectNoProblems(problems);
  });

  test('shows an open signal as working state, with no result yet', async ({ page }) => {
    const problems = await logIn(page);
    await openScreen(page, '/signals', 'Signals');
    await page.getByTestId('history-row-39').getByRole('link', { name: 'S-0039' }).click();
    const detail = page.getByTestId('page-signal-detail');
    await expect(detail).toContainText('No result yet');
    await expect(detail).toContainText('Current stop');
    expectNoProblems(problems);
  });

  test('says "Signal not found" for an id that does not exist, and goes back to the list', async ({
    page,
  }) => {
    await logIn(page);
    await page.goto('/signals/0b2f6f5e-7a3c-4c64-9a38-2a4a3f1d9e99');
    await expect(page.getByText('Signal not found')).toBeVisible();
    await page.getByRole('link', { name: 'Back to signals' }).first().click();
    await expect(page.getByRole('heading', { name: 'Signals', level: 1 })).toBeVisible();
  });
});

test.describe('the analytics', () => {
  test('measures the forward signals, and says plainly that the backtest scope has nothing yet', async ({
    page,
  }) => {
    const problems = await logIn(page);
    await openScreen(page, '/analytics', 'Analytics');
    const forward = page.getByTestId('page-analytics');
    await expect(forward).toContainText(/Signals generated\s+40\b/, { useInnerText: true });
    await expect(forward).toContainText(/Properly tracked\s+34\b/, { useInnerText: true });
    await expect(forward).toContainText(/Net R\s+\+5\.78R/, { useInnerText: true });
    await expect(forward).toContainText('Where it works and where it does not');
    await expect(forward).toContainText('Why signals failed');

    await openScreen(page, '/analytics?scope=BACKTEST_OOS', 'Analytics');
    await expect(page.getByTestId('page-analytics')).toContainText(/Signals generated\s+0\b/, {
      useInnerText: true,
    });
    await expect(page.getByTestId('page-analytics')).toContainText('No signals in this scope yet.');
    expectNoProblems(problems);
  });
});

test.describe('the news', () => {
  test('lists the upcoming and released events of the calendar, the headlines and the moves of gold', async ({
    page,
  }) => {
    const problems = await logIn(page);
    await openScreen(page, '/news', 'News');
    await expect(page.getByTestId('news-state')).toBeVisible();
    await expect(page.getByTestId('news-upcoming')).toBeVisible();
    await expect(page.getByTestId('news-past')).toBeVisible();
    await expect(page.getByTestId('calendar-fetch-age')).toContainText('Calendar last fetched');

    await openScreen(page, '/news?tab=headlines', 'News');
    await expect(page.getByTestId('news-headlines')).toBeVisible();
    await expect(page.getByTestId(/^headline-/).first()).toBeVisible();

    await openScreen(page, '/news?tab=moves', 'News');
    await expect(page.getByRole('tab', { name: 'Market moves', selected: true })).toBeVisible();
    expectNoProblems(problems);
  });
});

test.describe('the system', () => {
  test('lists all five strategies with their status, and the health of the worker', async ({
    page,
  }) => {
    const problems = await logIn(page);
    await openScreen(page, '/system?tab=strategies', 'System');
    for (const key of [
      'trend_pullback',
      'sweep_reversal',
      'squeeze_retest',
      'trendline_retest',
      'pattern_breakout',
    ]) {
      await expect(page.getByTestId(`strategy-row-${key}`)).toBeVisible();
    }
    await expect(page.getByTestId('strategies-empty')).toHaveCount(0);

    await openScreen(page, '/system', 'System');
    const text = page.locator('main');
    await expect(text).toContainText('Heartbeat');
    await expect(text).toContainText('Reachable');
    await expect(text).toContainText('Feed incidents');

    await openScreen(page, '/system?tab=storage', 'System');
    await expect(page.locator('main')).toContainText('Database size');
    await expect(page.getByTestId('storage-table-ticks')).toBeVisible();
    expectNoProblems(problems);
  });
});
