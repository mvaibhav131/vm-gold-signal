import { expect, test, type Page } from '@playwright/test';

import { expectNoProblems, logIn } from './support';

// The changes of the System screen on the real API (phase U5c): each switch is saved by PATCH /settings or
// PATCH /strategies/<key>, and a reload reads it back from the database. Every scenario puts back what it changed, because the
// scenarios of a world share one stack.

async function openTab(page: Page, tab: string): Promise<void> {
  await page.goto(`/system?tab=${tab}`);
  await expect(page.getByRole('heading', { name: 'System', level: 1 })).toBeVisible();
}

async function choose(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test.describe('strategies', () => {
  test('the alert switch of a strategy is saved, read back after a reload, and is the same switch on the Alerts tab', async ({
    page,
  }) => {
    const problems = await logIn(page);
    await openTab(page, 'strategies');
    const alerts = page.getByRole('switch', { name: 'Alerts: Trend Pullback' });
    const before = await alerts.isChecked();

    await alerts.click();
    await expect(alerts).toBeChecked({ checked: !before });
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Alerts: Trend Pullback' })).toBeChecked({
      checked: !before,
    });
    await expect(page.getByRole('switch', { name: 'Enabled: Trend Pullback' })).toBeChecked();

    await page.getByRole('tab', { name: 'Alerts' }).click();
    await expect(page.getByTestId('alerts-telegram-switch')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Trend Pullback', exact: true })).toBeChecked({
      checked: !before,
    });

    await page.getByRole('tab', { name: 'Strategies' }).click();
    await page.getByRole('switch', { name: 'Alerts: Trend Pullback' }).click();
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Alerts: Trend Pullback' })).toBeChecked({
      checked: before,
    });
    expectNoProblems(problems);
  });

  test('switching a strategy off asks first; Cancel changes nothing; Switch off is read back after a reload; switching on needs no question', async ({
    page,
  }) => {
    const problems = await logIn(page);
    await openTab(page, 'strategies');
    const enabled = page.getByRole('switch', { name: 'Enabled: Liquidity Sweep Reversal' });
    await expect(enabled).toBeChecked();

    await enabled.click();
    const dialog = page.getByRole('dialog', { name: 'Switch off Liquidity Sweep Reversal?' });
    await expect(dialog).toContainText('Signals that are already open keep being tracked');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(enabled).toBeChecked();

    await enabled.click();
    await page.getByTestId('strategy-disable-confirm').click();
    await expect(enabled).not.toBeChecked();
    await page.reload();
    await expect(
      page.getByRole('switch', { name: 'Enabled: Liquidity Sweep Reversal' }),
    ).not.toBeChecked();
    await expect(page.getByRole('switch', { name: 'Enabled: Trend Pullback' })).toBeChecked();

    await page.getByRole('switch', { name: 'Enabled: Liquidity Sweep Reversal' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole('switch', { name: 'Enabled: Liquidity Sweep Reversal' }),
    ).toBeChecked();
    expectNoProblems(problems);
  });

  test('the configuration is read only and is loaded from the API when it is opened', async ({
    page,
  }) => {
    const problems = await logIn(page);
    await openTab(page, 'strategies');
    await expect(page.getByTestId('strategy-config-trend_pullback')).toHaveCount(0);
    await page
      .getByTestId('strategy-row-trend_pullback')
      .getByRole('button', { name: 'Configuration (read only)' })
      .click();
    await expect(page.getByTestId('strategy-config-trend_pullback')).toContainText(
      '"exitProfile": "EP1_PARTIAL"',
    );
    expectNoProblems(problems);
  });
});

test.describe('alerts', () => {
  test('the language, the Telegram switch, the grade and the kinds are saved and read back after a reload', async ({
    page,
  }) => {
    const problems = await logIn(page);
    await openTab(page, 'alerts');
    const grade = page.getByTestId('alerts-telegram-grade');
    const gradeBefore = await grade.inputValue();
    const gradeNew = gradeBefore === 'Strong' ? 'Moderate' : 'Strong';
    const telegram = page.getByRole('switch', { name: 'Telegram alerts' });
    const telegramBefore = await telegram.isChecked();
    const digest = page.getByRole('checkbox', { name: 'Daily summary' });
    const digestBefore = await digest.isChecked();
    const hinglishBefore = await page.getByRole('radio', { name: 'Hinglish' }).isChecked();

    await page
      .getByTestId('alerts-locale')
      .getByText(hinglishBefore ? 'English' : 'Hinglish')
      .click();
    await digest.click();
    await choose(page, 'Telegram: minimum grade of a signal', gradeNew);
    await telegram.click();
    await expect(page.getByTestId('alerts-status')).toHaveText('Saved');

    await page.reload();
    await expect(page.getByRole('radio', { name: 'Hinglish' })).toBeChecked({
      checked: !hinglishBefore,
    });
    await expect(page.getByRole('switch', { name: 'Telegram alerts' })).toBeChecked({
      checked: !telegramBefore,
    });
    await expect(page.getByTestId('alerts-telegram-grade')).toHaveValue(gradeNew);
    await expect(page.getByRole('checkbox', { name: 'Daily summary' })).toBeChecked({
      checked: !digestBefore,
    });

    // put it all back
    await page
      .getByTestId('alerts-locale')
      .getByText(hinglishBefore ? 'Hinglish' : 'English')
      .click();
    await page.getByRole('checkbox', { name: 'Daily summary' }).click();
    await choose(page, 'Telegram: minimum grade of a signal', gradeBefore);
    await page.getByRole('switch', { name: 'Telegram alerts' }).click();
    await expect(page.getByTestId('alerts-status')).toHaveText('Saved');
    await page.reload();
    await expect(page.getByTestId('alerts-telegram-grade')).toHaveValue(gradeBefore);
    await expect(page.getByRole('switch', { name: 'Telegram alerts' })).toBeChecked({
      checked: telegramBefore,
    });
    expectNoProblems(problems);
  });

  test('a flag set to block, a topic and the move alerts are saved and read back after a reload', async ({
    page,
  }) => {
    const problems = await logIn(page);
    await openTab(page, 'alerts');
    const topic = page.getByRole('switch', { name: 'Trump policy' });
    const topicBefore = await topic.isChecked();
    const moves = page.getByRole('switch', { name: 'Alert for sudden moves of gold' });
    const movesBefore = await moves.isChecked();
    const rollover = page.getByTestId('advisory-rollover');
    const blockBefore = await rollover.getByRole('radio', { name: 'Block' }).isChecked();

    await rollover.getByText(blockBefore ? 'Warn' : 'Block').click();
    await topic.click();
    await moves.click();
    await expect(page.getByTestId('alerts-status')).toHaveText('Saved');

    await page.reload();
    await expect(
      page.getByTestId('advisory-rollover').getByRole('radio', { name: 'Block' }),
    ).toBeChecked({ checked: !blockBefore });
    await expect(page.getByRole('switch', { name: 'Trump policy' })).toBeChecked({
      checked: !topicBefore,
    });
    await expect(page.getByRole('switch', { name: 'Alert for sudden moves of gold' })).toBeChecked({
      checked: !movesBefore,
    });

    await page
      .getByTestId('advisory-rollover')
      .getByText(blockBefore ? 'Block' : 'Warn')
      .click();
    await page.getByRole('switch', { name: 'Trump policy' }).click();
    await page.getByRole('switch', { name: 'Alert for sudden moves of gold' }).click();
    await expect(page.getByTestId('alerts-status')).toHaveText('Saved');
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Trump policy' })).toBeChecked({
      checked: topicBefore,
    });
    expectNoProblems(problems);
  });

  test('the test message is queued and the screen says so with its id', async ({ page }) => {
    const problems = await logIn(page);
    await openTab(page, 'alerts');
    await page.getByTestId('alerts-test-button').click();
    await expect(page.getByTestId('alerts-test-result')).toContainText(
      /^Test message queued \(test:[0-9a-f-]{36}\)\./,
    );
    expectNoProblems(problems);
  });

  test('the Web Push section says in words what this browser can do: the server has its keys, and a headless browser has no permission', async ({
    page,
  }) => {
    await logIn(page);
    await openTab(page, 'alerts');
    // the headless shell of Chromium always says "denied"; the subscribing itself is run in seeded-2b-push.spec.ts
    await expect(page.getByTestId('alerts-webpush-note')).toContainText(
      'Notifications are blocked for this site',
    );
    await expect(page.getByTestId('alerts-webpush-subscribe')).toBeDisabled();
  });
});

test.describe('display', () => {
  test('a new time zone is saved, the times follow it, and a reload keeps it', async ({ page }) => {
    const problems = await logIn(page);
    await openTab(page, 'display');
    await expect(page.getByTestId('display-timezone')).toHaveValue('Asia/Kolkata');
    await expect(page.getByTestId('display-now')).toHaveText(/\(IST\)$/);

    await choose(page, 'Time zone', 'America/New York');
    await expect(page.getByTestId('display-now')).toHaveText(/\((EDT|EST)\)$/);
    await page.reload();
    await expect(page.getByTestId('display-timezone')).toHaveValue('America/New York');
    await expect(page.getByTestId('display-now')).toHaveText(/\((EDT|EST)\)$/);
    await page.goto('/signals');
    await expect(page.getByTestId('history-row-39').locator('time')).toContainText(/(EDT|EST)$/);

    await openTab(page, 'display');
    await choose(page, 'Time zone', 'Asia/Kolkata');
    await page.reload();
    await expect(page.getByTestId('display-now')).toHaveText(/\(IST\)$/);
    expectNoProblems(problems);
  });
});
