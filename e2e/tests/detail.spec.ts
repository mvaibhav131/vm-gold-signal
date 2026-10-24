import { expect, test, type Page } from '@playwright/test';

import { logIn } from './helpers';

// Scenarios E8 and E9 on the simulated history (05_UI_Spec section 9.4): the detail of a loss
// with its timeline and review, the review that turns final when the clock moves, and a snapshot
// that retention has removed. Every check reads the DOM; no image is taken.

const idOf = (seq: number) => `00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`;

const timeline = (page: Page) =>
  page
    .getByTestId('detail-timeline')
    .getByRole('listitem')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-testid')));

/** Opens a signal the way the owner does: from the list. */
async function openFromList(page: Page, seq: number): Promise<void> {
  await logIn(page);
  await page.goto(`/signals?sort=generatedAt&order=${seq <= 20 ? 'asc' : 'desc'}`);
  await page
    .getByTestId(`history-row-${String(seq)}`)
    .getByRole('link')
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/signals/${idOf(seq)}$`));
  await expect(page.getByTestId('detail-id')).toHaveText(`S-${String(seq).padStart(4, '0')}`);
}

/** The chart starts folded on a phone. */
async function openChart(page: Page): Promise<void> {
  const fold = page.getByRole('button', { name: 'Chart around the trade' });
  if (await fold.isVisible()) await fold.click();
}

test.describe('E8 the detail of a loss', () => {
  test('has the header, the levels and the result block of 05_UI_Spec section 5', async ({
    page,
  }) => {
    await openFromList(page, 40);
    await expect(page.getByRole('heading', { name: 'Signal detail', level: 1 })).toBeVisible();
    await expect(page.getByTestId('detail-side')).toHaveText('SELL');
    await expect(page.getByTestId('detail-strategy')).toHaveText('Liquidity Sweep Reversal v0.1.0');
    await expect(page.getByTestId('detail-strategy-status')).toHaveText('FORWARD-TEST');
    await expect(page.getByTestId('detail-mode')).toHaveText('SIMULATED');

    await expect(page.getByTestId('detail-entry')).toHaveText('4021.600');
    await expect(page.getByTestId('detail-stop')).toHaveText('4027.700');
    await expect(page.getByTestId('detail-tp1')).toHaveText('4015.500');
    await expect(page.getByTestId('detail-tp2')).toHaveText('4009.400');
    await expect(page.getByTestId('detail-risk')).toHaveText('6.100 USD');

    const result = page.getByTestId('detail-result');
    await expect(result.getByTestId('detail-result-badge')).toHaveText('Loss');
    await expect(result.getByTestId('detail-net-r')).toHaveText('-1.04R');
    await expect(result.getByTestId('detail-exit-price')).toHaveText('4027.700');
    await expect(result.getByTestId('detail-exit-reason')).toHaveText('Stop loss');
    await expect(result.getByTestId('detail-duration')).toHaveText('15 min');
    await expect(result.getByTestId('detail-tp1-reached')).toHaveText('No');
    await expect(result.getByTestId('detail-tp2-reached')).toHaveText('No');
  });

  test('lists the events in the order they happened', async ({ page }) => {
    await openFromList(page, 40);
    expect(await timeline(page)).toEqual([
      'timeline-CREATED',
      'timeline-ALERT_QUEUED',
      'timeline-SL_HIT',
      'timeline-AUTOPSY_PRELIMINARY',
      'timeline-AUTOPSY_FINAL',
    ]);
    const times = await page
      .getByTestId('detail-timeline')
      .locator('time')
      .evaluateAll((els) => els.map((el) => Date.parse(el.getAttribute('datetime') ?? '')));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  test('has the review: status, primary cause and category, weak groups and the counterfactual', async ({
    page,
  }) => {
    await openFromList(page, 40);
    const review = page.getByTestId('detail-autopsy');
    await expect(review.getByTestId('detail-autopsy-status')).toHaveText('FINAL');
    await expect(review.getByTestId('detail-autopsy-cause')).toHaveText('No follow-through');
    await expect(review.getByTestId('detail-autopsy-category')).toHaveText('Setup failure');
    await expect(review.getByTestId('detail-autopsy-weak')).toContainText(
      'Trigger and momentum: WEAK',
    );
    await expect(review.getByTestId('detail-autopsy-counterfactual')).toContainText(
      'Price did not reach TP1 in the hour after the close.',
    );
    await expect(review).toContainText(
      'Heuristic attribution; judge strategy by the statistics in Analytics.',
    );
  });

  test('shows why the signal was produced, one row per evidence group, and its evidence', async ({
    page,
  }) => {
    await openFromList(page, 40);
    const why = page.getByTestId('detail-why');
    for (const key of [
      'trend',
      'structure',
      'trigger',
      'volatility',
      'execution',
      'sessionMacro',
      'reward',
    ]) {
      await expect(why.getByTestId(`signal-why-group-${key}`)).toBeVisible();
    }
    await expect(why.getByTestId('signal-why-state-trend')).toHaveText('WEAK');
    await expect(page.getByTestId('detail-evidence')).toContainText('Insufficient evidence');
  });

  test('draws the chart around the trade and says the same in text, with no error in the console', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await openFromList(page, 40);
    await openChart(page);
    const chart = page.getByTestId('detail-chart');
    await expect(chart.locator('canvas').first()).toBeVisible();
    await expect(page.getByTestId('detail-chart-legend')).toContainText(
      'S-0040 SELL: entry 4021.600, stop 4027.700, TP1 4015.500, TP2 4009.400',
    );
    await expect(page.getByTestId('detail-chart-legend')).toContainText(
      'Exit: Stop at 4027.700 (Stop loss).',
    );
    await expect(page.getByTestId('detail-chart-legend')).toContainText(
      /12\d candles of 5 minutes/,
    );
    // The chart really drew something: at least one canvas holds more than one colour.
    const drawn = await chart.locator('canvas').evaluateAll((canvases) =>
      canvases.some((element) => {
        const canvas = element as HTMLCanvasElement;
        const context = canvas.getContext('2d');
        if (!context || canvas.width === 0 || canvas.height === 0) return false;
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        for (let i = 4; i < data.length; i += 4) {
          if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2])
            return true;
        }
        return false;
      }),
    );
    expect(drawn).toBe(true);
    expect(errors).toEqual([]);
  });

  test('keeps the raw snapshot closed until it is opened', async ({ page }) => {
    await openFromList(page, 40);
    const snapshot = page.getByTestId('detail-snapshot');
    await expect(snapshot.getByTestId('detail-snapshot-json')).toHaveCount(0);
    await snapshot.getByRole('button', { name: /Every feature at the moment/ }).click();
    await expect(snapshot.getByTestId('detail-snapshot-json')).toContainText('"rsi14"');
  });

  test('a win, a partial win, a cancelled and a data-invalid signal each tell their own story', async ({
    page,
  }) => {
    await logIn(page);
    await page.goto(`/signals/${idOf(41)}`);
    await expect(page.getByTestId('detail-result-badge')).toHaveText('Win');
    await expect(page.getByTestId('detail-net-r')).toHaveText('+1.47R');
    expect(await timeline(page)).toEqual([
      'timeline-CREATED',
      'timeline-ALERT_QUEUED',
      'timeline-TP1_HIT',
      'timeline-STOP_MOVED_TO_ENTRY',
      'timeline-TP2_HIT',
    ]);
    await expect(page.getByTestId('detail-autopsy-none')).toContainText(
      'A full win is not reviewed',
    );

    await page.goto(`/signals/${idOf(39)}`);
    await expect(page.getByTestId('detail-result-badge')).toHaveText('Partial win');
    await expect(page.getByTestId('detail-exit-reason')).toHaveText('Stopped at entry after TP1');
    await expect(page.getByTestId('detail-autopsy-cause')).toHaveText('Normal loss');

    await page.goto(`/signals/${idOf(11)}`);
    await expect(page.getByTestId('detail-result-badge')).toHaveText('Cancelled');
    await expect(page.getByTestId('detail-result-note')).toContainText(
      'not counted in the statistics',
    );
    await expect(page.getByTestId('detail-net-r')).toHaveCount(0);

    await page.goto(`/signals/${idOf(29)}`);
    await expect(page.getByTestId('detail-result-badge')).toHaveText('Data invalid');
    await expect(page.getByTestId('detail-result-note')).toContainText(
      'feed gap longer than 60 seconds',
    );
  });

  test('an open signal shows its working state and the review that will come', async ({ page }) => {
    await logIn(page, { scenario: 'tp1-hit' });
    await page.getByTestId('recent-row-42').getByRole('link', { name: 'S-0042' }).click();
    await expect(page.getByTestId('detail-result-badge')).toHaveText('Open (TP1 hit)');
    await expect(page.getByTestId('detail-current-stop')).toHaveText('4017.370');
    expect(await timeline(page)).toEqual([
      'timeline-CREATED',
      'timeline-ALERT_QUEUED',
      'timeline-TP1_HIT',
      'timeline-STOP_MOVED_TO_ENTRY',
    ]);
    await expect(page.getByTestId('detail-autopsy-none')).toHaveText(
      'The review runs when the signal closes.',
    );
  });

  test('a signal that does not exist says so and links back to the list', async ({ page }) => {
    await logIn(page);
    await page.goto(`/signals/${idOf(65535)}`);
    await expect(page.getByTestId('detail-not-found')).toContainText('Signal not found');
    await expect(page.getByRole('heading', { name: 'Signal detail', level: 1 })).toBeVisible();
    await page.getByRole('link', { name: 'Back to signals' }).click();
    await expect(page.getByRole('heading', { name: 'Signals', level: 1 })).toBeVisible();
  });
});

test.describe('E8 the review turns final by itself', () => {
  test('preliminary at the close, final 60 minutes later, once the clock has moved', async ({
    page,
  }) => {
    await page.clock.install();
    await logIn(page, { scenario: 'review-pending' });
    // the loss that closed 35 minutes ago is in the recent signals of the dashboard
    await page.getByTestId('recent-row-42').getByRole('link', { name: 'S-0042' }).click();
    const review = page.getByTestId('detail-autopsy');
    await expect(review.getByTestId('detail-autopsy-status')).toHaveText('PRELIMINARY');
    await expect(review.getByTestId('detail-autopsy-pending')).toContainText(
      'final review follows 60 minutes later',
    );
    await expect(review.getByTestId('detail-autopsy-counterfactual')).toContainText(
      'Not known yet',
    );
    expect(await timeline(page)).toEqual([
      'timeline-CREATED',
      'timeline-ALERT_QUEUED',
      'timeline-SL_HIT',
      'timeline-AUTOPSY_PRELIMINARY',
    ]);

    // the preliminary review is reloaded every 30 s: after 27 minutes the hour has passed
    await page.clock.fastForward('27:00');
    await expect(review.getByTestId('detail-autopsy-status')).toHaveText('FINAL');
    await expect(review.getByTestId('detail-autopsy-pending')).toHaveCount(0);
    await expect(review.getByTestId('detail-autopsy-counterfactual')).toContainText(
      'did not reach TP1',
    );
    expect((await timeline(page)).at(-1)).toBe('timeline-AUTOPSY_FINAL');
  });
});

test.describe('E9 pruned snapshot', () => {
  test('says that retention removed it, and the summary of the signal stays visible', async ({
    page,
  }) => {
    await openFromList(page, 1);
    const snapshot = page.getByTestId('detail-snapshot');
    await expect(snapshot.getByTestId('detail-snapshot-pruned')).toHaveText(
      'Snapshot removed by retention; summary above is kept.',
    );
    await expect(snapshot.getByRole('button')).toHaveCount(0);
    // everything else is still there
    await expect(page.getByTestId('detail-result-badge')).toHaveText('Loss');
    await expect(page.getByTestId('detail-autopsy-cause')).toBeVisible();
    await expect(page.getByTestId('detail-why')).toBeVisible();
    await expect(page.getByTestId('detail-entry')).toHaveText(/^\d{4}\.\d{3}$/);
  });

  test('a signal with its snapshot has no such message', async ({ page }) => {
    await openFromList(page, 2);
    await expect(page.getByTestId('detail-snapshot-pruned')).toHaveCount(0);
    await expect(page.getByTestId('detail-snapshot').getByRole('button')).toHaveCount(1);
  });
});
