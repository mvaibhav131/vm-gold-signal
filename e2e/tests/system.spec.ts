import { expect, test, type Page } from '@playwright/test';

import { OWNER, fillLogin, logIn } from './helpers';

// Scenarios E12 (settings) and E13 (storage) on the simulated system (05_UI_Spec section 9.4): the
// switches, the language and the time zone persist after a reload, the test message is queued, the
// pause and the resume change the engine state, the retention rules and the sizes render, and the
// budget gauge follows the API. Every check reads the DOM; no image is taken.

const TABS = ['Health', 'Storage', 'Strategies', 'Alerts', 'Display', 'Security'] as const;

async function openSystem(page: Page, options: { scenario?: string; tab?: string } = {}) {
  if (options.scenario === undefined) {
    await logIn(page);
    await page.goto(options.tab === undefined ? '/system' : `/system?tab=${options.tab}`);
  } else {
    // a reload does not keep the preview state, so the page is reached through the navigation
    await logIn(page, { scenario: options.scenario });
    await page.getByRole('link', { name: 'System', exact: true }).click();
    const label = TABS.find((tab) => tab.toLowerCase() === options.tab);
    if (label !== undefined && label !== 'Health') {
      await page.getByRole('tab', { name: label }).click();
    }
  }
  await expect(page.getByRole('heading', { name: 'System', level: 1 })).toBeVisible();
}

async function choose(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

interface SavedPreferences {
  settings: {
    displayTz: string;
    locale: string;
    alerts: { telegram: { enabled: boolean; minGrade: string; kinds: string[] } };
    strategyAlerts: Record<string, string>;
  };
  enabled: Record<string, boolean>;
}

/** What the preview has saved so far. A test that reloads must first wait until the change was saved. */
const saved = (page: Page) =>
  page.evaluate(
    (): SavedPreferences | null =>
      JSON.parse(
        window.sessionStorage.getItem('vmgs-mock-preferences') ?? 'null',
      ) as SavedPreferences | null,
  );

test.describe('E12 system: the screen', () => {
  test('opens from the navigation on the health tab, with the six tabs', async ({ page }) => {
    await logIn(page);
    await page.getByRole('link', { name: 'System', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'System', level: 1 })).toBeVisible();
    await expect(page.getByRole('tab')).toHaveText([...TABS]);
    await expect(page.getByRole('tab', { name: 'Health' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByTestId('health-summary')).toHaveText('All checks are fine.');
    expect(new URL(page.url()).search).toBe('');
  });

  test('the tab is in the address, and a reload opens the same tab', async ({ page }) => {
    await openSystem(page);
    await page.getByRole('tab', { name: 'Storage' }).click();
    await expect(page.getByTestId('storage-db-size')).toBeVisible();
    expect(new URL(page.url()).search).toBe('?tab=storage');
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Storage' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByTestId('storage-db-size')).toBeVisible();
    await page.getByRole('tab', { name: 'Health' }).click();
    expect(new URL(page.url()).search).toBe('');
  });
});

test.describe('E12 system: health and the engine', () => {
  test('lists the nine checks, the latency and the incidents of the feed', async ({ page }) => {
    await openSystem(page);
    await expect(page.getByTestId('health-summary')).toHaveText('All checks are fine.');
    await expect(page.getByTestId('health-checks').getByTestId(/^health-[a-z]+$/)).toHaveCount(9);
    await expect(page.getByTestId('health-feed-value')).toHaveText(
      /^Live, newest tick \d\.\d s ago$/,
    );
    await expect(page.getByTestId('health-db-value')).toHaveText('Reachable');
    await expect(page.getByTestId('health-loop-value')).toHaveText('12 ms');
    await expect(page.getByTestId('latency-feedLag')).toContainText('180 ms');
    await expect(page.getByTestId('health-incidents').getByTestId(/^incident-/)).toHaveCount(9);
    await expect(page.getByTestId('health-incidents')).not.toContainText('Ongoing');
  });

  test('the system-warning state says which checks need attention, and the incident that is open', async ({
    page,
  }) => {
    await openSystem(page, { scenario: 'system-warning' });
    await expect(page.getByTestId('health-summary')).toHaveText('4 checks need attention.');
    for (const key of ['telegram', 'loop', 'clock', 'backup']) {
      await expect(page.getByTestId(`health-${key}`)).toContainText('DEGRADED');
    }
    await expect(page.getByTestId('health-telegram-value')).toContainText(
      'Telegram answered 502 Bad Gateway; retrying in 45 s.',
    );
    const first = page
      .getByTestId('health-incidents')
      .getByTestId(/^incident-/)
      .first();
    await expect(first).toContainText('Clock skew');
    await expect(first).toContainText('Ongoing');
  });

  test('a stale feed is worded as such, with its open incident', async ({ page }) => {
    await openSystem(page, { scenario: 'stale' });
    await expect(page.getByTestId('health-feed-value')).toHaveText('Stale, newest tick 18 s ago');
    await expect(page.getByTestId('health-feed')).toContainText('DEGRADED');
    await expect(
      page
        .getByTestId('health-incidents')
        .getByTestId(/^incident-/)
        .first(),
    ).toContainText('No tick for 18 s, new signals are blocked');
  });

  test('a disconnected feed is down, with its open incident', async ({ page }) => {
    await openSystem(page, { scenario: 'disconnected' });
    await expect(page.getByTestId('health-feed-value')).toContainText('Disconnected, last tick');
    await expect(page.getByTestId('health-feed')).toContainText('DOWN');
    await expect(page.getByTestId('health-ticks-value')).toHaveText('Not known');
    await expect(
      page
        .getByTestId('health-incidents')
        .getByTestId(/^incident-/)
        .first(),
    ).toContainText('Connection lost, reconnecting');
  });

  test('pausing asks first, shows PAUSED here and in the status bar, and resuming brings RUNNING back', async ({
    page,
  }) => {
    await openSystem(page);
    await expect(page.getByTestId('health-engine-status')).toHaveText('RUNNING');
    await page.getByTestId('health-pause').click();
    const dialog = page.getByRole('dialog', { name: 'Pause the engine?' });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('health-engine-status')).toHaveText('RUNNING');
    await dialog.getByText('30 minutes').click();
    await dialog.getByTestId('pause-confirm').click();
    await expect(page.getByTestId('health-engine-status')).toHaveText('PAUSED');
    await expect(page.getByTestId('health-engine')).toContainText('Paused since');
    await expect(page.getByTestId('status-engine')).toHaveText('PAUSED');
    await expect(page.getByTestId('health-pause')).toHaveCount(0);

    await page.getByTestId('health-resume').click();
    await expect(page.getByTestId('health-engine-status')).toHaveText('RUNNING');
    await expect(page.getByTestId('status-engine')).toHaveText('RUNNING');
    await expect(page.getByTestId('health-pause')).toBeVisible();
  });

  test('cancelling the pause question changes nothing', async ({ page }) => {
    await openSystem(page);
    await page.getByTestId('health-pause').click();
    const dialog = page.getByRole('dialog', { name: 'Pause the engine?' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('status-engine')).toHaveText('RUNNING');
  });
});

test.describe('E12 system: strategies', () => {
  test('lists the five strategies with the status that was earned, and the two switches', async ({
    page,
  }) => {
    await openSystem(page, { tab: 'strategies' });
    await expect(page.getByTestId(/^strategy-row-/)).toHaveCount(5);
    for (const key of ['trend_pullback', 'sweep_reversal', 'squeeze_retest']) {
      await expect(page.getByTestId(`strategy-status-${key}`)).toHaveText('Forward testing');
    }
    for (const key of ['trendline_retest', 'pattern_breakout']) {
      await expect(page.getByTestId(`strategy-status-${key}`)).toHaveText('Research');
    }
    await expect(page.getByTestId('strategy-last-pattern_breakout')).toHaveText(
      'Last signal: none yet',
    );
    await expect(page.getByTestId('strategy-evidence-pattern_breakout')).toHaveText(
      'Evidence: No evidence yet',
    );
    await expect(page.getByTestId('strategy-evidence-trend_pullback')).toContainText(/n=\d+/);
    await expect(page.getByRole('switch', { name: 'Enabled: Trend Pullback' })).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Alerts: Trend Pullback' })).toBeChecked();
    await expect(
      page.getByRole('switch', { name: 'Alerts: Trendline Break and Retest' }),
    ).not.toBeChecked();
  });

  test('the alert switch of a strategy persists after a reload, and is the same switch on the Alerts tab', async ({
    page,
  }) => {
    await openSystem(page, { tab: 'strategies' });
    const alerts = page.getByRole('switch', { name: 'Alerts: Trend Pullback' });
    await alerts.click();
    await expect(alerts).not.toBeChecked();
    await expect
      .poll(async () => (await saved(page))?.settings.strategyAlerts.trend_pullback)
      .toBe('off');
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Alerts: Trend Pullback' })).not.toBeChecked();
    await expect(
      page.getByRole('switch', { name: 'Alerts: Liquidity Sweep Reversal' }),
    ).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Enabled: Trend Pullback' })).toBeChecked();

    await page.getByRole('tab', { name: 'Alerts' }).click();
    await expect(page.getByTestId('alerts-telegram-switch')).toBeVisible();
    await expect(
      page.getByRole('switch', { name: 'Trend Pullback', exact: true }),
    ).not.toBeChecked();
    await expect(
      page.getByRole('switch', { name: 'Liquidity Sweep Reversal', exact: true }),
    ).toBeChecked();
  });

  test('switching a strategy off asks first; Cancel changes nothing; Switch off persists after a reload', async ({
    page,
  }) => {
    await openSystem(page, { tab: 'strategies' });
    const enabled = page.getByRole('switch', { name: 'Enabled: Liquidity Sweep Reversal' });
    await enabled.click();
    const dialog = page.getByRole('dialog', { name: 'Switch off Liquidity Sweep Reversal?' });
    await expect(dialog).toContainText('Signals that are already open keep being tracked');
    await expect(enabled).toBeChecked();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(enabled).toBeChecked();

    await enabled.click();
    await page.getByTestId('strategy-disable-confirm').click();
    await expect(enabled).not.toBeChecked();
    await expect.poll(async () => (await saved(page))?.enabled.sweep_reversal).toBe(false);
    await page.reload();
    await expect(
      page.getByRole('switch', { name: 'Enabled: Liquidity Sweep Reversal' }),
    ).not.toBeChecked();
    await expect(page.getByRole('switch', { name: 'Enabled: Trend Pullback' })).toBeChecked();
    // switching it on again needs no question
    await page.getByRole('switch', { name: 'Enabled: Liquidity Sweep Reversal' }).click();
    await expect(
      page.getByRole('switch', { name: 'Enabled: Liquidity Sweep Reversal' }),
    ).toBeChecked();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('the configuration is read only and loads when it is opened', async ({ page }) => {
    await openSystem(page, { tab: 'strategies' });
    await expect(page.getByTestId('strategy-config-trend_pullback')).toHaveCount(0);
    await page
      .getByTestId('strategy-row-trend_pullback')
      .getByRole('button', { name: 'Configuration (read only)' })
      .click();
    const config = page.getByTestId('strategy-config-trend_pullback');
    await expect(config).toContainText('"emaFast": 20');
    await expect(config).toContainText('"maxTickAgeSec": 10');
    await expect(page.getByTestId('strategy-row-trend_pullback')).toContainText(
      'In this preview the config is made up.',
    );
  });
});

test.describe('E12 system: alerts', () => {
  test('the language, the Telegram switch, the grade and the kinds persist after a reload', async ({
    page,
  }) => {
    await openSystem(page, { tab: 'alerts' });
    await expect(page.getByRole('radio', { name: 'English' })).toBeChecked();
    await page.getByTestId('alerts-locale').getByText('Hinglish').click();
    await expect(page.getByRole('radio', { name: 'Hinglish' })).toBeChecked();
    await expect.poll(async () => (await saved(page))?.settings.locale).toBe('hinglish');

    await page.getByRole('checkbox', { name: 'Daily summary' }).click();
    await choose(page, 'Telegram: minimum grade of a signal', 'Strong');
    await page.getByRole('switch', { name: 'Telegram alerts' }).click();
    await expect(page.getByTestId('alerts-status')).toHaveText('Saved');
    await expect
      .poll(async () => {
        const telegram = (await saved(page))?.settings.alerts.telegram;
        return [telegram?.enabled, telegram?.minGrade, telegram?.kinds.includes('DAILY_DIGEST')];
      })
      .toEqual([false, 'Strong', true]);

    await page.reload();
    await expect(page.getByRole('radio', { name: 'Hinglish' })).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Telegram alerts' })).not.toBeChecked();
    await expect(page.getByTestId('alerts-telegram-grade')).toHaveValue('Strong');
    await expect(page.getByRole('checkbox', { name: 'Daily summary' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'New signal' })).toBeChecked();
  });

  test('a flag set to block, the topics and the move alerts persist after a reload', async ({
    page,
  }) => {
    await openSystem(page, { tab: 'alerts' });
    await page.getByTestId('advisory-rollover').getByText('Block').click();
    await page.getByRole('switch', { name: 'Trump policy' }).click();
    await page.getByRole('switch', { name: 'Alert for sudden moves of gold' }).click();
    await expect(page.getByTestId('alerts-status')).toHaveText('Saved');
    await expect(
      page.getByTestId('advisory-rollover').getByRole('radio', { name: 'Block' }),
    ).toBeChecked();
    await expect
      .poll(async () => JSON.stringify((await saved(page))?.settings))
      .toContain('"rollover":"block"');
    await page.reload();
    await expect(
      page.getByTestId('advisory-rollover').getByRole('radio', { name: 'Block' }),
    ).toBeChecked();
    await expect(
      page.getByTestId('advisory-newsWindow').getByRole('radio', { name: 'Warn' }),
    ).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Trump policy' })).not.toBeChecked();
    await expect(page.getByRole('switch', { name: 'Fed and interest rates' })).toBeChecked();
    await expect(
      page.getByRole('switch', { name: 'Alert for sudden moves of gold' }),
    ).not.toBeChecked();
  });

  test('the test message is queued and said so, and the health tab sees the send', async ({
    page,
  }) => {
    await openSystem(page, { tab: 'alerts' });
    await page.getByTestId('alerts-test-button').click();
    await expect(page.getByTestId('alerts-test-result')).toContainText(
      /^Test message queued \(test:[0-9a-f-]{36}\)\./,
    );
    await page.getByRole('tab', { name: 'Health' }).click();
    await expect(page.getByTestId('health-telegram-value')).toHaveText(/^Last send \d+ s ago$/);
  });

  test('the Web Push buttons stay off, and the note says why', async ({ page }) => {
    await openSystem(page, { tab: 'alerts' });
    await expect(page.getByTestId('alerts-webpush-subscribe')).toBeDisabled();
    await expect(page.getByTestId('alerts-webpush-test')).toBeDisabled();
    await expect(page.getByTestId('alerts-webpush-note')).toContainText('built in phase U6');
  });
});

test.describe('E12 system: display', () => {
  test('a new time zone is saved, the time follows it, and a reload keeps it', async ({ page }) => {
    await openSystem(page, { tab: 'display' });
    await expect(page.getByTestId('display-timezone')).toHaveValue('Asia/Kolkata');
    await expect(page.getByTestId('display-now')).toHaveText(/\(IST\)$/);
    await choose(page, 'Time zone', 'America/New York');
    await expect(page.getByTestId('display-now')).toHaveText(/\((EDT|EST)\)$/);
    await expect.poll(async () => (await saved(page))?.settings.displayTz).toBe('America/New_York');
    await page.reload();
    await expect(page.getByTestId('display-timezone')).toHaveValue('America/New York');
    await expect(page.getByTestId('display-now')).toHaveText(/\((EDT|EST)\)$/);
    await expect(page.getByTestId('display-numbers')).toContainText('3 decimals');
  });
});

test.describe('E12 system: security', () => {
  const NEW_PASSWORD = 'a much longer password';

  async function fillPasswordForm(page: Page, current: string, next: string): Promise<void> {
    await page.getByLabel('Current password').fill(current);
    await page.getByLabel('New password', { exact: true }).fill(next);
    await page.getByLabel('Repeat the new password').fill(next);
    await page.getByTestId('password-submit').click();
  }

  test('the password change says what is wrong, then works, and the login of the preview shows the new one', async ({
    page,
  }) => {
    await openSystem(page, { tab: 'security' });
    await page.getByTestId('password-submit').click();
    await expect(page.getByText('Enter your current password')).toBeVisible();
    await fillPasswordForm(page, 'not the password', NEW_PASSWORD);
    await expect(page.getByTestId('password-result')).toHaveText(
      'The current password is not right.',
    );
    await fillPasswordForm(page, OWNER.password, NEW_PASSWORD);
    await expect(page.getByTestId('password-result')).toHaveText(
      'Password changed. Every other session was signed out.',
    );
    await expect(page.getByTestId(/^session-sess-/)).toHaveCount(1);

    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page.getByTestId('login-preview-hint')).toContainText(NEW_PASSWORD);
    await fillLogin(page, NEW_PASSWORD);
    await expect(page.getByRole('heading', { name: 'System', level: 1 })).toBeVisible();
  });

  test('2-step login: set up, eight recovery codes shown once, asked at the next login, turned off again', async ({
    page,
  }) => {
    await openSystem(page, { tab: 'security' });
    await expect(page.getByTestId('totp-state')).toHaveText('2-step login is off.');
    await page.getByTestId('totp-setup').click();
    const panel = page.getByTestId('totp-setup-panel');
    await expect(panel.getByTestId('totp-secret')).toHaveText(/^[A-Z2-7]{16,}$/);
    await panel.getByTestId('totp-code').fill('654321');
    await page.getByTestId('totp-enable').click();
    await expect(panel).toContainText('This code is not right.');
    await panel.getByTestId('totp-code').fill('123456');
    await page.getByTestId('totp-enable').click();

    const codes = page.getByTestId('totp-recovery-codes');
    await expect(codes.getByRole('listitem')).toHaveCount(8);
    await expect(codes).toContainText('They are shown only now.');
    await page.getByTestId('totp-codes-done').click();
    await expect(codes).toHaveCount(0);
    await expect(page.getByTestId('totp-state')).toHaveText('2-step login is on.');

    await page.getByRole('button', { name: 'Log out' }).click();
    await page.getByLabel(/^username/i).fill(OWNER.username);
    await page.getByLabel(/^password/i).fill(OWNER.password);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByTestId('login-error')).toBeVisible();
    await page.getByLabel(/authenticator code/i).fill('123456');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('heading', { name: 'System', level: 1 })).toBeVisible();

    // the login brings the owner back to the page that he left, on its first tab
    await page.getByRole('tab', { name: 'Security' }).click();
    await page.getByTestId('totp-disable-code').fill('123456');
    await page.getByTestId('totp-disable').click();
    await expect(page.getByTestId('totp-state')).toHaveText('2-step login is off.');
    await expect(page.getByTestId('totp-setup')).toBeVisible();
  });

  test('sessions: this one has no Revoke button; revoking asks first and ends only the chosen one', async ({
    page,
  }) => {
    await openSystem(page, { tab: 'security' });
    await expect(page.getByTestId(/^session-sess-/)).toHaveCount(3);
    await expect(page.getByTestId('session-sess-current')).toContainText('This device');
    await expect(page.getByTestId('session-sess-current').getByRole('button')).toHaveCount(0);

    await page.getByTestId('session-revoke-sess-phone').click();
    const dialog = page.getByRole('dialog', { name: 'Revoke this session?' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId(/^session-sess-/)).toHaveCount(3);

    await page.getByTestId('session-revoke-sess-phone').click();
    await page.getByTestId('session-revoke-confirm').click();
    await expect(page.getByTestId('session-sess-phone')).toHaveCount(0);
    await expect(page.getByTestId('session-sess-laptop')).toBeVisible();
    await expect(page.getByTestId('session-sess-current')).toBeVisible();
  });
});

test.describe('E13 system: storage', () => {
  test('shows the size, the budget, the tables biggest first, the retention rules and the last runs', async ({
    page,
  }) => {
    await openSystem(page, { tab: 'storage' });
    await expect(page.getByTestId('storage-db-size')).toHaveText('1.14 GB');
    await expect(page.getByTestId('storage-budget')).toContainText('11% of the budget');
    await expect(page.getByTestId('storage-budget-level')).toHaveText('Within the budget');
    await expect(page.getByTestId('storage-warning')).toHaveCount(0);
    await expect(
      page.getByRole('progressbar', { name: 'Database size: 11% of the budget' }),
    ).toBeVisible();

    const tables = page.getByTestId('storage-tables').getByTestId(/^storage-table-/);
    await expect(tables).toHaveCount(8);
    await expect(tables.first()).toHaveAttribute('data-testid', 'storage-table-ticks');
    await expect(tables.first()).toContainText('612 MB');
    await expect(tables.last()).toContainText('3.0 MB');

    const retention = page.getByTestId('storage-retention');
    await expect(retention.getByRole('row')).toHaveCount(15);
    await expect(retention).toContainText('Raw ticks (XAUUSD)');
    await expect(retention).toContainText('14 days; daily partitions are dropped');
    await expect(retention).toContainText('Signals, events, outcomes and reviews');
    await expect(retention).toContainText('Kept forever');

    await expect(page.getByTestId('storage-maintenance')).toContainText(
      /Last maintenance run: retention, finished .+ \(.+ ago\), 1,204,331 rows deleted\./,
    );
    await expect(page.getByTestId('storage-backup')).toContainText(/Last backup: .+ \(.+ ago\)\./);
  });

  test('the system-warning state: 82% of the budget, getting full, and what the job does about it', async ({
    page,
  }) => {
    await openSystem(page, { scenario: 'system-warning', tab: 'storage' });
    await expect(page.getByTestId('storage-db-size')).toHaveText('8.80 GB');
    await expect(page.getByTestId('storage-budget')).toContainText('82% of the budget');
    await expect(page.getByTestId('storage-budget-level')).toHaveText('Getting full');
    await expect(page.getByTestId('storage-warning')).toContainText(
      'Signals, events and outcomes are never deleted.',
    );
    await expect(page.getByTestId('storage-table-ticks')).toContainText('8.28 GB');
    await expect(page.getByTestId('storage-maintenance')).toContainText('0 rows deleted');
  });
});
