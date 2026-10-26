import { expect, test } from '@playwright/test';

import { bodyText, expectNoProblems, logIn, openScreen } from './support';

// The first hour of a new VM (VMGS_LIVE_WORLD=fresh): ticks and a heartbeat, the strategies registered, no candles, no signals, no
// calendar, an engine that is still warming up. Every screen has to say so in words, with no error.

const STRATEGY_KEYS = [
  'trend_pullback',
  'sweep_reversal',
  'squeeze_retest',
  'trendline_retest',
  'pattern_breakout',
] as const;

test('every screen of a stack that has just been set up says what is missing, with no error', async ({
  page,
}) => {
  const problems = await logIn(page);

  await test.step('dashboard', async () => {
    await expect(page.getByTestId('open-signals')).toContainText('Open signals', {
      useInnerText: true,
    });
    await expect(page.locator('main')).toContainText('Warming up 12%', { useInnerText: true });
    await expect(page.locator('main')).toContainText('Still missing candles on: 5M 15M 1H', {
      useInnerText: true,
    });
    await expect(page.getByTestId('recent-signals')).toContainText(
      'No signal has been produced yet.',
    );
    await expect(page.getByTestId('chart-empty')).toContainText('candles have been recorded yet', {
      useInnerText: true,
    });
    await expect(page.getByTestId('status-engine')).toHaveText('WARMING UP');
  });

  await test.step('signals', async () => {
    await openScreen(page, '/signals', 'Signals');
    await expect(page.getByTestId('history-count')).toHaveText('Showing 0 of 0 signals');
    await expect(page.getByText('No signals match these filters.')).toBeVisible();
  });

  await test.step('analytics', async () => {
    await openScreen(page, '/analytics', 'Analytics');
    await expect(page.getByTestId('page-analytics')).toContainText(/Signals generated\s+0\b/, {
      useInnerText: true,
    });
    await expect(page.getByTestId('page-analytics')).toContainText(
      'No signals in this scope yet.',
      { useInnerText: true },
    );
    await expect(page.getByTestId('page-analytics')).toContainText('Insufficient evidence', {
      useInnerText: true,
    });
  });

  await test.step('news', async () => {
    await openScreen(page, '/news', 'News');
    await expect(page.getByTestId('news-state')).toContainText(
      'No high-impact event is scheduled.',
    );
    await expect(page.locator('main')).toContainText('No event in the next week.', {
      useInnerText: true,
    });
    await expect(page.locator('main')).toContainText('No event in the last two weeks.', {
      useInnerText: true,
    });
    await openScreen(page, '/news?tab=headlines', 'News');
    await openScreen(page, '/news?tab=moves', 'News');
  });

  await test.step('system', async () => {
    await openScreen(page, '/system', 'System');
    await expect(page.locator('main')).toContainText('Warming up', { useInnerText: true });
    await expect(page.locator('main')).toContainText('No backup yet', { useInnerText: true });
    await expect(page.locator('main')).toContainText('not measured yet', { useInnerText: true });
    await openScreen(page, '/system?tab=strategies', 'System');
    for (const key of STRATEGY_KEYS) {
      await expect(page.getByTestId(`strategy-row-${key}`)).toBeVisible();
    }
    await openScreen(page, '/system?tab=storage', 'System');
    await expect(page.locator('main')).toContainText('Database size', { useInnerText: true });
  });

  await expect(page.locator('.mantine-Skeleton-root')).toHaveCount(0);
  expect(await bodyText(page)).not.toMatch(/Could not load|Retrying/);
  expectNoProblems(problems);
});
