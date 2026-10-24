import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { PRIVATE_ROUTES, logIn } from './helpers';

// Scenario E16: zero serious or critical axe violations on every route, in the dark and in the
// light theme. Axe reads the DOM, no image is taken. An axe run on a busy machine (every worker
// has a browser) can take long, so the tests of this file have 60 s instead of 30 s.
test.describe.configure({ timeout: 60_000 });

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
      test.setTimeout(120_000);
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

    /** The analytics page with every block loaded (the last block, the news impact, is the slowest to appear). */
    async function openAnalytics(page: Page, query = ''): Promise<void> {
      await logIn(page);
      await page.goto(`/analytics${query}`);
      await expect(page.getByTestId('news-impact')).toBeVisible();
      await expect(page.getByTestId('drift-panel')).toBeVisible();
      await expect(page.getByTestId('equity-curve').locator('svg')).toBeVisible();
      await expect(page.getByTestId('calibration')).toBeVisible();
      await expect(page.getByTestId('group-effectiveness')).toBeVisible();
    }

    test('the analytics page with every block loaded, in the forward and the backtest scope, has none', async ({
      page,
    }) => {
      await openAnalytics(page);
      expect(await seriousViolations(page)).toEqual([]);
      await page.getByTestId('scope-switch').getByText('Backtest out-of-sample').click();
      await expect(page.getByTestId('kpi-generated')).toContainText('318');
      await expect(page.getByTestId('news-impact')).toBeVisible();
      await expect(page.getByTestId('calibration')).toBeVisible();
      await expect(page.getByTestId('group-effectiveness')).toBeVisible();
      await expect(page.getByTestId('failure-total')).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
    });

    test('the analytics breakdown, with every tab opened, has none', async ({ page }) => {
      test.setTimeout(90_000);
      await openAnalytics(page);
      for (const tab of ['Side', 'Session', 'Regime', 'Volatility', 'News condition', 'Grade']) {
        await page.getByRole('tab', { name: tab }).click();
        await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByTestId(/^breakdown-[a-z]+$/)).toBeVisible();
        expect(await seriousViolations(page), tab).toEqual([]);
      }
    });

    test('the analytics page with the cause rules and the strategy menu opened has none', async ({
      page,
    }) => {
      await openAnalytics(page, '?scope=BACKTEST_OOS');
      await expect(page.getByTestId('kpi-generated')).toContainText('318');
      await page.getByRole('button', { name: 'How each cause is decided' }).click();
      await expect(page.getByTestId('failure-rules')).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
      await page.getByRole('combobox', { name: 'Strategy' }).click();
      await expect(
        page.getByRole('option', { name: 'Squeeze Breakout and Retest', exact: true }),
      ).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
      await page.keyboard.press('Escape');
    });

    test('the news screen, with every tab opened and a menu open, has none', async ({ page }) => {
      test.setTimeout(90_000);
      await logIn(page);
      await page.goto('/news');
      await expect(page.getByTestId('news-past')).toBeVisible();
      expect(await seriousViolations(page), 'calendar').toEqual([]);
      await page.getByRole('combobox', { name: 'Importance' }).click();
      await expect(page.getByRole('option', { name: 'High', exact: true })).toBeVisible();
      expect(await seriousViolations(page), 'importance menu').toEqual([]);
      await page.keyboard.press('Escape');
      await page.getByRole('tab', { name: 'Headlines' }).click();
      await expect(page.getByTestId('news-headlines')).toBeVisible();
      expect(await seriousViolations(page), 'headlines').toEqual([]);
      await page.getByRole('combobox', { name: 'Topic' }).click();
      await expect(page.getByRole('option', { name: 'Risk-off moves', exact: true })).toBeVisible();
      expect(await seriousViolations(page), 'topic menu').toEqual([]);
      await page.keyboard.press('Escape');
      await page.getByRole('tab', { name: 'Market moves' }).click();
      await expect(page.getByTestId('news-moves')).toBeVisible();
      expect(await seriousViolations(page), 'market moves').toEqual([]);
    });

    test('the news screen inside a news window has none', async ({ page }) => {
      await logIn(page, { scenario: 'wait' });
      await page.getByRole('link', { name: 'News', exact: true }).click();
      await expect(page.getByTestId('news-state-chip')).toHaveText('IN WINDOW');
      await expect(page.getByTestId('news-past')).toBeVisible();
      expect(await seriousViolations(page), 'in window').toEqual([]);
    });

    test('the news screen with the calendar feed and every headline feed down has none', async ({
      page,
    }) => {
      await logIn(page, { scenario: 'news-unknown' });
      await page.getByRole('link', { name: 'News', exact: true }).click();
      await expect(page.getByTestId('news-state-chip')).toHaveText('UNKNOWN');
      await expect(page.getByTestId('news-past')).toBeVisible();
      expect(await seriousViolations(page), 'unknown calendar').toEqual([]);
      await page.getByRole('tab', { name: 'Headlines' }).click();
      await expect(page.getByTestId('headline-feed-banner')).toBeVisible();
      expect(await seriousViolations(page), 'feeds down').toEqual([]);
    });

    test('the system screen, with every tab opened, has none', async ({ page }) => {
      test.setTimeout(90_000);
      await logIn(page);
      await page.goto('/system');
      await expect(page.getByTestId('health-incidents')).toBeVisible();
      await expect(page.getByTestId('health-latency')).toBeVisible();
      expect(await seriousViolations(page), 'Health').toEqual([]);
      const ready = {
        Storage: 'storage-retention',
        Strategies: 'strategy-row-pattern_breakout',
        Alerts: 'alerts-market-moves',
        Display: 'display-numbers',
        Security: 'sessions-table',
      } as const;
      for (const [tab, testId] of Object.entries(ready)) {
        await page.getByRole('tab', { name: tab }).click();
        await expect(page.getByTestId(testId)).toBeVisible();
        expect(await seriousViolations(page), tab).toEqual([]);
      }
    });

    test('the system screen with its questions and menus open has none', async ({ page }) => {
      test.setTimeout(90_000);
      await logIn(page);
      await page.goto('/system');
      await page.getByTestId('health-pause').click();
      await expect(page.getByRole('dialog', { name: 'Pause the engine?' })).toBeVisible();
      expect(await seriousViolations(page), 'pause question').toEqual([]);
      await page.getByRole('button', { name: 'Cancel' }).click();

      await page.getByRole('tab', { name: 'Strategies' }).click();
      await page.getByRole('switch', { name: 'Enabled: Trend Pullback' }).click();
      await expect(page.getByRole('dialog', { name: 'Switch off Trend Pullback?' })).toBeVisible();
      expect(await seriousViolations(page), 'switch-off question').toEqual([]);
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page
        .getByTestId('strategy-row-trend_pullback')
        .getByRole('button', { name: 'Configuration (read only)' })
        .click();
      await expect(page.getByTestId('strategy-config-trend_pullback')).toBeVisible();
      expect(await seriousViolations(page), 'configuration').toEqual([]);

      await page.getByRole('tab', { name: 'Alerts' }).click();
      await page.getByRole('combobox', { name: 'Telegram: minimum grade of a signal' }).click();
      await expect(page.getByRole('option', { name: 'Very strong', exact: true })).toBeVisible();
      expect(await seriousViolations(page), 'grade menu').toEqual([]);
      await page.keyboard.press('Escape');

      await page.getByRole('tab', { name: 'Display' }).click();
      await page.getByRole('combobox', { name: 'Time zone' }).click();
      await expect(page.getByRole('option', { name: 'Europe/London', exact: true })).toBeVisible();
      expect(await seriousViolations(page), 'time-zone menu').toEqual([]);
      await page.keyboard.press('Escape');

      await page.getByRole('tab', { name: 'Security' }).click();
      await page.getByTestId('session-revoke-sess-phone').click();
      await expect(page.getByRole('dialog', { name: 'Revoke this session?' })).toBeVisible();
      expect(await seriousViolations(page), 'revoke question').toEqual([]);
    });

    test('the security tab with its errors, the 2-step setup and the recovery codes has none', async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await logIn(page);
      await page.goto('/system?tab=security');
      await page.getByTestId('password-submit').click();
      await expect(page.getByText('Enter your current password')).toBeVisible();
      expect(await seriousViolations(page), 'password errors').toEqual([]);
      await page.getByTestId('totp-setup').click();
      await expect(page.getByTestId('totp-setup-panel')).toBeVisible();
      await page.getByTestId('totp-code').fill('12ab');
      await page.getByTestId('totp-enable').click();
      await expect(page.getByText('The code has 6 digits')).toBeVisible();
      expect(await seriousViolations(page), 'setup with an error').toEqual([]);
      await page.getByTestId('totp-code').fill('123456');
      await page.getByTestId('totp-enable').click();
      await expect(page.getByTestId('totp-recovery-codes')).toBeVisible();
      expect(await seriousViolations(page), 'recovery codes').toEqual([]);
    });

    test('the system screen in the warning state, with the health and the storage tab, has none', async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await logIn(page, { scenario: 'system-warning' });
      await page.getByRole('link', { name: 'System', exact: true }).click();
      await expect(page.getByTestId('health-summary')).toHaveText('4 checks need attention.');
      expect(await seriousViolations(page), 'health').toEqual([]);
      await page.getByRole('tab', { name: 'Storage' }).click();
      await expect(page.getByTestId('storage-warning')).toBeVisible();
      expect(await seriousViolations(page), 'storage').toEqual([]);
    });

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
