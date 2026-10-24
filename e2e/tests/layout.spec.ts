import { expect, test, type Locator, type Page } from '@playwright/test';

import { logIn } from './helpers';

// Layout checks on the DOM: boxes are measured, no image is taken (05_UI_Spec section 9.1).
async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (rect === null) throw new Error('element has no box');
  return rect;
}

async function checkStatusBarRows(page: Page) {
  const bar = page.getByRole('region', { name: 'Market status' });
  const priceBox = await box(page.getByTestId('status-price'));
  const sessionBox = await box(page.getByTestId('status-session'));
  const logoutBox = await box(bar.getByRole('button', { name: 'Log out' }));
  const toggleBox = await box(bar.getByTestId('theme-toggle'));

  // Row 1 holds the price, row 2 the chips and the account controls: they share a row.
  expect(sessionBox.y).toBeGreaterThan(priceBox.y + priceBox.height - 4);
  expect(
    Math.abs(logoutBox.y + logoutBox.height / 2 - (sessionBox.y + sessionBox.height / 2)),
  ).toBeLessThan(24);
  expect(Math.abs(toggleBox.y - logoutBox.y)).toBeLessThan(16);
  return box(bar);
}

test.describe('desktop layout', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop only');

  test('the navigation rail is wide enough for its labels and the brand is on one line', async ({
    page,
  }) => {
    await logIn(page);
    const rail = await box(page.locator('.mantine-AppShell-navbar'));
    expect(rail.width).toBeGreaterThanOrEqual(196);
    expect(rail.width).toBeLessThanOrEqual(240);
    const brand = await box(page.locator('.brand').first());
    expect(brand.height).toBeLessThan(30);
    for (const name of ['Dashboard', 'Signals', 'Analytics', 'News', 'System']) {
      const link = await box(page.getByRole('link', { name, exact: true }));
      expect(link.width).toBeGreaterThan(rail.width - 40);
      expect(link.height).toBeLessThan(52);
    }
  });

  test('the status bar is two tidy rows and Log out stays with the chips', async ({ page }) => {
    await logIn(page);
    const bar = await checkStatusBarRows(page);
    expect(bar.height).toBeLessThan(135);
  });

  test('stays tidy on a 1362 x 768 window and on a 1100 x 800 window', async ({ page }) => {
    await logIn(page);
    for (const size of [
      { width: 1362, height: 768 },
      { width: 1100, height: 800 },
    ]) {
      await page.setViewportSize(size);
      const bar = await checkStatusBarRows(page);
      expect(bar.height).toBeLessThan(135);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    }
  });

  test('the content keeps a readable width on a very wide screen', async ({ page }) => {
    await logIn(page);
    await page.setViewportSize({ width: 2200, height: 1000 });
    const content = await box(page.locator('#page'));
    expect(content.width).toBeLessThanOrEqual(1400);
  });

  test('the status bar stays on top while the page scrolls', async ({ page }) => {
    await logIn(page);
    await page.setViewportSize({ width: 1440, height: 300 });
    await page.evaluate(() => {
      const content = document.querySelector<HTMLElement>('#page');
      if (content) content.style.minHeight = '3000px';
      window.scrollTo(0, 600);
    });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
    const bar = await box(page.getByRole('region', { name: 'Market status' }));
    expect(bar.y).toBeGreaterThanOrEqual(-1);
    expect(bar.y).toBeLessThan(4);
  });

  test('the chips are not a keyboard stop on desktop (nothing scrolls)', async ({ page }) => {
    await logIn(page);
    await expect(page.getByRole('group', { name: 'Market details' })).not.toHaveAttribute(
      'tabindex',
      /.*/,
    );
  });
});

test.describe('phone layout', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone only');

  test('the status bar stays compact and the chips scroll inside their own box', async ({
    page,
  }) => {
    await logIn(page);
    const bar = await checkStatusBarRows(page);
    expect(bar.height).toBeLessThan(200);

    const chips = page.getByRole('group', { name: 'Market details' });
    await expect(chips).toHaveAttribute('tabindex', '0');
    const scrolls = await chips.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrolls).toBe(true);
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(pageOverflow).toBeLessThanOrEqual(0);
  });

  test('the bottom tabs have icons and stay inside the screen', async ({ page }) => {
    await logIn(page);
    const tabs = page.getByRole('navigation', { name: 'Main navigation, bottom tabs' });
    const tabsBox = await box(tabs);
    expect(tabsBox.x).toBeGreaterThanOrEqual(0);
    expect(tabsBox.x + tabsBox.width).toBeLessThanOrEqual(390.5);
    await expect(tabs.locator('svg')).toHaveCount(5);
  });
});

test.describe('the history and the detail fit the screen', () => {
  const screens = [
    { path: '/signals', ready: 'history-row-43' },
    { path: '/signals/00000000-0000-4000-8000-000000000028', ready: 'detail-header' },
    { path: '/signals/00000000-0000-4000-8000-000000000029', ready: 'detail-header' },
  ] as const;

  for (const { path, ready } of screens) {
    test(`${path} has no sideways scroll of the page`, async ({ page }) => {
      await logIn(page);
      await page.goto(path);
      await expect(page.getByTestId(ready)).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test('the table is wider than a phone and scrolls inside its own box', async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, 'phone only');
    await logIn(page);
    await page.goto('/signals');
    await expect(page.getByTestId('history-row-43')).toBeVisible();
    const viewport = page.getByTestId('history-table').locator('.mantine-ScrollArea-viewport');
    expect(await viewport.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(pageOverflow).toBeLessThanOrEqual(0);
  });

  test('on a phone the filters are folded and the chart of a trade starts closed; on a desktop both are open', async ({
    page,
    isMobile,
  }) => {
    await logIn(page);
    await page.goto('/signals');
    await expect(page.getByTestId('history-row-43')).toBeVisible();
    const fold = page.getByRole('button', { name: /^Filters/ });
    if (isMobile) {
      await expect(fold).toBeVisible();
      await expect(fold).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('combobox', { name: 'Result' })).toBeHidden();
    } else {
      await expect(fold).toHaveCount(0);
      await expect(page.getByRole('combobox', { name: 'Result' })).toBeVisible();
    }
    await page.goto('/signals/00000000-0000-4000-8000-000000000028');
    await expect(page.getByTestId('detail-header')).toBeVisible();
    await expect(page.getByTestId('detail-chart')).toHaveCount(isMobile ? 0 : 1);
  });
});
