import { expect, test } from '@playwright/test';

import { bodyText, expectNoProblems, logIn, openScreen } from './support';

// The screens on a phone, with the data of the real API (phase U5c): the layout was checked on the simulated data, and real
// data has longer names, more rows and values that the simulation never made. A page that scrolls sideways is a page whose
// content does not fit; a table scrolls inside its own box, never the page.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

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

test('every screen fits a phone: the page does not scroll sideways, and no error is seen', async ({
  page,
}) => {
  const problems = await logIn(page);
  for (const [path, heading] of SCREENS) {
    await test.step(path, async () => {
      await openScreen(page, path, heading);
      await expect(page.locator('.mantine-Skeleton-root')).toHaveCount(0);
      expect(await bodyText(page)).not.toMatch(/Could not load|Retrying/);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} is wider than the screen by this many pixels`).toBeLessThanOrEqual(
        0,
      );
    });
  }
  expectNoProblems(problems);
});

test('the signal detail of a closed signal fits a phone', async ({ page }) => {
  const problems = await logIn(page);
  await openScreen(page, '/signals?result=LOSS', 'Signals');
  await page.getByTestId('history-row-37').getByRole('link', { name: 'S-0037' }).click();
  await expect(page.getByTestId('page-signal-detail')).toContainText('Why this signal');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  expectNoProblems(problems);
});
