import { expect, test, type Locator, type Page } from '@playwright/test';

import { logIn } from './helpers';

// Scenario E10 on the simulated results (05_UI_Spec section 9.4): the numbers on the screen are
// the numbers of the API, the scope switch changes every block that follows it, no percentage
// appears under 30 results and every sample under 100 is labelled. Every check reads the DOM; no
// image is taken. The simulated history is relative to the clock, so nothing here depends on the
// date: month names are not pinned, only how the months add up.

const kpi = (page: Page, name: string) => page.getByTestId(`kpi-${name}`);

async function openAnalytics(page: Page, query = ''): Promise<void> {
  await logIn(page);
  await page.goto(`/analytics${query}`);
  await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible();
  await expect(kpi(page, 'generated')).toBeVisible();
}

async function useBacktest(page: Page): Promise<void> {
  await page.getByTestId('scope-switch').getByText('Backtest out-of-sample').click();
  await expect(kpi(page, 'generated')).toContainText('318');
}

/** The numbers of one column of a table (first column is 0), for the given rows. */
async function column(rows: Locator, index: number): Promise<number[]> {
  return rows.evaluateAll(
    (els, at) => els.map((el) => Number(el.querySelectorAll('th,td')[at]?.textContent)),
    index,
  );
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

async function cellText(row: Locator, index: number): Promise<string> {
  return row.evaluate((el, at) => el.querySelectorAll('th,td')[at]?.textContent ?? '', index);
}

test.describe('E10 analytics', () => {
  test('opens from the navigation on the forward paper results, with the key numbers of the API', async ({
    page,
  }) => {
    await logIn(page);
    await page.getByRole('link', { name: 'Analytics', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Forward paper' })).toBeChecked();
    await expect(kpi(page, 'generated')).toContainText('43');
    await expect(kpi(page, 'tracked')).toContainText('39');
    // 39 valid results: a win rate with its interval, and the low-sample label (under 100)
    await expect(kpi(page, 'win-rate')).toContainText('54%');
    await expect(kpi(page, 'win-rate')).toContainText(/95% CI \d+–\d+%, n = 39/);
    await expect(kpi(page, 'win-rate')).toContainText('Low sample');
    await expect(kpi(page, 'net-r')).toContainText('+6.34R');
    await expect(kpi(page, 'expectancy')).toContainText('+0.16R');
    await expect(kpi(page, 'profit-factor')).toContainText('1.38');
    await expect(kpi(page, 'max-drawdown')).toContainText('-3.68R');
    await expect(kpi(page, 'tp1-rate')).toContainText('51%');
    await expect(kpi(page, 'tp2-rate')).toContainText('36%');
    await expect(page.getByTestId('scope-note')).toContainText('generated in real time');
  });

  test('the scope switch changes the numbers and the address, and a reload keeps the scope', async ({
    page,
  }) => {
    await openAnalytics(page);
    await useBacktest(page);
    expect(new URL(page.url()).search).toBe('?scope=BACKTEST_OOS');
    await expect(kpi(page, 'tracked')).toContainText('302');
    await expect(kpi(page, 'win-rate')).toContainText(/54%/);
    // 302 valid results: no low-sample label
    await expect(kpi(page, 'win-rate')).not.toContainText('Low sample');
    await expect(kpi(page, 'net-r')).toContainText('+34.90R');
    await expect(page.getByTestId('scope-note')).toContainText('not used to build them');

    await page.reload();
    await expect(page.getByRole('radio', { name: 'Backtest out-of-sample' })).toBeChecked();
    await expect(kpi(page, 'generated')).toContainText('318');

    await page.getByTestId('scope-switch').getByText('Forward paper').click();
    await expect(kpi(page, 'generated')).toContainText('43');
    expect(new URL(page.url()).search).toBe('');
  });

  test('the monthly table adds up to the key numbers in both scopes, with no percentage under 30 results', async ({
    page,
  }) => {
    await openAnalytics(page);
    const rows = page.getByTestId(/^monthly-row-/);
    await expect(rows.first()).toBeVisible();
    expect(sum(await column(rows, 1))).toBe(43);
    expect(sum(await column(rows, 2))).toBe(39);
    for (const text of await rows.evaluateAll((els) =>
      els.map((el) => el.querySelectorAll('th,td')[9]?.textContent ?? ''),
    )) {
      expect(text).toBe('–Insufficient evidence');
    }

    await useBacktest(page);
    await expect(rows).toHaveCount(12);
    expect(sum(await column(rows, 1))).toBe(318);
    expect(sum(await column(rows, 2))).toBe(302);
    expect(sum(await column(rows, 3)) + sum(await column(rows, 4))).toBeGreaterThan(0);
  });

  test('the equity curve is drawn, ends at the net R of the key numbers and fits its box', async ({
    page,
  }) => {
    await openAnalytics(page);
    const chart = page.getByTestId('equity-curve');
    await expect(
      chart.getByRole('img', { name: /Equity curve in R: .*39 valid results/ }),
    ).toBeVisible();
    await expect(page.getByTestId('equity-summary')).toContainText(
      '39 valid results. Now +6.34R, highest +7.68R, lowest -1.05R.',
    );
    await expect(chart).toContainText('Low sample');
    const fits = await chart.evaluate((el) => {
      const svg = el.querySelector('svg');
      return (
        svg !== null && svg.getBoundingClientRect().width <= el.getBoundingClientRect().width + 1
      );
    });
    expect(fits).toBe(true);
    expect(await chart.locator('svg path').count()).toBe(2);

    await useBacktest(page);
    await expect(page.getByTestId('equity-summary')).toContainText(
      '302 valid results. Now +34.90R',
    );
    await expect(chart).not.toContainText('Low sample');
  });

  test('every breakdown tab adds up to the valid results, and only the open tab is on the page', async ({
    page,
  }) => {
    await openAnalytics(page);
    for (const [tab, by] of [
      ['Strategy', 'strategy'],
      ['Side', 'side'],
      ['Session', 'session'],
      ['Regime', 'regime'],
      ['Volatility', 'volatility'],
      ['News condition', 'news'],
      ['Grade', 'grade'],
    ] as const) {
      await page.getByRole('tab', { name: tab }).click();
      const table = page.getByTestId(`breakdown-${by}`);
      await expect(table).toBeVisible();
      expect(sum(await column(table.locator('tbody tr'), 1)), tab).toBe(39);
      await expect(page.getByTestId(/^breakdown-(?!.*-row-)/)).toHaveCount(1);
    }
  });

  test('forward results under 30 show counts and the words; the backtest shows percentages with intervals and sample labels', async ({
    page,
  }) => {
    await openAnalytics(page);
    const strategy = page.getByTestId('breakdown-strategy');
    await expect(strategy).toBeVisible();
    expect(await strategy.textContent()).not.toContain('%');
    const trend = page.getByTestId('breakdown-strategy-row-trend_pullback');
    await expect(trend).toContainText('Insufficient evidence');
    expect(await cellText(trend, 1)).toBe('24');

    await useBacktest(page);
    await expect(trend).toContainText('55%');
    await expect(trend).toContainText(/\(95% CI \d+–\d+%\)/);
    await expect(trend).not.toContainText('Low sample');
    const squeeze = page.getByTestId('breakdown-strategy-row-squeeze_retest');
    await expect(squeeze).toContainText('Low sample');
    const sweep = page.getByTestId('breakdown-strategy-row-sweep_reversal');
    await expect(sweep).toContainText('Insufficient evidence');
    expect(await sweep.textContent()).not.toContain('%');
  });

  test('failure analysis ranks the causes, shows shares only from 30 reviewed results and says it is a heuristic', async ({
    page,
  }) => {
    await openAnalytics(page);
    await expect(page.getByTestId('failure-total')).toContainText('25 reviewed results');
    await expect(page.getByTestId('failure-total')).toContainText('Fewer than 30');
    const causes = page.getByTestId(/^failure-row-/);
    const counts = await column(causes, 2);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(sum(counts)).toBe(25);
    expect(await page.getByTestId('failure-causes').textContent()).not.toContain('%');
    await expect(page.getByTestId('failure-row-NORMAL_LOSS')).toContainText('Setup failure');
    await expect(page.getByText(/Heuristic attribution/)).toBeVisible();

    await useBacktest(page);
    await expect(page.getByTestId('failure-total')).not.toContainText('Fewer than 30');
    await expect(causes.first()).toContainText('%');
    await page.getByRole('button', { name: 'How each cause is decided' }).click();
    await expect(page.getByTestId('failure-rules')).toBeVisible();
    await expect(page.getByTestId('failure-rules').getByRole('listitem')).toHaveCount(9);
  });

  test('the evidence groups are a matrix by their state at entry, for the strategy that is chosen', async ({
    page,
  }) => {
    await openAnalytics(page);
    const matrix = page.getByTestId('group-effectiveness');
    await expect(matrix).toBeVisible();
    await expect(page.getByTestId(/^group-row-/)).toHaveCount(7);
    expect(await matrix.textContent()).not.toContain('%');
    await expect(matrix).toContainText('insufficient evidence');

    await useBacktest(page);
    const cell = page.getByTestId('group-cell-trigger-STRONG');
    await expect(cell).toContainText('71%');
    await expect(cell).toContainText('n = 58, low sample');
    await page.getByRole('combobox', { name: 'Strategy' }).click();
    await page.getByRole('option', { name: 'Squeeze Breakout and Retest', exact: true }).click();
    await expect(page.getByTestId('group-row-trend')).toContainText('n = ');
    const squeezeCells = page.locator('[data-testid^="group-cell-trend-"]');
    const ns = await squeezeCells.evaluateAll((els) =>
      els.map((el) => Number(/n = (\d+)/.exec(el.textContent)?.[1] ?? 0)),
    );
    expect(sum(ns)).toBe(64);
  });

  test('the score calibration lists six bands, and a bar only where there is a percentage', async ({
    page,
  }) => {
    await openAnalytics(page);
    await expect(page.getByTestId(/^calibration-row-/)).toHaveCount(6);
    await useBacktest(page);
    const first = page.getByTestId('calibration-row-65-69');
    await expect(first).toContainText('45%');
    await expect(first.locator('.bar-fill')).toHaveCount(1);
    const small = page.getByTestId('calibration-row-80-84');
    await expect(small).toContainText('Insufficient evidence');
    expect(await small.textContent()).not.toContain('%');
    await expect(small.locator('.bar-fill')).toHaveCount(0);
    await expect(page.getByTestId('calibration-row-90-100')).toBeVisible();
  });

  test('drift and news impact do not follow the scope switch, and say so', async ({ page }) => {
    await openAnalytics(page);
    const drift = page.getByTestId('drift-panel');
    await expect(drift).toBeVisible();
    await expect(page.getByTestId('news-impact')).toBeVisible();
    const before = [await drift.textContent(), await page.getByTestId('news-impact').textContent()];
    // every strategy has fewer than 30 forward results: counts and the words, no percentage
    await expect(page.getByTestId('drift-status-trend_pullback')).toHaveText('Insufficient data');
    await expect(page.getByTestId('drift-row-trend_pullback')).toContainText('24 of 50');
    await expect(page.getByTestId('drift-row-sweep_reversal')).toContainText(
      'No backtest interval',
    );
    await useBacktest(page);
    await expect(page.getByTestId('outside-scope-note')).toContainText('do not follow the switch');
    expect([
      await drift.textContent(),
      await page.getByTestId('news-impact').textContent(),
    ]).toEqual(before);
  });

  test('news impact words an association, never a cause, and shows no share under 30 headlines', async ({
    page,
  }) => {
    await openAnalytics(page);
    await expect(page.getByTestId(/^news-impact-row-/)).toHaveCount(17);
    const fed = page.getByTestId('news-impact-row-FED_RATES-HIGH');
    await expect(fed).toContainText('Fed and interest rates');
    await expect(fed).toContainText('43%');
    await expect(fed).toContainText('2.26×');
    const small = page.getByTestId('news-impact-row-CENTRAL_BANK_GOLD-HIGH');
    await expect(small).toContainText('Insufficient evidence');
    expect(await small.textContent()).not.toContain('%');
    expect(await small.textContent()).not.toContain('×');
    const section = page.getByRole('region', { name: 'Do headlines go with bigger gold moves?' });
    await expect(section).toContainText('an association, not a cause');
    expect(await page.getByTestId('page-analytics').textContent()).not.toMatch(
      /\b(caused|because of|due to the headline)\b/i,
    );
  });
});
