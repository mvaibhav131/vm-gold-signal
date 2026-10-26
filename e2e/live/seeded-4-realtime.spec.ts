import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { SITE, control, expectNoProblems, logIn } from './support';

// What happens while a page is open, on the real API and the real stream (phase U5c): the worker is simulated and a test
// moves it (apps/api/src/testing/liveControl.ts), so every change that the page shows has come through Postgres, the
// publisher, the event stream and the proxy, not from a mock. These scenarios change the stack (a signal is made, the feed
// stops for a while), so they run after the ones that only read.

const seq = (value: unknown): number => {
  if (
    typeof value === 'object' &&
    value !== null &&
    'seq' in value &&
    typeof value.seq === 'number'
  ) {
    return value.seq;
  }
  throw new Error('the control did not answer with the number of the signal');
};

const idOf = (value: unknown): string => {
  if (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string'
  ) {
    return value.id;
  }
  throw new Error('the control did not answer with the id of the signal');
};

const card = (page: Page, number: number) =>
  page.getByTestId('open-signals').getByTestId(`signal-card-${String(number)}`);

test.afterEach(async ({ request }) => {
  await control(request, '/worker/on');
  await control(request, '/ticks/on');
});

test.describe('signals', () => {
  test('a new signal appears without a reload, moves to TP1, and leaves the open list when it closes', async ({
    page,
    request,
  }) => {
    const problems = await logIn(page);
    await expect(page.getByTestId('open-signals')).toBeVisible();
    const open = await page.getByTestId(/^signal-card-/).count();

    const made = await control(request, '/signal/new?side=SELL&strategy=squeeze_retest');
    const number = seq(made);
    await expect(card(page, number)).toBeVisible({ timeout: 20_000 });
    await expect(card(page, number).getByTestId('signal-side')).toHaveText('SELL');
    await expect(card(page, number).getByTestId('signal-state')).toHaveText('ACTIVE');
    await expect(page.getByTestId(/^signal-card-/)).toHaveCount(open + 1);
    await expect(page.getByTestId('recent-signals')).toContainText(
      `S-${String(number).padStart(4, '0')}`,
    );

    await control(request, `/signal/${idOf(made)}/tp1`);
    await expect(card(page, number).getByTestId('signal-state')).toHaveText('TP1 HIT', {
      timeout: 20_000,
    });
    await expect(card(page, number).getByTestId('signal-stop')).toHaveText('4017.370');

    await control(request, `/signal/${idOf(made)}/win`);
    await expect(card(page, number)).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId(/^signal-card-/)).toHaveCount(open);
    await expect(
      page.getByTestId('recent-signals').getByText(`S-${String(number).padStart(4, '0')}`),
    ).toBeVisible();

    // the history reads the same signal from the database
    await page.goto('/signals');
    await expect(page.getByTestId(`history-row-${String(number)}`)).toContainText('Win');
    expectNoProblems(problems);
  });
});

test.describe('the engine', () => {
  test('a pause made in another browser shows here without a reload, and so does the resume', async ({
    page,
    browser,
  }) => {
    const problems = await logIn(page);
    await expect(page.getByTestId('status-engine')).toHaveText('RUNNING');

    const context = await browser.newContext({ baseURL: SITE });
    try {
      const other = await context.newPage();
      await logIn(other);
      await other.getByTestId('pause-button').click();
      await other
        .getByRole('dialog', { name: 'Pause the engine?' })
        .getByTestId('pause-confirm')
        .click();
      await expect(other.getByTestId('paused-card')).toBeVisible();

      await expect(page.getByTestId('status-engine')).toHaveText('PAUSED', { timeout: 20_000 });
      await expect(page.getByTestId('paused-card')).toBeVisible();

      await other.getByTestId('resume-button').click();
      await expect(page.getByTestId('status-engine')).toHaveText('RUNNING', { timeout: 20_000 });
      await expect(page.getByTestId('paused-card')).toHaveCount(0);
    } finally {
      await context.close();
    }
    expectNoProblems(problems);
  });
});

async function feedBanner(page: Page, text: string): Promise<void> {
  const banner = page.getByTestId('feed-banner');
  await expect(banner).toBeVisible({ timeout: 60_000 });
  await expect(banner).toHaveAttribute('role', 'alert');
  // a worker that is gone shows as a stale feed first (15 s), and as disconnected when 45 s have passed
  await expect(banner).toContainText(text, { timeout: 60_000 });
}

async function goesAway(page: Page, request: APIRequestContext, resume: string): Promise<void> {
  await control(request, resume);
  await expect(page.getByTestId('feed-banner')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('status-freshness')).toHaveText(/^FRESH/, { timeout: 30_000 });
  await expect(page.getByTestId('status-engine')).toHaveText('RUNNING');
  await expect(card(page, 39).getByTestId('signal-state')).toHaveText('ACTIVE');
}

test.describe('the feed', () => {
  test('a feed that goes quiet is a red banner on every screen, blocks the engine, and goes away when ticks come back', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    await logIn(page);
    await expect(page.getByTestId('status-freshness')).toHaveText(/^FRESH/);

    await control(request, '/ticks/off');
    await feedBanner(page, 'DATA STALE');
    await expect(page.getByTestId('status-freshness')).toHaveText('STALE');
    await expect(page.getByTestId('status-engine')).toHaveText('BLOCKED: NO DATA');
    await expect(card(page, 39).getByTestId('signal-state')).toHaveText('DATA_STALE');

    // the banner is on every private screen, not only on the dashboard
    await page.getByRole('link', { name: 'News', exact: true }).first().click();
    await expect(page.getByTestId('feed-banner')).toBeVisible();
    await page.getByRole('link', { name: 'Dashboard', exact: true }).first().click();

    await goesAway(page, request, '/ticks/on');
  });

  test('a worker that is gone is a disconnected feed with its own banner, and it recovers when the worker is back', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    await logIn(page);
    await expect(page.getByTestId('status-freshness')).toHaveText(/^FRESH/);

    await control(request, '/worker/off');
    await feedBanner(page, 'FEED DISCONNECTED');
    await expect(page.getByTestId('status-freshness')).toHaveText('DISCONNECTED');
    await expect(card(page, 39).getByTestId('signal-state')).toHaveText('DISCONNECTED');

    await goesAway(page, request, '/worker/on');
  });
});
